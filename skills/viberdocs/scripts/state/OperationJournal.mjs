import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AuthError } from '../auth/AuthClient.mjs';
import { isDraftResult } from '../services/templateShape.mjs';

const TEMPLATE_CREATE = 'template_create';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A new document names its workspace. An update of an existing document names none (null), because the
// document decides where it lives; null is accepted only together with the document's id.
function validWorkspace(options) {
  return options.workspace === null ? UUID.test(options.doc || '') : UUID.test(options.workspace || '');
}

export class OperationJournal {
  constructor(store) { this.store = store; }

  async init() { await this.store.directory(path.join(this.store.state, 'operations')); }

  name(id) {
    if (!UUID.test(id)) throw new AuthError('invalid_usage');
    return `operations/${id}.json`;
  }

  async create(grantId, hash, options) {
    await this.init();
    const operation = {
      id: randomUUID(), grant_id: grantId, hash, options,
      create_key: randomUUID(), allocation_key: randomUUID(), stage: 'intent',
    };
    await this.save(operation);
    return operation;
  }

  async load(id) {
    await this.init();
    const operation = await this.store.read(this.name(id));
    // A record with a `kind` belongs to another operation type (a template create) and is not a document upload.
    if (!operation || operation.kind !== undefined || operation.id !== id || !UUID.test(operation.grant_id || '') ||
        !UUID.test(operation.create_key || '') || !UUID.test(operation.allocation_key || '') ||
        !/^[a-f0-9]{64}$/.test(operation.hash || '') ||
        (operation.doc_id && !UUID.test(operation.doc_id)) ||
        (operation.version !== undefined && (!Number.isSafeInteger(operation.version) || operation.version < 1)) ||
        !operation.options || !validWorkspace(operation.options) ||
        !Number.isSafeInteger(operation.options.base_version) || operation.options.base_version < 0 ||
        !Number.isSafeInteger(operation.options.size) || operation.options.size < 1 || operation.options.size > 10485760 ||
        typeof operation.options.filename !== 'string' || operation.options.filename.length > 255 ||
        typeof operation.options.name !== 'string' || operation.options.name.length > 255 ||
        (operation.options.doc && !UUID.test(operation.options.doc)) ||
        (operation.options.folder && !UUID.test(operation.options.folder)) ||
        !['intent', 'doc_created', 'allocated', 'bytes_stored', 'completed'].includes(operation.stage)) {
      throw new AuthError('invalid_operation');
    }
    return operation;
  }

  // A template create: one POST with one idempotency key. `hash` is the SHA-256 of the exact request body, whose
  // target workspace (or null, a private template) is journaled in `options.workspace`, so a resume rebuilds the
  // same bytes from the file and the journal and finds out if either changed. `stage` is `intent` until the
  // server's answer is checked, then `completed` with that answer in `result`.
  async createTemplate(grantId, hash, { workspace }) {
    await this.init();
    const operation = {
      id: randomUUID(), kind: TEMPLATE_CREATE, grant_id: grantId, hash, options: { workspace: workspace ?? null },
      create_key: randomUUID(), stage: 'intent',
    };
    await this.save(operation);
    return operation;
  }

  async loadTemplate(id) {
    await this.init();
    const operation = await this.store.read(this.name(id));
    if (!operation || operation.kind !== TEMPLATE_CREATE || operation.id !== id || !UUID.test(operation.grant_id || '') ||
        !UUID.test(operation.create_key || '') || !/^[a-f0-9]{64}$/.test(operation.hash || '') ||
        !operation.options || typeof operation.options !== 'object' ||
        !(operation.options.workspace === null || UUID.test(operation.options.workspace || '')) ||
        !['intent', 'completed'].includes(operation.stage) ||
        (operation.stage === 'completed') !== (operation.result !== undefined) ||
        (operation.result !== undefined && !isDraftResult(operation.result))) {
      throw new AuthError('invalid_operation');
    }
    return operation;
  }

  async save(operation) { await this.store.write(this.name(operation.id), operation); }
}
