import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { AuthError } from '../auth/AuthClient.mjs';
import { hasDotSegment, inside } from './outputFile.mjs';
import { loadReadyAuth } from '../auth/readyAuth.mjs';
import { OperationJournal } from '../state/OperationJournal.mjs';
import { requestJson, siteUrl } from './apiRequest.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 10 * 1024 * 1024;
const PASSTHROUGH_CONFLICTS = ['CLI_BYTES_ALREADY_STORED', 'CLI_OPERATION_COMPLETED'];

// The file a command may read: a regular file inside the project root (`root`), not under a dot-folder such as
// `.viberdocs/` and not a symlink, so a pre-approved upload cannot read credentials, keys or other files. Returns the
// real path to open. A missing file is `invalid_file`; anything outside these rules is `invalid_input`.
async function confineInput(file, root) {
  if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0')) throw new AuthError('invalid_input');
  const resolved = path.resolve(process.cwd(), file);
  let realRoot;
  let parent;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    throw new AuthError('invalid_file');
  }
  try {
    parent = await fs.realpath(path.dirname(resolved));
  } catch {
    // A folder that does not exist: a missing file if the path points into the project, else outside it.
    throw new AuthError(inside(resolved, realRoot) ? 'invalid_file' : 'invalid_input');
  }
  const real = path.join(parent, path.basename(resolved));
  if (!path.basename(resolved) || !inside(parent, realRoot) || hasDotSegment(path.relative(realRoot, real))) {
    throw new AuthError('invalid_input');
  }
  return real;
}

export async function snapshot(file, root) {
  let fd;
  try {
    const real = await confineInput(file, root);
    // O_NOFOLLOW refuses a symlink as the last component; O_NONBLOCK keeps a FIFO from hanging the open.
    try {
      fd = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      throw new AuthError(error.code === 'ELOOP' ? 'invalid_input' : 'invalid_file');
    }
    const before = await fd.stat();
    if (!before.isFile()) throw new AuthError('invalid_input');
    if (before.size < 1 || before.size > MAX_BYTES) throw new AuthError('invalid_file');
    const data = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await fd.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await fd.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) throw new AuthError('file_changed');
    const bytes = data.subarray(0, offset);
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('invalid_file');
  } finally {
    if (fd) await fd.close();
  }
}

function safeResult(details, operation, origin) {
  const url = siteUrl(origin, details.url);
  if (!url || details.doc_id !== operation.doc_id || details.version !== operation.version ||
      details.content_hash !== operation.hash || !['active', 'superseded'].includes(details.artifact_status) ||
      !Number.isInteger(details.active_version) || details.active_version < 1 ||
      (details.artifact_status === 'active' && details.active_version !== operation.version) ||
      (details.artifact_status === 'superseded' && details.active_version === operation.version)) {
    throw new AuthError('invalid_response');
  }
  const warnings = details.blocked_resources;
  if (warnings !== null && (!Array.isArray(warnings) || warnings.some(w =>
    !w || typeof w.kind !== 'string' || w.kind.length > 32 || typeof w.url !== 'string' ||
    w.url.length > 201 || !Number.isInteger(w.line) || w.line < 1))) throw new AuthError('invalid_response');
  const safeWarnings = warnings?.slice(0, 100).map(({ kind, url, line }) => ({
    kind: ['script', 'stylesheet', 'font', 'image', 'media', 'frame'].includes(kind) ? kind : 'other',
    url: `resource:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
    line,
  }));
  return {
    ok: true, outcome: details.artifact_status === 'superseded' ? 'published_superseded' : 'published',
    doc_id: operation.doc_id, version: operation.version, active_version: details.active_version,
    url, blocked_resources: warnings === null ? null : safeWarnings,
    warnings_truncated: warnings !== null && warnings.length > 100, operation_id: operation.id,
  };
}

export class DocumentUploader {
  constructor(store, authClient, fetcher = fetch) {
    this.store = store;
    this.authClient = authClient;
    this.fetch = fetcher;
    this.journal = new OperationJournal(store);
  }

  // The shared request policy (`requestJson`), plus the two 409 codes the publish routes use for "already done".
  // `anonymous: true` is for the bytes POST, whose upload ticket carries its own authority.
  request(route, options) {
    return requestJson(this, route, { passthroughConflicts: PASSTHROUGH_CONFLICTS, ...options });
  }

  async upload(file, options) {
    const { bytes, hash } = await snapshot(file, this.store.root);
    return this.store.withLock(async () => {
      this.auth = await loadReadyAuth(this.store, this.authClient);
      // The server enforces the same, but a read-only login fails here, before any request is made.
      if (this.auth.scope !== 'docs:publish') throw new AuthError('read_only_login');
      let operation;
      if (options.resume) {
        operation = await this.journal.load(options.resume);
        if (operation.grant_id !== this.auth.grant_id || operation.hash !== hash) throw new AuthError('operation_mismatch');
      } else {
        const everywhere = this.auth.workspace_reach === 'all';
        if (!everywhere && options.workspace && options.workspace !== this.auth.workspace_id) throw new AuthError('workspace_mismatch');
        // A new document under an all-workspaces login goes where --workspace says, never to a default; an
        // update follows its document and names no workspace.
        if (everywhere && !options.doc && !options.workspace) throw new AuthError('workspace_required');
        const params = {
          workspace: everywhere ? (options.doc ? null : options.workspace) : this.auth.workspace_id, folder: options.folder || null,
          name: options.name || path.basename(file), doc: options.doc || null,
          base_version: options.doc ? options.baseVersion : 0, filename: path.basename(file), size: bytes.length,
        };
        operation = await this.journal.create(this.auth.grant_id, hash, params);
      }
      try { return await this.run(operation, bytes); }
      catch (error) {
        error.operation_id = operation.id;
        if (UUID.test(operation.doc_id || '')) error.doc_id = operation.doc_id;
        if (Number.isSafeInteger(operation.version) && operation.version > 0) error.version = operation.version;
        throw error;
      }
    });
  }

  async run(operation, bytes) {
    const json = { 'Content-Type': 'application/json' };
    if (!operation.doc_id) {
      if (operation.options.doc) operation.doc_id = operation.options.doc;
      else {
        const result = await this.request('/api/docs', {
          method: 'POST', retry: true,
          headers: { ...json, 'Idempotency-Key': operation.create_key, 'X-ViberDocs-Content-SHA256': operation.hash },
          body: JSON.stringify({ space_id: operation.options.workspace, name: operation.options.name, folder_id: operation.options.folder }),
        });
        if (!UUID.test(result.data.id || '') || result.data.space_id !== operation.options.workspace) throw new AuthError('invalid_response');
        operation.doc_id = result.data.id;
      }
      operation.stage = 'doc_created';
      await this.journal.save(operation);
    }
    const route = `/api/docs/${operation.doc_id}/artifacts`;
    const allocation = await this.request(route, {
      method: 'POST', retry: true, headers: { ...json, 'Idempotency-Key': operation.allocation_key },
      body: JSON.stringify({ content_hash: operation.hash, size: operation.options.size,
        filename: operation.options.filename, base_version: operation.options.base_version }),
    });
    const version = allocation.data?.version ?? allocation.details?.version;
    if (!Number.isInteger(version) || version < 1 || (operation.version && operation.version !== version)) throw new AuthError('invalid_response');
    operation.version = version;
    if (allocation.code === 'CLI_OPERATION_COMPLETED') {
      const result = safeResult(allocation.details, operation, this.authClient.origin);
      operation.stage = 'completed'; await this.journal.save(operation);
      return result;
    }
    if (allocation.code === 'CLI_BYTES_ALREADY_STORED') {
      if (allocation.details?.doc_id !== operation.doc_id || allocation.details?.content_hash !== operation.hash || allocation.details?.artifact_status !== 'pending') throw new AuthError('invalid_response');
      operation.stage = 'bytes_stored';
    } else {
      const ticket = allocation.data;
      let url;
      try { url = new URL(ticket.upload_url); } catch { throw new AuthError('invalid_response'); }
      if (url.origin !== this.authClient.origin || url.username || url.password || url.search || url.hash ||
          !/^\/api\/uploads\/[A-Za-z0-9_-]+$/.test(url.pathname) || ticket.method !== 'POST' ||
          !Number.isInteger(ticket.max_size) || ticket.max_size < bytes.length) throw new AuthError('invalid_response');
      operation.stage = 'allocated'; await this.journal.save(operation);
      const uploaded = await this.request(url.pathname, { method: 'POST', anonymous: true, body: bytes, headers: { 'Content-Type': 'text/html' } });
      if (uploaded.data.version !== version || uploaded.data.content_hash !== operation.hash || uploaded.data.size !== bytes.length) throw new AuthError('invalid_response');
      operation.stage = 'bytes_stored';
    }
    await this.journal.save(operation);
    const activated = await this.request(`${route}/${version}/activate`, {
      method: 'POST', headers: json, body: JSON.stringify({ expected_active_version: operation.options.base_version }),
    });
    const details = activated.code === 'CLI_OPERATION_COMPLETED' ? activated.details : {
      ...activated.data, version, content_hash: operation.hash, artifact_status: 'active',
      blocked_resources: activated.data.blocked_resources ?? null,
    };
    const result = safeResult(details, operation, this.authClient.origin);
    operation.stage = 'completed'; await this.journal.save(operation);
    return result;
  }
}
