import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AuthError } from '../auth/AuthClient.mjs';
import { loadReadyAuth } from '../auth/readyAuth.mjs';
import { previewUrl } from '../auth/browser.mjs';
import { selfCommand, shellWord } from '../plugin.mjs';
import { requestJson, sendRaw, siteUrl } from './apiRequest.mjs';
import { readVerifiedBody, resolveVersion } from './DocumentDownloader.mjs';
import { writeFileAtomically } from './outputFile.mjs';
import {
  LIMITS, caseConflicts, cleanConflict, cleanCounts, cleanFindings, confineFolder, fileMap, pathProblem, prepareTarget,
  readRegularFile, readState, sameFiles, scanFolder, sha256, writeState,
} from './docFiles.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
// A draft or a file list names up to 500 files: far more than the default 256 KiB response cap allows.
const LIST_RESPONSE_MAX = 4 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Runs `worker` on every item, `limit` at a time. The first failure stops new items from starting and is thrown once the
// ones already running have finished.
async function inPool(items, limit, worker) {
  let next = 0;
  let failure;
  const run = async () => {
    while (failure === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try { await worker(items[index]); } catch (error) { failure = error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (failure !== undefined) throw failure;
}

// The commands that work on a folder of doc files: `pull` writes a version into a new folder, `check` and `preview`
// upload the folder to a draft and ask the server about it, `push` publishes it. The server is the authority on every
// rule (paths, types, links, limits): the folder is checked locally only for what would fail before a request is worth
// making. `.viberdocs.json` in the folder says which doc it belongs to and which version it is in step with.
export class DocFolder {
  // `opener(url, {noBrowser})` opens a preview link and returns the outcome (`opened`, `failed`, `unavailable`,
  // `disabled`); it must never throw. Tests pass their own.
  constructor(store, authClient, fetcher = fetch, { opener = async () => 'not_attempted' } = {}) {
    this.store = store;
    this.authClient = authClient;
    this.fetch = fetcher;
    this.opener = opener;
  }

  // The login this command uses, refreshed if it is about to expire. Drafts are writes, so a read-only login is refused
  // here, before any request; `pull` only reads and passes `write: false`.
  async login({ write }) {
    this.auth = await loadReadyAuth(this.store, this.authClient);
    if (write && this.auth.scope !== 'docs:publish') throw new AuthError('read_only_login');
  }

  // ---- pull ------------------------------------------------------------------------------------------------------

  // Writes one version of a doc (the live one unless `version`) into a new or empty folder, with `.viberdocs.json`
  // beside the files. Each file is read from the server as a stream and kept only if its size and SHA-256 are the ones
  // the file list gave; on any failure the folder is emptied again, never left half written.
  async pull({ doc, dir, version }) {
    doc = String(doc).toLowerCase();
    const context = { doc_id: doc };
    return this.store.withLock(async () => {
      let target;
      try {
        target = await prepareTarget(dir, this.store.root);
        await this.login({ write: false });
        const { entry, activeVersion } = await resolveVersion(this, doc, version);
        context.version = entry.version;
        const files = await this.listVersionFiles(doc, entry.version);
        const written = await this.writeFiles(doc, entry.version, files, target.directory);
        await writeState(target.directory, { doc_id: doc, base_version: entry.version, files: fileMap(files) });
        return {
          ok: true, outcome: 'pulled', doc_id: doc, version: entry.version, active_version: activeVersion,
          dir: target.relative, files: files.length, size_bytes: written,
        };
      } catch (error) {
        if (target) await this.emptyFolder(target);
        if (error instanceof AuthError) Object.assign(error, context);
        throw error;
      }
    });
  }

  async listVersionFiles(doc, version) {
    const { data } = await requestJson(this, `/api/docs/${doc}/versions/${version}/files`, { retry: true, maxBytes: LIST_RESPONSE_MAX });
    if (!isObject(data) || !Array.isArray(data.files) || data.files.length > LIMITS.files) throw new AuthError('invalid_response');
    const files = data.files.map(file => {
      if (!isObject(file) || pathProblem(file.path) !== null || !Number.isSafeInteger(file.size) || file.size < 0 ||
          file.size > LIMITS.fileBytes || !SHA256.test(file.sha256 || '')) throw new AuthError('invalid_response');
      return { path: file.path, size: file.size, sha256: file.sha256 };
    });
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (new Set(files.map(file => file.path)).size !== files.length || caseConflicts(files.map(file => file.path)).length ||
        total > LIMITS.versionBytes) throw new AuthError('invalid_response');
    return files;
  }

  async writeFiles(doc, version, files, directory) {
    let bytes = 0;
    for (const file of files) {
      const route = `/api/docs/${doc}/versions/${version}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      const content = await readVerifiedBody(await sendRaw(this, route), file);
      // The path passed every rule (segments of plain characters, no `..`), so it stays inside `directory`.
      const destination = path.join(directory, ...file.path.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFileAtomically({ parent: path.dirname(destination), file: destination }, content);
      bytes += content.length;
    }
    return bytes;
  }

  // Undoes a failed pull: removes what it wrote, and the folder too if the pull made it.
  async emptyFolder({ directory, created }) {
    try {
      if (created) { await fs.rm(directory, { recursive: true, force: true }); return; }
      for (const name of await fs.readdir(directory)) await fs.rm(path.join(directory, name), { recursive: true, force: true });
    } catch {
      // Best effort: cleaning up must not replace the error that got us here.
    }
  }

  // ---- check, preview, push --------------------------------------------------------------------------------------

  // Uploads the folder to a draft and asks the server what publishing it would find. Errors block, so any error finding
  // is `checks_failed`; warnings and info are returned.
  async check(folder, options = {}) {
    return this.withDraft(await this.scan(folder), options, async ({ draft, state }) => {
      const { data } = await requestJson(this, `/api/drafts/${draft}/check`, { method: 'POST', retry: true, maxBytes: LIST_RESPONSE_MAX });
      if (!isObject(data) || !Number.isSafeInteger(data.error_count) || data.error_count < 0) throw new AuthError('invalid_response');
      const findings = cleanFindings(data.findings);
      const more = cleanCounts(data.more);
      if (data.error_count > 0) throw this.checksFailed(findings, more, data.error_count);
      return { ok: true, outcome: 'checked', doc_id: state.doc_id, draft_id: draft, error_count: 0, findings, more };
    });
  }

  // Uploads the folder like `check`, then asks for the draft's preview link and opens it in the default browser unless
  // `noOpen`. A browser that cannot open (a sandbox, SSH, CI) is an outcome in the result, not a failure: the link is
  // there, and the caller prints it.
  async preview(folder, options = {}) {
    return this.withDraft(await this.scan(folder), options, async ({ draft, state }) => {
      const { data } = await requestJson(this, `/api/drafts/${draft}/preview`, { method: 'POST', retry: true });
      // The same check the opener applies, so a link this prints is one it would also open.
      const link = previewUrl(data?.preview_url);
      if (!link || data.draft_id !== draft || typeof data.expires_at !== 'string') throw new AuthError('invalid_response');
      const browser = options.noOpen ? 'disabled' : await this.opener(link, { noBrowser: false });
      return {
        ok: true, outcome: 'previewed', doc_id: state.doc_id, draft_id: draft, preview_url: link,
        expires_at: data.expires_at, browser,
      };
    });
  }

  // Publishes the folder as the doc's next version. The folder's files replace the doc's files (a file removed from the
  // folder is removed from the doc). `nothing_to_publish` when the folder is exactly the version it came from.
  async push(folder, options = {}) {
    const scan = await this.scan(folder);
    if (scan.state && scan.state.base_version > 0 && sameFiles(scan.state.files, fileMap(scan.entries))) {
      return { ok: true, outcome: 'nothing_to_publish', doc_id: scan.state.doc_id, base_version: scan.state.base_version };
    }
    return this.withDraft(scan, options, async ({ draft, state, revision }) => {
      const published = await requestJson(this, `/api/drafts/${draft}/publish`, {
        method: 'POST', retry: true, headers: JSON_HEADERS, body: JSON.stringify({ expected_revision: revision }),
        passthroughConflicts: ['DOC_VERSION_CONFLICT'],
      });
      if (published.code === 'DOC_VERSION_CONFLICT') throw this.conflict(published.details, scan, state);
      const { data } = published;
      const url = isObject(data) ? siteUrl(this.authClient.origin, data.url) : null;
      if (!url || data.doc_id !== state.doc_id || !Number.isSafeInteger(data.version) || data.version < 1 ||
          !SHA256.test(data.content_hash || '')) throw new AuthError('invalid_response');
      await writeState(scan.directory, {
        doc_id: state.doc_id, base_version: data.version, created: state.created, files: fileMap(scan.entries),
      });
      return {
        ok: true, outcome: 'published', doc_id: state.doc_id, version: data.version,
        url, content_hash: data.content_hash,
        findings: cleanFindings(data.findings), replayed: data.replayed === true, draft_id: draft,
      };
    });
  }

  // ---- the shared path: a draft holding exactly the folder -------------------------------------------------------

  // The folder's files and findings (a problem the server would refuse for sure is `checks_failed` before any request),
  // and its `.viberdocs.json`.
  async scan(folder) {
    const { directory, relative } = await confineFolder(folder, this.store.root);
    const scanned = await scanFolder(directory);
    if (scanned.problems.length) throw this.checksFailed(scanned.problems, [], scanned.problems.length);
    return { directory, relative, entries: scanned.entries, state: await readState(directory) };
  }

  // Makes a draft hold exactly the folder's files (a new doc for a folder with no `.viberdocs.json`), then runs `action`
  // on it with `{draft, state, revision}`. Every failure carries the doc and draft ids.
  async withDraft(scan, options, action) {
    return this.store.withLock(async () => {
      const context = {};
      try {
        if (scan.state) this.matchLinkedDoc(scan.state, options);
        await this.login({ write: true });
        let state = scan.state ?? await this.newDoc(scan.directory, options);
        context.doc_id = state.doc_id;
        let reused = Boolean(scan.state?.draft_id);
        let draftId = state.draft_id;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (!draftId) {
              draftId = await this.startDraft(state);
              state = { ...state, draft_id: draftId };
              await writeState(scan.directory, state);
            }
            context.draft_id = draftId;
            const revision = await this.sync(draftId, scan.entries);
            return await action({ draft: draftId, state, revision });
          } catch (error) {
            // A saved draft that has expired (404) or was already published is replaced, once, by a new one; a draft this
            // run made is never replaced (that would loop).
            const gone = error instanceof AuthError && reused && attempt === 0 &&
              (error.code === 'http_404' || (error.code === 'http_409' && error.server?.code === 'DRAFT_PUBLISHED'));
            if (!gone) throw error;
            state = { doc_id: state.doc_id, base_version: state.base_version, created: state.created, files: state.files };
            draftId = undefined;
            reused = false;
          }
        }
        throw new AuthError('invalid_response');
      } catch (error) {
        if (error instanceof AuthError) {
          if (error.code === 'http_422' && error.server?.code === 'CHECKS_FAILED') {
            const details = error.server.details ?? {};
            throw this.checksFailed(cleanFindings(details.findings), cleanCounts(details.more), details.error_count, context);
          }
          if (error.code === 'http_422' && error.server?.code === 'EDIT_REFUSED') error.code = 'edit_refused';
          Object.assign(error, context);
        }
        throw error;
      }
    });
  }

  // A new doc for a folder that has none, made with its first, empty draft in one request. Not idempotent, so never
  // retried here: after a lost answer the folder has no `.viberdocs.json` and the command is simply run again. The state
  // is saved at once, so a failure after this point reuses the doc and its draft.
  async newDoc(directory, options) {
    const everywhere = this.auth.workspace_reach === 'all';
    if (!everywhere && options.workspace && options.workspace !== this.auth.workspace_id) throw new AuthError('workspace_mismatch');
    if (everywhere && !options.workspace) throw new AuthError('workspace_required');
    const body = {
      space_id: everywhere ? options.workspace : this.auth.workspace_id,
      name: options.name || path.basename(directory),
    };
    if (options.folder) body.folder_id = options.folder;
    if (!body.name || body.name.length > 255) throw new AuthError('invalid_usage');
    const { data } = await requestJson(this, '/api/drafts', {
      method: 'POST', retry: false, headers: JSON_HEADERS, body: JSON.stringify(body), maxBytes: LIST_RESPONSE_MAX,
    });
    if (!isObject(data) || !UUID.test(data.id || '') || !UUID.test(data.doc_id || '') || data.base_version !== 0) {
      throw new AuthError('invalid_response');
    }
    const created = { name: body.name, workspace_id: body.space_id, folder_id: body.folder_id ?? null };
    const state = { doc_id: data.doc_id, base_version: 0, draft_id: data.id, created, files: {} };
    await writeState(directory, state);
    return state;
  }

  // `--name`, `--workspace` and `--folder` say what a new doc is. A folder that already has a doc keeps it (an earlier
  // `check`, `preview` or `push` made it, or `pull` wrote it), and no route renames a doc or moves it to another
  // workspace. So an option that is not what the doc was made with is `doc_mismatch`, before anything is sent: dropped
  // silently, a `check` with no `--name` followed by `push --name` published the doc under the folder's name. What the
  // doc was made with is `created` in `.viberdocs.json` (a CLI login may not read a doc's details from the API). Without
  // it (a pulled folder, or a doc an older CLI made) the name is unknown, so any `--name` is a mismatch (a `push --name`
  // of a pulled folder would otherwise publish over the doc it was pulled from), and the other two are left alone.
  matchLinkedDoc(state, options) {
    const made = state.created;
    const same = (wanted, actual) => String(wanted).toLowerCase() === String(actual).toLowerCase();
    const mismatch = [];
    if (options.name !== undefined && (!made || options.name.trim() !== made.name.trim())) mismatch.push('name');
    if (made && options.workspace && !same(options.workspace, made.workspace_id)) mismatch.push('workspace');
    if (made && options.folder && !same(options.folder, made.folder_id)) mismatch.push('folder');
    if (!mismatch.length) return;
    const error = new AuthError('doc_mismatch');
    Object.assign(error, { doc_id: state.doc_id, mismatch, doc: made ?? null });
    throw error;
  }

  // A draft of the doc from the version the folder is in step with, never the live one: publishing a draft built on a
  // version that is no longer live is how a conflict is found, and a draft started from the live version would hide it.
  async startDraft(state) {
    const { data } = await requestJson(this, `/api/docs/${state.doc_id}/drafts`, {
      method: 'POST', retry: false, headers: JSON_HEADERS, body: JSON.stringify({ base_version: state.base_version }),
      maxBytes: LIST_RESPONSE_MAX,
    });
    if (!isObject(data) || !UUID.test(data.id || '') || data.doc_id !== state.doc_id) throw new AuthError('invalid_response');
    return data.id;
  }

  // Replaces the draft's file list with the folder's and uploads the blobs the server does not have, four at a time.
  // Returns the draft's revision after the manifest, which `publish` is told to expect.
  async sync(draft, entries) {
    const files = entries.map(({ path: filePath, sha256: hash, size }) => ({ path: filePath, sha256: hash, size }));
    const { data } = await requestJson(this, `/api/drafts/${draft}/manifest`, {
      method: 'PUT', retry: true, headers: JSON_HEADERS, body: JSON.stringify({ files }),
    });
    if (!isObject(data) || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.missing) ||
        data.missing.some(hash => !SHA256.test(hash))) throw new AuthError('invalid_response');
    const byHash = new Map();
    for (const entry of entries) if (!byHash.has(entry.sha256)) byHash.set(entry.sha256, entry);
    const missing = [...new Set(data.missing)];
    if (missing.some(hash => !byHash.has(hash))) throw new AuthError('invalid_response');
    await inPool(missing, UPLOAD_CONCURRENCY, async hash => {
      const entry = byHash.get(hash);
      // What is sent is what the manifest named: a file edited since the scan is `file_changed`, not a hash mismatch.
      const bytes = await readRegularFile(entry.absolute, LIMITS.fileBytes);
      if (bytes.length !== entry.size || sha256(bytes) !== hash) throw new AuthError('file_changed');
      await requestJson(this, `/api/drafts/${draft}/blobs/${hash}`, {
        method: 'PUT', retry: true, headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      });
    });
    return data.revision;
  }

  // ---- failures --------------------------------------------------------------------------------------------------

  checksFailed(findings, more, errorCount, context = {}) {
    const error = new AuthError('checks_failed');
    Object.assign(error, context, {
      findings, more, error_count: Number.isSafeInteger(errorCount) && errorCount >= 0 ? errorCount : findings.length,
    });
    return error;
  }

  // The live version moved since the folder was pulled: nothing was published. The error names the files each side
  // changed, and the command that pulls the live version into a sibling folder to merge.
  conflict(details, scan, state) {
    const conflict = cleanConflict(details);
    const error = new AuthError('doc_version_conflict');
    const sibling = `${scan.relative || path.basename(scan.directory)}-v${conflict.active_version ?? 'live'}`;
    Object.assign(error, conflict, {
      suggestion: `${selfCommand()} pull --doc ${state.doc_id} --dir ${shellWord(sibling)}`,
    });
    return error;
  }
}
