import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AuthError } from '../auth/AuthClient.mjs';
import { hasDotSegment, inside } from './outputFile.mjs';

// What a folder of doc files is, locally: the path rules the server applies, the folder scan, the
// `.viberdocs.json` that ties a folder to a doc, and the findings the commands print. Everything here is
// about files on this machine; the requests are in `DocFolder.mjs`.

export const STATE_FILE = '.viberdocs.json';
// The server's own limits (`doc_path_max_*`, `doc_version_max_*`, the per-file cap).
export const LIMITS = Object.freeze({
  files: 500, fileBytes: 10 * 1024 * 1024, versionBytes: 25 * 1024 * 1024, pathLength: 200, pathDepth: 6,
});
const MAX_STATE_BYTES = 512 * 1024;
const MAX_SCAN_DEPTH = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const FILE_TYPES = ['html', 'css', 'js', 'mjs', 'json', 'md', 'txt', 'csv', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'woff2', 'ico'];
const RESERVED_PREFIXES = ['_vd', '__srv'];
const RESERVED_ROOT_FILES = ['sdk.js'];
const SEVERITIES = ['error', 'warning', 'info'];
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Text from a file name or from the server, made safe to print: control characters (including escape sequences'
// escape byte) become spaces and the length is capped, so a hostile name or message cannot rewrite the terminal.
export function printable(value, max = 500) {
  const text = typeof value === 'string' ? value.replace(CONTROL, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---- Path rules (the same rules the API applies to a doc path) -------------------------------------------------

// The first rule a doc path breaks, as `{code, detail}` with the registry's `files.*` code, or null for a valid path.
// The server checks every rule again; this exists so a bad folder fails before any request.
export function pathProblem(docPath) {
  if (typeof docPath !== 'string' || !docPath) return { code: 'files.path_invalid', detail: 'the path is empty' };
  if (docPath.length > LIMITS.pathLength) return { code: 'files.path_invalid', detail: `the path is longer than ${LIMITS.pathLength} characters` };
  const segments = docPath.split('/');
  if (docPath.startsWith('/')) return { code: 'files.path_invalid', detail: 'the path must be relative' };
  if (segments.length > LIMITS.pathDepth) return { code: 'files.path_invalid', detail: `the path is nested deeper than ${LIMITS.pathDepth} levels` };
  for (const segment of segments) {
    if (!segment) return { code: 'files.path_invalid', detail: 'the path has an empty segment' };
    if (!SEGMENT.test(segment)) return { code: 'files.path_invalid', detail: "a path segment may only use letters, digits, '.', '_' and '-'" };
    if (segment.startsWith('.')) return { code: 'files.path_invalid', detail: "a path segment may not start with '.'" };
  }
  if (RESERVED_PREFIXES.includes(segments[0].toLowerCase()) || RESERVED_ROOT_FILES.includes(docPath.toLowerCase())) {
    return { code: 'files.reserved_path', detail: 'the path is reserved by the platform' };
  }
  const parts = segments[segments.length - 1].toLowerCase().split('.');
  if (parts.length < 2 || !FILE_TYPES.includes(parts[parts.length - 1])) {
    return { code: 'files.type_not_allowed', detail: 'the file extension is not an allowed type' };
  }
  if (parts.slice(1, -1).some(part => FILE_TYPES.includes(part))) {
    return { code: 'files.type_not_allowed', detail: 'the name has two file extensions' };
  }
  return null;
}

// Groups of paths that differ only by case: a pull of the doc would collide on macOS and Windows.
export function caseConflicts(paths) {
  const groups = new Map();
  for (const entry of paths) {
    const key = entry.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()].filter(group => group.length > 1).map(group => group.sort());
}

const FIXES = {
  'files.path_invalid': "Rename it with 1 to 6 segments of letters, digits, '.', '_' and '-', none starting with '.', in at most 200 characters.",
  'files.reserved_path': 'Rename or remove it: _vd/, __srv/ and sdk.js are the platform\'s.',
  'files.type_not_allowed': `Use one extension from: ${FILE_TYPES.join(', ')}.`,
  'files.case_conflict': 'Rename one of them so the paths differ by more than case.',
  'files.too_large': 'Make it smaller or remove it (10 MiB is the most for one file).',
  'files.too_many': 'Remove files or combine them (500 is the most).',
  'files.total_too_large': 'Remove or shrink files (25 MiB is the most for the whole doc).',
};

function localFinding(code, file, message) {
  return { severity: 'error', code, file: printable(file, 200), line: null, message, fix: FIXES[code] };
}

// ---- Folder scan ----------------------------------------------------------------------------------------------

// Reads one regular file: never through a symlink, never a FIFO (it would hang the open), at most `maxBytes`, and the
// same size and times before and after the read. Returns the bytes, or throws `invalid_input` for anything that is not
// a regular file and `file_changed` for a file that changed while it was read.
export async function readRegularFile(file, maxBytes) {
  let fd;
  try {
    try {
      fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new AuthError('invalid_input');
    }
    const before = await fd.stat();
    if (!before.isFile()) throw new AuthError('invalid_input');
    if (before.size > maxBytes) throw new AuthError('invalid_file');
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
    return data.subarray(0, offset);
  } finally {
    if (fd) await fd.close();
  }
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Walks `directory` and returns `{entries, problems}`: every regular, non-dot file as `{path, size, sha256, absolute}`
// sorted by path (forward slashes, relative to `directory`), and the findings for what the server would refuse
// (paths, sizes, counts). Dotfiles and dot-folders (`.git`, `.DS_Store`, `.viberdocs.json`) are skipped. A symlink or
// any other entry that is not a regular file or a folder refuses the whole folder (`invalid_input`), as does a tree
// deeper than a path can be. Never follows a link.
export async function scanFolder(directory) {
  const found = [];
  let overFileLimit = false;
  async function walk(current, relative, depth) {
    if (depth > MAX_SCAN_DEPTH) throw new AuthError('invalid_input');
    const names = await fs.readdir(current, { withFileTypes: true });
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of names) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new AuthError('invalid_input');
      if (entry.isDirectory()) await walk(absolute, entryPath, depth + 1);
      else if (entry.isFile()) {
        if (found.length >= LIMITS.files) { overFileLimit = true; continue; }
        found.push({ path: entryPath, absolute });
      } else throw new AuthError('invalid_input');
    }
  }
  await walk(directory, '', 0);
  const problems = [];
  const entries = [];
  let total = 0;
  for (const { path: docPath, absolute } of found) {
    const problem = pathProblem(docPath);
    if (problem) { problems.push(localFinding(problem.code, docPath, `${problem.detail[0].toUpperCase()}${problem.detail.slice(1)}.`)); continue; }
    const stat = await fs.lstat(absolute);
    if (stat.size > LIMITS.fileBytes) { problems.push(localFinding('files.too_large', docPath, 'The file is over 10 MiB.')); continue; }
    const bytes = await readRegularFile(absolute, LIMITS.fileBytes);
    total += bytes.length;
    entries.push({ path: docPath, size: bytes.length, sha256: sha256(bytes), absolute });
  }
  for (const group of caseConflicts(entries.map(entry => entry.path))) {
    for (const member of group) problems.push(localFinding('files.case_conflict', member, 'Another file differs from this one only by case.'));
  }
  if (overFileLimit) problems.push(localFinding('files.too_many', '', `The folder has more than ${LIMITS.files} files.`));
  if (total > LIMITS.versionBytes) problems.push(localFinding('files.total_too_large', '', 'The files add up to more than 25 MiB.'));
  return { entries, problems };
}

// path -> sha256, for comparing a folder with a version's file map.
export const fileMap = entries => Object.fromEntries(entries.map(entry => [entry.path, entry.sha256]));

export function sameFiles(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}

// ---- The folders a command may use ---------------------------------------------------------------------------------

async function realRoot(root) {
  try { return await fs.realpath(root); } catch { throw new AuthError('invalid_input'); }
}

// The folder a command reads: an existing directory (not a symlink) inside the project root, with no dot-folder in its
// path, so a pre-approved command cannot reach `.git`, `.claude` or the CLI's own state. The root itself is allowed.
// Returns `{directory, relative}`: the real path, and its path from the root with forward slashes ('' for the root).
export async function confineFolder(folder, root) {
  if (typeof folder !== 'string' || !folder || folder.length > 4096 || folder.includes('\0')) throw new AuthError('invalid_input');
  const resolved = path.resolve(process.cwd(), folder);
  const base = await realRoot(root);
  let stat;
  let directory;
  try {
    stat = await fs.lstat(resolved);
    directory = await fs.realpath(resolved);
  } catch {
    throw new AuthError('invalid_input');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(directory, base)) throw new AuthError('invalid_input');
  const relative = path.relative(base, directory);
  if (hasDotSegment(relative)) throw new AuthError('invalid_input');
  return { directory, relative: relative.split(path.sep).join('/') };
}

// The folder `pull` writes into: new (its parent must exist) or an existing empty directory, inside the project
// root, with no dot-folder in its path. Anything else is `invalid_output`, so a pull never overwrites work. Returns
// `{directory, relative, created}`; a new folder is created here, private to the user.
export async function prepareTarget(dir, root) {
  if (typeof dir !== 'string' || !dir || dir.length > 4096 || dir.includes('\0')) throw new AuthError('invalid_output');
  const resolved = path.resolve(process.cwd(), dir);
  const base = await realRoot(root).catch(() => { throw new AuthError('invalid_output'); });
  let parent;
  try { parent = await fs.realpath(path.dirname(resolved)); } catch { throw new AuthError('invalid_output'); }
  const name = path.basename(resolved);
  const directory = path.join(parent, name);
  if (!name || !inside(parent, base)) throw new AuthError('invalid_output');
  const relative = path.relative(base, directory);
  if (!relative || hasDotSegment(relative)) throw new AuthError('invalid_output');
  let created = false;
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.readdir(directory)).length) throw new AuthError('invalid_output');
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error.code !== 'ENOENT') throw new AuthError('invalid_output');
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch { throw new AuthError('invalid_output'); }
    created = true;
  }
  return { directory, relative: relative.split(path.sep).join('/'), created };
}

// ---- .viberdocs.json ----------------------------------------------------------------------------------------------

const STATE_KEYS = ['base_version', 'doc_id', 'draft_id', 'files'];

// Reads a folder's `.viberdocs.json`: `{doc_id, base_version, draft_id?, files: {path: sha256}}`, where `files` is the
// version the folder was last in step with (`pull` or a successful `push`). Null when there is none; `invalid_state` for
// a symlink, a non-file, an oversized file, or anything that is not exactly that shape. Fails closed.
export async function readState(directory) {
  const file = path.join(directory, STATE_FILE);
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new AuthError('invalid_state');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw new AuthError('invalid_state');
  let state;
  try { state = JSON.parse((await readRegularFile(file, MAX_STATE_BYTES)).toString('utf8')); } catch { throw new AuthError('invalid_state'); }
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some(key => !STATE_KEYS.includes(key)) ||
      !UUID.test(state.doc_id || '') || !Number.isSafeInteger(state.base_version) || state.base_version < 0 ||
      (state.draft_id !== undefined && !UUID.test(state.draft_id || '')) ||
      !state.files || typeof state.files !== 'object' || Array.isArray(state.files) ||
      Object.entries(state.files).some(([key, value]) => pathProblem(key) !== null || !SHA256.test(value))) {
    throw new AuthError('invalid_state');
  }
  return state;
}

// Writes `.viberdocs.json` beside the files: a new private temporary file, synced, then renamed over the old one.
export async function writeState(directory, { doc_id, base_version, draft_id, files }) {
  const file = path.join(directory, STATE_FILE);
  const state = { doc_id, base_version, ...(draft_id ? { draft_id } : {}), files };
  const temporary = path.join(directory, `.viberdocs-state-${randomUUID()}`);
  let fd;
  try {
    fd = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await fd.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await fd.sync();
    await fd.close();
    fd = undefined;
    await fs.rename(temporary, file);
  } catch {
    throw new AuthError('invalid_state');
  } finally {
    if (fd) await fd.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

// ---- Findings and conflicts as the server sends them --------------------------------------------------------------

const MAX_FINDINGS = 100;

// A finding off the wire, reduced to the fields a person reads. The server's words come from its findings registry
// (counts, limits, validated paths), but are still flattened and capped before they reach a terminal.
export function cleanFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const message = printable(finding.message);
  if (!message) return null;
  return {
    severity: SEVERITIES.includes(finding.severity) ? finding.severity : 'warning',
    code: /^[a-z0-9_.]{1,64}$/.test(finding.code || '') ? finding.code : 'unknown',
    file: printable(finding.file, 200),
    line: Number.isSafeInteger(finding.line) && finding.line >= 1 ? finding.line : null,
    message,
    fix: printable(finding.fix),
  };
}

export function cleanFindings(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_FINDINGS).map(cleanFinding).filter(Boolean);
}

export function cleanCounts(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_FINDINGS)
    .filter(entry => entry && /^[a-z0-9_.]{1,64}$/.test(entry.code || '') && Number.isSafeInteger(entry.count) && entry.count >= 1)
    .map(({ code, count }) => ({ code, count }));
}

// `severity code file:line message`, then the fix on its own line.
export function findingLines(findings) {
  return findings.flatMap(finding => {
    const where = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';
    const lines = [`${finding.severity} ${finding.code}${where} ${finding.message}`];
    if (finding.fix) lines.push(`  fix: ${finding.fix}`);
    return lines;
  });
}

// The 409 a publish answers when the live version moved: the version each side is at and the files each side changed,
// each list reduced to valid doc paths and capped. Anything else in the details is dropped.
export function cleanConflict(details) {
  const list = value => (Array.isArray(value) ? value : []).filter(entry => pathProblem(entry) === null).slice(0, 50);
  const version = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const source = details && typeof details === 'object' ? details : {};
  return {
    base_version: version(source.expected_active_version), active_version: version(source.active_version),
    changed_here: list(source.changed_here), changed_there: list(source.changed_upstream), both: list(source.both),
  };
}

export function conflictLines({ changed_here: here, changed_there: there, both }) {
  return [...here.map(file => `changed here: ${file}`), ...there.map(file => `changed there: ${file}`), ...both.map(file => `both: ${file}`)];
}
