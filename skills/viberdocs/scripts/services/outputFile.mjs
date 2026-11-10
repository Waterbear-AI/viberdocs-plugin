import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthError } from '../auth/AuthClient.mjs';

export function inside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// Whether a path below the project root passes through a dot-folder or dot-file (`.git/`, `.claude/`, `.env`,
// `.viberdocs/`). The skill pre-approves this CLI's commands, so none of them may read or write such a place.
// `relative` comes from `path.relative(realRoot, ...)`, so `./page.html` has already become `page.html`.
export function hasDotSegment(relative) {
  return relative.split(path.sep).some(part => part.startsWith('.'));
}

// A target is a new file or an existing regular file; a symlink, a directory or anything else is refused.
async function checkTarget({ file }) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new AuthError('invalid_output');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AuthError('invalid_output');
}

// Confines a write to the project root, to an existing directory, and to a new file or an existing regular file.
// No part of the path below the root may start with a dot (so never `.viberdocs/`, `.git/` or `.claude/`), and the
// extension must be the one the content has (`.html` for a document, `.json` for the template schema), so a
// pre-approved download cannot overwrite a config or script. Runs before any content is requested. `output` is
// resolved against the working directory. Returns `{parent, file, relative}`: the real parent directory, the real
// file path, and the file's path from the root with forward slashes.
export async function resolveOutputTarget(output, root, extension) {
  if (typeof output !== 'string' || !output || output.length > 4096 || output.includes('\0')) {
    throw new AuthError('invalid_output');
  }
  const resolved = path.resolve(process.cwd(), output);
  const name = path.basename(resolved);
  let realRoot;
  let parent;
  try {
    realRoot = await fs.realpath(root);
    parent = await fs.realpath(path.dirname(resolved));
    if (!(await fs.stat(parent)).isDirectory()) throw new Error();
  } catch {
    throw new AuthError('invalid_output');
  }
  if (!name || !inside(parent, realRoot) || inside(parent, path.join(realRoot, '.viberdocs'))) {
    throw new AuthError('invalid_output');
  }
  const file = path.join(parent, name);
  const relative = path.relative(realRoot, file);
  // An unknown `extension` never matches, so a caller that forgets it fails closed.
  if (hasDotSegment(relative) || path.extname(name).toLowerCase() !== extension) throw new AuthError('invalid_output');
  const target = { parent, file, relative: relative.split(path.sep).join('/') };
  await checkTarget(target);
  return target;
}

// Writes `bytes` to a new temporary file beside the target, syncs it, and renames it over the target, so a reader
// sees the old file or the whole new one. The target is checked again first (it may have changed since
// `resolveOutputTarget`).
export async function writeFileAtomically(target, bytes) {
  await checkTarget(target);
  const temporary = path.join(target.parent, `.viberdocs-download-${randomUUID()}`);
  let created = false;
  try {
    let fd;
    try {
      fd = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
    } catch {
      throw new AuthError('invalid_output');
    }
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.rename(temporary, target.file);
    created = false;
  } catch (error) {
    throw error instanceof AuthError ? error : new AuthError('invalid_output');
  } finally {
    // Best effort: a cleanup failure must not replace the error that got us here.
    if (created) await fs.unlink(temporary).catch(() => {});
  }
}
