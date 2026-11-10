import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AuthError } from './auth/AuthClient.mjs';

// The only API hosts a plugin release may point at. The plugin directory pins the reviewed code but not this file's
// bytes, so an edited or look-alike release file must not be able to send device-flow logins to another host.
export const API_ORIGINS = ['https://viberdocs.com', 'https://test.viberdocs.com', 'https://localhost:8543'];

export const RELEASE_FILE = 'plugin-release.json';
const RELEASE_KEYS = ['api_origin', 'client_id', 'protocol_version', 'schema_version', 'version'];
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

// Reads `plugin-release.json` from `directory` (the folder holding the real entry file) and returns its five
// validated fields. A missing file is `unsafe_install` (the CLI runs only from a plugin); anything else wrong with it
// (a symlink, an oversized or unparseable file, another key set, a value outside its form, an origin that is not on
// the built-in list) is `invalid_release`.
export async function readPluginRelease(directory) {
  const file = path.join(directory, RELEASE_FILE);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    throw new AuthError(error.code === 'ENOENT' ? 'unsafe_install' : 'invalid_release');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new AuthError('invalid_release');
  let release;
  try {
    release = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new AuthError('invalid_release');
  }
  if (!release || typeof release !== 'object' || Array.isArray(release) ||
      Object.keys(release).sort().join() !== RELEASE_KEYS.join() ||
      release.schema_version !== 1 || release.protocol_version !== 1 ||
      typeof release.version !== 'string' || !SEMVER.test(release.version) ||
      !API_ORIGINS.includes(release.api_origin) ||
      typeof release.client_id !== 'string' || !release.client_id) {
    throw new AuthError('invalid_release');
  }
  const { schema_version, version, api_origin, client_id, protocol_version } = release;
  return { schema_version, version, api_origin, client_id, protocol_version };
}

// One word of a shell command, as an agent will paste it into a POSIX shell: left bare when it holds only characters
// no shell treats specially, otherwise in single quotes (inside which `$`, backticks and `\` are plain text), with each
// `'` closed, escaped and reopened. Double quotes would not do: a `$(...)` in a folder name would still run.
export function shellWord(word) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

// The command an agent or person types to run this CLI again: `node <entry as invoked>`. The path is the one in
// `process.argv[1]` (made absolute when relative), never its realpath: the skill pre-approves exactly the path Claude
// Code expands, and a resolved one differs when the plugin folder is reached through a symlink.
export function selfCommand() {
  return `node ${shellWord(path.resolve(process.argv[1] || 'viberdocs.mjs'))}`;
}
