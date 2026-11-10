import { createHash } from 'node:crypto';
import { AuthError } from '../auth/AuthClient.mjs';
import { loadReadyAuth } from '../auth/readyAuth.mjs';
import { sendRaw } from './apiRequest.mjs';
import { resolveOutputTarget, writeFileAtomically } from './outputFile.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
// A version made of files is up to the whole-doc cap (25 MiB), not the single-file one.
const MAX_FILES_VERSION_BYTES = 25 * 1024 * 1024;
const MAX_LIST_BYTES = 262144;
const STATUSES = ['pending', 'active', 'superseded'];
const LAYOUTS = ['single', 'files'];
const SHA256 = /^[0-9a-f]{64}$/;

// Validates the artifacts list before anything in it is used. A `pending` version has no stored bytes yet, so
// its size may be null; every other entry, and any entry we download, needs an integer size. `layout` is absent on a
// server that predates multi-file docs, and means a single HTML file then; a `files` version's size is the total of
// its files, so it may be larger than one file can be.
export function parseArtifactList(data) {
  if (!Array.isArray(data)) throw new AuthError('invalid_response');
  const entries = data.map(entry => {
    const layout = entry?.layout === undefined ? 'single' : entry.layout;
    const cap = layout === 'files' ? MAX_FILES_VERSION_BYTES : MAX_BYTES;
    if (!entry || !Number.isSafeInteger(entry.version) || entry.version < 1 || !STATUSES.includes(entry.status) ||
        !LAYOUTS.includes(layout) ||
        typeof entry.content_hash !== 'string' || !SHA256.test(entry.content_hash) ||
        !(entry.size === null && entry.status === 'pending' ||
          Number.isSafeInteger(entry.size) && entry.size >= 1 && entry.size <= cap)) {
      throw new AuthError('invalid_response');
    }
    return { version: entry.version, status: entry.status, content_hash: entry.content_hash, size: entry.size, layout };
  });
  const active = entries.filter(entry => entry.status === 'active');
  if (active.length > 1 || new Set(entries.map(entry => entry.version)).size !== entries.length) {
    throw new AuthError('invalid_response');
  }
  return { entries, activeVersion: active.length ? active[0].version : 0 };
}

// Finds the version a command is about in the doc's artifacts list: `requested`, or the active one. `session` is
// `{fetch, authClient, store, auth}`, as for `requestJson`. A version that is not listed is `http_404`.
export async function resolveVersion(session, doc, requested) {
  const response = await sendRaw(session, `/api/docs/${doc}/artifacts`);
  const chunks = [];
  let size = 0;
  try {
    if (response.body) for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_LIST_BYTES) throw new Error();
      chunks.push(chunk);
    }
  } catch {
    throw new AuthError('invalid_response');
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AuthError('invalid_response'); }
  const { entries, activeVersion } = parseArtifactList(data);
  const wanted = requested === undefined ? activeVersion : requested;
  if (requested === undefined && !activeVersion) throw new AuthError('no_active_version');
  const entry = entries.find(candidate => candidate.version === wanted);
  if (!entry) throw new AuthError('http_404');
  if (entry.size === null) throw new AuthError('invalid_response');
  return { entry, activeVersion };
}

// Streams a response body into memory and returns the bytes only if their size and SHA-256 are exactly `size` and
// `sha256` (the listing's). A longer body stops at the first byte over; a declared Content-Length that disagrees is
// refused before any byte is read. All of them are `integrity_failed`.
export async function readVerifiedBody(response, { size, sha256 }) {
  const declared = response.headers.get('content-length');
  if (!response.headers.get('content-encoding') && declared !== null && Number(declared) !== size) {
    await response.body?.cancel().catch(() => {});
    throw new AuthError('integrity_failed');
  }
  const hash = createHash('sha256');
  const chunks = [];
  let received = 0;
  try {
    if (response.body) for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > size) throw new AuthError('integrity_failed');
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof AuthError) { await response.body?.cancel().catch(() => {}); throw error; }
    throw new AuthError('network_error', true);
  }
  if (received !== size || hash.digest('hex') !== sha256) throw new AuthError('integrity_failed');
  return Buffer.concat(chunks);
}

export class DocumentDownloader {
  constructor(store, authClient, fetcher = fetch) {
    this.store = store;
    this.authClient = authClient;
    this.fetch = fetcher;
  }

  async download({ doc, version, output, root }) {
    doc = String(doc).toLowerCase();
    const context = { doc_id: doc };
    return this.store.withLock(async () => {
      try {
        const target = await resolveOutputTarget(output, root, '.html');
        this.auth = await loadReadyAuth(this.store, this.authClient);
        const { entry, activeVersion } = await this.resolveVersion(doc, version);
        context.version = entry.version;
        // A version made of files has no single document to save: `/content` would return only its `index.html`,
        // and the size and hash listed for it are the whole version's, so the check below could not pass anyway.
        if (entry.layout === 'files') throw new AuthError('multi_file_doc');
        const bytes = await this.fetchContent(doc, entry);
        await writeFileAtomically(target, bytes);
        return {
          ok: true, outcome: 'downloaded', doc_id: doc, version: entry.version, active_version: activeVersion,
          path: target.relative, size_bytes: bytes.length, content_hash: entry.content_hash,
        };
      } catch (error) {
        if (error instanceof AuthError) Object.assign(error, context);
        throw error;
      }
    });
  }

  // GET with the shared request policy (`sendRaw`). Returns the successful Response.
  send(route) {
    return sendRaw(this, route);
  }

  resolveVersion(doc, requested) {
    return resolveVersion(this, doc, requested);
  }

  // Streams one version into memory and returns the bytes only if their size and SHA-256 match the listing.
  async fetchContent(doc, entry) {
    const response = await this.send(`/api/docs/${doc}/artifacts/${entry.version}/content`);
    return readVerifiedBody(response, { size: entry.size, sha256: entry.content_hash });
  }
}
