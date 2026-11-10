import { createHash } from 'node:crypto';
import { AuthError } from '../auth/AuthClient.mjs';
import { loadReadyAuth } from '../auth/readyAuth.mjs';
import { OperationJournal } from '../state/OperationJournal.mjs';
import { requestJson } from './apiRequest.mjs';
import { snapshot } from './DocumentUploader.mjs';
import { resolveOutputTarget, writeFileAtomically } from './outputFile.mjs';
import { TEMPLATE_HANDLE, isDraftResult, sanitizeProblems } from './templateShape.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
// A create or update answer echoes the whole package, so it may be far larger than a document answer.
const TEMPLATE_RESPONSE_MAX = 16 * 1024 * 1024;
const SCHEMA_RESPONSE_MAX = 1024 * 1024;
const SCHEMA_ROUTE = '/api/template-schema.json';
const FILE_KEYS = ['name', 'description', 'category', 'tags', 'package'];
const REQUIRED_ON_CREATE = ['name', 'description', 'category', 'package'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.length > 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Reads a template file: a stable read of at most 10 MiB, strict UTF-8 (bad bytes are an error, never replaced; a
// leading byte-order mark is kept so it fails the JSON parse), then one JSON object with only the keys the server
// accepts, each of the right type. `create` needs name, description, category and package; `update` needs at
// least one key. The workspace and the revision come from flags, never from the file. The server stays the
// authority on everything inside `package`.
export async function readTemplateFile(file, mode, root) {
  const { bytes } = await snapshot(file, root);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new AuthError('invalid_template_file');
  }
  if (!isObject(parsed)) throw new AuthError('invalid_template_file');
  const keys = Object.keys(parsed);
  if (keys.some(key => !FILE_KEYS.includes(key)) || (mode === 'create' ? !REQUIRED_ON_CREATE.every(key => key in parsed) : !keys.length)) {
    throw new AuthError('invalid_template_file');
  }
  for (const key of ['name', 'description', 'category']) {
    if (key in parsed && !nonEmptyString(parsed[key])) throw new AuthError('invalid_template_file');
  }
  if ('package' in parsed && !isObject(parsed.package)) throw new AuthError('invalid_template_file');
  if ('tags' in parsed && !(Array.isArray(parsed.tags) && parsed.tags.every(tag => typeof tag === 'string'))) {
    throw new AuthError('invalid_template_file');
  }
  return parsed;
}

// The request body as bytes, refusing one the server would refuse for size.
function encodeBody(body) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  if (bytes.length > MAX_BODY_BYTES) throw new AuthError('invalid_file');
  return bytes;
}

// Puts the server's own words on a failed template request, as the printer reads them: its code for a rejection
// (422) or a conflict (409) and, for a rejection, the bounded list of what was wrong.
function describeFailure(error) {
  if (error.code === 'http_422') {
    error.server_code = error.server?.code;
    error.problems = sanitizeProblems(error.server);
  } else if (error.code === 'http_409') {
    error.server_code = error.server?.code;
  }
}

export class TemplateClient {
  constructor(store, authClient, fetcher = fetch) {
    this.store = store;
    this.authClient = authClient;
    this.fetch = fetcher;
    this.journal = new OperationJournal(store);
  }

  // The login this request will use, refreshed if it is about to expire, and checked to be allowed to write.
  // The server enforces the same, but a read-only login fails here, before any request is made.
  async writableLogin() {
    this.auth = await loadReadyAuth(this.store, this.authClient);
    if (this.auth.scope !== 'docs:publish') throw new AuthError('read_only_login');
  }

  // Creates a private template draft, or one shared into `workspace`. The request is journaled with its
  // idempotency key before it is sent; if the answer is lost, `resume` sends the same key and bytes, and the
  // server answers with the template it already made.
  async create(file, { workspace, resume } = {}) {
    if ((workspace !== undefined && !UUID.test(workspace)) || (resume !== undefined && !UUID.test(resume)) ||
        (workspace !== undefined && resume !== undefined)) throw new AuthError('invalid_usage');
    const fields = await readTemplateFile(file, 'create', this.store.root);
    return this.store.withLock(async () => {
      await this.writableLogin();
      let operation;
      if (resume !== undefined) {
        operation = await this.journal.loadTemplate(resume);
        const body = encodeBody(this.createBody(fields, operation.options.workspace));
        if (operation.grant_id !== this.auth.grant_id || operation.hash !== sha256(body)) throw new AuthError('operation_mismatch');
        if (operation.stage === 'completed') return this.createResult(operation);
        return this.sendCreate(operation, body);
      }
      if (this.auth.workspace_reach === 'one' && workspace !== undefined && workspace !== this.auth.workspace_id) {
        throw new AuthError('workspace_mismatch');
      }
      const body = encodeBody(this.createBody(fields, workspace ?? null));
      operation = await this.journal.createTemplate(this.auth.grant_id, sha256(body), { workspace: workspace ?? null });
      return this.sendCreate(operation, body);
    });
  }

  // The file's keys in the file's order, then the target. No target means a private template.
  createBody(fields, workspace) {
    return workspace === null ? fields : { ...fields, target_workspace_id: workspace };
  }

  createResult(operation) {
    return {
      ok: true, outcome: 'created', handle: operation.result.handle, draft_revision: operation.result.draft_revision,
      draft_status: operation.result.draft_status, workspace_id: operation.options.workspace, operation_id: operation.id,
    };
  }

  async sendCreate(operation, body) {
    try {
      const { data } = await requestJson(this, '/api/templates', {
        method: 'POST', retry: true, maxBytes: TEMPLATE_RESPONSE_MAX, body,
        headers: { ...JSON_HEADERS, 'Idempotency-Key': operation.create_key },
      });
      if (!isDraftResult(data)) throw new AuthError('invalid_response');
      operation.stage = 'completed';
      operation.result = { handle: data.handle, draft_revision: data.draft_revision, draft_status: data.draft_status };
      await this.journal.save(operation);
      return this.createResult(operation);
    } catch (error) {
      if (error instanceof AuthError) {
        describeFailure(error);
        // Only a failure that sending the same create again can fix points at the saved operation.
        if (error.retryable) error.operation_id = operation.id;
      }
      throw error;
    }
  }

  // Saves changes to a template draft the caller owns. `draftRevision` is the revision the caller last read; the
  // server refuses the update if the draft has moved on. Never retried on its own: after a lost answer the caller
  // reads the template to see whether the update landed.
  async update(file, { handle, draftRevision } = {}) {
    if (typeof handle !== 'string' || !TEMPLATE_HANDLE.test(handle) || !Number.isSafeInteger(draftRevision) || draftRevision < 1) {
      throw new AuthError('invalid_usage');
    }
    const fields = await readTemplateFile(file, 'update', this.store.root);
    const body = encodeBody({ ...fields, expected_draft_revision: draftRevision });
    return this.store.withLock(async () => {
      try {
        await this.writableLogin();
        const { data } = await requestJson(this, `/api/templates/${handle}`, {
          method: 'PATCH', retry: false, maxBytes: TEMPLATE_RESPONSE_MAX, body, headers: JSON_HEADERS,
        });
        if (!isDraftResult(data) || data.handle !== handle || (data.draft_revision !== draftRevision && data.draft_revision !== draftRevision + 1)) {
          throw new AuthError('invalid_response');
        }
        return {
          ok: true, outcome: data.draft_revision === draftRevision ? 'unchanged' : 'updated', handle: data.handle,
          draft_revision: data.draft_revision, draft_status: data.draft_status,
        };
      } catch (error) {
        if (error instanceof AuthError) {
          describeFailure(error);
          error.handle = handle;
        }
        throw error;
      }
    });
  }

  // Saves the public template schema to `output`. The schema is public, so no login is read and no credential is
  // sent. The exact bytes served are what is written, after a check that they are a JSON object with content.
  async schema({ output, root }) {
    const target = await resolveOutputTarget(output, root, '.json');
    const { data, raw } = await requestJson(this, SCHEMA_ROUTE, {
      anonymous: true, retry: true, maxBytes: SCHEMA_RESPONSE_MAX,
    });
    // An empty body parses to `{}`, which must not become an empty file.
    if (!isObject(data) || !Object.keys(data).length) throw new AuthError('invalid_response');
    await writeFileAtomically(target, raw);
    return { ok: true, outcome: 'downloaded', path: target.relative, size_bytes: raw.length, content_hash: sha256(raw) };
  }
}
