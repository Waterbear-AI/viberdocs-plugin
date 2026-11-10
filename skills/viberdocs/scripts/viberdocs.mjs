import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPluginRelease, selfCommand } from './plugin.mjs';
import { CredentialStore } from './auth/CredentialStore.mjs';
import { AuthClient, AuthError } from './auth/AuthClient.mjs';
import { openBrowser, openPreview } from './auth/browser.mjs';
import { login } from './commands/login.mjs';
import { logout } from './commands/logout.mjs';
import { status } from './commands/status.mjs';
import { DocumentUploader } from './services/DocumentUploader.mjs';
import { DocumentDownloader } from './services/DocumentDownloader.mjs';
import { DocFolder } from './services/DocFolder.mjs';
import {
  cleanConflict, cleanCounts, cleanFindings, conflictLines, findingLines, printable,
} from './services/docFiles.mjs';
import { TemplateClient } from './services/TemplateClient.mjs';
import { SERVER_CODE, TEMPLATE_HANDLE, printableProblems } from './services/templateShape.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOLDER_COMMANDS = ['check', 'preview', 'push'];
const usage = () => `Usage: ${selfCommand()} login [--no-browser] | logout | status | ` +
  'pull --doc ID --dir FOLDER [--version N] | check FOLDER | preview FOLDER [--no-open] | ' +
  'push FOLDER [--workspace ID --name NAME [--folder ID]] | upload FILE [options] | ' +
  'download --doc ID [--version N] --output FILE | template create FILE [--workspace ID] | ' +
  'template update FILE --handle H --draft-revision N | template schema --output FILE';
const TEMPLATE_SUBCOMMANDS = ['create', 'update', 'schema'];
let networkOrigin;
let networkOperation;
let jsonOutput = false;
const FOLDER_OPERATIONS = ['pull', 'check', 'preview', 'push'];

// Whether a parsed `template` command is complete and consistent. Which flags belong to which subcommand is
// already decided while parsing (any other flag is `invalid_usage`); this checks the rest: a file where one is
// needed, values of the right form, and `--workspace` never together with `--resume`.
function validTemplateUsage(sub, file, options) {
  if (sub === 'create') {
    return Boolean(file) && (options.workspace === undefined || UUID.test(options.workspace)) &&
      (options.resume === undefined || UUID.test(options.resume)) &&
      !(options.workspace !== undefined && options.resume !== undefined);
  }
  if (sub === 'update') return Boolean(file) && options.handle !== undefined && options.draftRevision !== undefined;
  return sub === 'schema' && typeof options.output === 'string' && options.output.length >= 1 && options.output.length <= 4096;
}

// What a person at a terminal sees for a pending login: the one-click link and the code on their own lines, whether
// the page opened, and how to continue. Never the device code or a token: `result` carries neither.
function pendingText(result) {
  const lines = [`Approve this login in your browser: ${result.verification_uri_complete}`, `Code: ${result.user_code}`];
  if (result.browser === 'opened') lines.push('(The approval page opened in your browser.)');
  lines.push(`Then run: ${result.resume_command}`);
  return lines.join('\n');
}

function runTemplate(templates, sub, file, options, root) {
  if (sub === 'create') return templates.create(file, { workspace: options.workspace, resume: options.resume });
  if (sub === 'update') return templates.update(file, { handle: options.handle, draftRevision: options.draftRevision });
  return templates.schema({ output: options.output, root });
}

// The project this command works in: the real path of the working directory (the skill says to run from the project
// root). `/` and the home folder are refused, since every pre-approved write would otherwise reach dotfiles there.
async function projectRoot() {
  const root = await fs.realpath(process.cwd());
  const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
  if (root === path.parse(root).root || root === home) throw new AuthError('unsafe_root');
  return root;
}

async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage());
    return;
  }
  // The CLI runs only from a plugin: `plugin-release.json` must sit beside the real entry file. The plugin
  // directory pins the reviewed commit, so there is no hash check of the script itself.
  const release = await readPluginRelease(path.dirname(await fs.realpath(fileURLToPath(import.meta.url))));
  if (args.length === 1 && args[0] === '--version') {
    console.log(release.version);
    return;
  }
  const root = await projectRoot();
  const command = args.shift();
  const sub = command === 'template' ? args.shift() : undefined;
  const options = {};
  const takesFile = command === 'upload' || FOLDER_COMMANDS.includes(command) ||
    (command === 'template' && ['create', 'update'].includes(sub));
  const file = takesFile && args.length && !args[0].startsWith('--') ? args.shift() : null;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--json' && !options.json) options.json = jsonOutput = true;
    else if (command === 'template' && sub === 'create' && flag === '--workspace' && options.workspace === undefined && args.length) options.workspace = args.shift();
    else if (command === 'template' && sub === 'create' && flag === '--resume' && options.resume === undefined && args.length) options.resume = args.shift();
    else if (command === 'template' && sub === 'update' && flag === '--handle' && options.handle === undefined && args.length) {
      const value = args.shift();
      if (!TEMPLATE_HANDLE.test(value)) throw new AuthError('invalid_usage');
      options.handle = value;
    }
    else if (command === 'template' && sub === 'update' && flag === '--draft-revision' && options.draftRevision === undefined && args.length) {
      const value = args.shift();
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AuthError('invalid_usage');
      options.draftRevision = Number(value);
    }
    else if (command === 'template' && sub === 'schema' && flag === '--output' && options.output === undefined && args.length) options.output = args.shift();
    else if (['login', 'upload'].includes(command) && flag === '--workspace' && !options.workspace && args.length) options.workspace = args.shift();
    else if (command === 'login' && flag === '--resume' && !options.resume) options.resume = true;
    else if (command === 'login' && flag === '--cancel' && !options.cancel) options.cancel = true;
    else if (command === 'login' && flag === '--no-browser' && !options.noBrowser) options.noBrowser = true;
    else if (command === 'upload' && flag === '--resume' && !options.resume && args.length) options.resume = args.shift();
    else if (command === 'upload' && flag === '--folder' && !options.folder && args.length) options.folder = args.shift();
    else if (command === 'upload' && flag === '--name' && !options.name && args.length) options.name = args.shift();
    else if (command === 'upload' && flag === '--doc' && !options.doc && args.length) options.doc = args.shift();
    else if (command === 'upload' && flag === '--base-version' && options.baseVersion === undefined && args.length) {
      const value = args.shift();
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new AuthError('invalid_usage');
      options.baseVersion = Number(value);
    }
    else if (FOLDER_COMMANDS.includes(command) && flag === '--workspace' && !options.workspace && args.length) options.workspace = args.shift();
    else if (FOLDER_COMMANDS.includes(command) && flag === '--name' && options.name === undefined && args.length) options.name = args.shift();
    else if (FOLDER_COMMANDS.includes(command) && flag === '--folder' && !options.folder && args.length) options.folder = args.shift();
    else if (command === 'preview' && flag === '--no-open' && !options.noOpen) options.noOpen = true;
    else if (command === 'pull' && flag === '--doc' && options.doc === undefined && args.length) options.doc = args.shift();
    else if (command === 'pull' && flag === '--dir' && options.dir === undefined && args.length) options.dir = args.shift();
    else if (command === 'pull' && flag === '--version' && options.version === undefined && args.length) {
      const value = args.shift();
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AuthError('invalid_usage');
      options.version = Number(value);
    }
    else if (command === 'download' && flag === '--doc' && options.doc === undefined && args.length) options.doc = args.shift();
    else if (command === 'download' && flag === '--output' && options.output === undefined && args.length) options.output = args.shift();
    else if (command === 'download' && flag === '--version' && options.version === undefined && args.length) {
      const value = args.shift();
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AuthError('invalid_usage');
      options.version = Number(value);
    }
    else throw new AuthError('invalid_usage');
  }
  if (!['login', 'logout', 'status', 'upload', 'download', 'template', 'pull', ...FOLDER_COMMANDS].includes(command) ||
      (command === 'pull' && (!UUID.test(options.doc || '') || !options.dir || options.dir.length > 4096)) ||
      (FOLDER_COMMANDS.includes(command) && (!file || (options.folder && !UUID.test(options.folder)) ||
        (options.name !== undefined && (!options.name || options.name.length > 255)))) ||
      (command === 'template' && (!TEMPLATE_SUBCOMMANDS.includes(sub) || !validTemplateUsage(sub, file, options))) ||
      (command === 'download' && (!UUID.test(options.doc || '') || !options.output || options.output.length > 4096)) ||
      (options.workspace && !UUID.test(options.workspace)) ||
      (command === 'login' && Number(Boolean(options.workspace)) + Number(Boolean(options.resume)) + Number(Boolean(options.cancel)) > 1) ||
      (command === 'upload' && (!file || (options.doc && !UUID.test(options.doc)) ||
        (options.folder && !UUID.test(options.folder)) || (options.resume && !UUID.test(options.resume)) ||
        (options.name && options.name.length > 255) || (options.doc && (options.folder || options.name || options.workspace)) ||
        (Boolean(options.doc) !== (options.baseVersion !== undefined)) ||
        (options.baseVersion !== undefined && !Number.isSafeInteger(options.baseVersion)) ||
        (options.resume && (options.doc || options.workspace || options.folder || options.name || options.baseVersion !== undefined))))) {
    throw new AuthError('invalid_usage');
  }
  // Every id flag is a UUID by now, compared with the API's and the journal's (lowercase) ones and used to name the
  // journal file, so the case the caller typed must not matter. (`login --resume` is a switch, not an id.)
  for (const key of ['workspace', 'resume', 'doc', 'folder']) {
    if (typeof options[key] === 'string') options[key] = options[key].toLowerCase();
  }
  const store = new CredentialStore(root);
  const client = new AuthClient(release);
  networkOrigin = client.origin;
  networkOperation = command === 'template' ? `template ${sub}` : command;
  const opener = url => openBrowser(url, { platform: process.platform, env: process.env, noBrowser: options.noBrowser });
  const previewOpener = (url, { noBrowser }) => openPreview(url, { platform: process.platform, env: process.env, noBrowser });
  // The doc-folder commands: the server's findings and a conflict's files print as text lines first (a person's view);
  // the JSON line that follows, and all of it with `--json`, is what a program reads.
  const folders = new DocFolder(store, client, fetch, { opener: previewOpener });
  const folderResult = command === 'pull' ? () => folders.pull({ doc: options.doc, dir: options.dir, version: options.version }) :
    command === 'check' ? () => folders.check(file, options) : command === 'preview' ? () => folders.preview(file, options) :
      command === 'push' ? () => folders.push(file, options) : null;
  const result = folderResult ? await folderResult() : command === 'login' ? await login(store, client, options, opener) :
    command === 'logout' ? await logout(store, client) : command === 'upload' ?
      await new DocumentUploader(store, client).upload(file, options) : command === 'download' ?
        await new DocumentDownloader(store, client).download({
          doc: options.doc, version: options.version, output: options.output, root,
        }) : command === 'template' ? await runTemplate(new TemplateClient(store, client), sub, file, options, root) :
          await status(store, release);
  if (options.json) console.log(JSON.stringify(result));
  else if (result.status === 'pending') console.log(pendingText(result));
  else {
    if (result.preview_url) console.log(`Preview: ${result.preview_url} (expires ${result.expires_at})`);
    if (result.outcome === 'nothing_to_publish') console.log('Nothing to publish: the folder matches the version it came from.');
    if (Array.isArray(result.findings)) for (const line of findingLines(result.findings)) console.log(line);
    console.log(JSON.stringify(result));
  }
}

main().catch(error => {
  const allowed = [
    'invalid_usage', 'unsafe_install', 'invalid_release', 'unsafe_root', 'login_unavailable', 'invalid_input', 'unsafe_state', 'tracked_state', 'unsupported_host',
    'lock_timeout', 'network_error', 'request_failed', 'invalid_response', 'authorization_pending', 'slow_down',
    'access_denied', 'expired_token', 'invalid_grant', 'invalid_client', 'reauth_required', 'workspace_mismatch',
    'no_pending_login', 'login_expired', 'invalid_state', 'invalid_file', 'file_changed', 'invalid_operation',
    'invalid_output', 'integrity_failed', 'no_active_version',
    'invalid_template_file', 'draft_revision_conflict',
    'checks_failed', 'doc_version_conflict', 'edit_refused', 'multi_file_doc',
    'operation_mismatch', 'idempotency_conflict', 'read_only_login', 'workspace_required', 'http_401', 'http_402', 'http_403', 'http_404', 'http_409',
    'http_413', 'http_422', 'http_429', 'http_500', 'http_502', 'http_503', 'http_504',
  ];
  const code = allowed.includes(error.code || error.message) ? (error.code || error.message) : 'operation_failed';
  const messages = {
    invalid_usage: usage(),
    unsafe_root: 'Run this from the project folder, not / or your home folder.',
    login_unavailable: 'CLI login is not available on this server. Edit and publish docs with the ViberDocs draft tools ' +
      '(start_doc_draft, edit_doc_draft, preview_doc_draft, publish_doc_draft), and save templates with the ' +
      'create_template and update_template tools.',
    invalid_input: 'The file must be a regular file inside the project folder, outside any dot-folder such as .viberdocs, and not a symlink. Copy it into the project folder first, then pass that path.',
    reauth_required: 'Run logout to clear the uncertain local login, then run login to sign in again.',
    login_expired: 'The pending login expired or could not be confirmed. Run login to start a new one.',
    invalid_file: 'Choose a nonempty file no larger than 10 MiB.',
    file_changed: 'The file changed while it was being read; retry with a stable file.',
    operation_mismatch: 'The file or grant differs from the saved operation; do not start a replacement automatically.',
    workspace_mismatch: 'The requested workspace differs from this login. Log out to change workspaces.',
    read_only_login: 'This login is read-only. Log out and log in again with Read & write to publish.',
    workspace_required: 'This login covers all your workspaces. Pass --workspace <workspace_id> to choose where the new document goes.',
    network_error: `The ${networkOperation} request to ${networkOrigin} could not be confirmed. Allow access through your host's permission process; resume the saved operation if one is shown.`,
    http_402: 'The workspace plan or quota does not permit publishing.',
    invalid_output: 'Choose a new or existing regular file inside the project folder, in a folder that already exists, with no dot-folder or dot-file in its path (such as .git, .claude or .viberdocs) and with the extension of its content (.html for a document, .json for the template schema).',
    integrity_failed: 'The downloaded content did not match the size or hash the server listed; nothing was written.',
    no_active_version: 'The document has no active version; pass --version to download a specific one.',
    multi_file_doc: `This version is a folder of files, and download saves one file. Use pull instead: ${selfCommand()} pull --doc <doc_id> --dir <new folder>.`,
    http_403: networkOperation === 'download' ? 'This account cannot read this document in the selected workspace.' :
      'This account cannot publish to the selected workspace.',
    http_404: networkOperation === 'download' ? 'The document or version is unavailable.' :
      'The document or workspace is unavailable.',
    http_409: 'The document changed or the operation conflicts. Review its current version before retrying.',
    http_422: 'The server rejected the document or its metadata.',
  };
  const templateOperation = typeof networkOperation === 'string' && networkOperation.startsWith('template ');
  if (templateOperation) {
    Object.assign(messages, {
      invalid_template_file: 'Pass a JSON object with name, description, category and package (tags optional) for create, or any of those for update. Set the workspace with --workspace and the revision with --draft-revision, not in the file.',
      draft_revision_conflict: 'The template changed since that draft revision. Call get_template for its current draft_revision, merge your changes into your own template file, and run update with that revision.',
      idempotency_conflict: 'This saved create was already used for different content. Start a new create without --resume.',
      read_only_login: 'This login is read-only. Log out and log in again with Read & write to save templates.',
      http_403: 'This login cannot save templates. Log out and log in again with Read & write.',
      http_404: 'The template or workspace is unavailable to this login.',
      http_413: 'The template is larger than the server accepts.',
      http_409: 'The template changed or the operation conflicts; server_code says which (TEMPLATE_OWNERSHIP_CHANGED: it now belongs to someone else, so this login cannot update it). Otherwise read it with get_template before retrying.',
      http_422: 'The server rejected the template. Fix what problems lists and run the command again.',
    });
    if (networkOperation === 'template update') {
      messages.network_error = `The update request to ${networkOrigin} could not be confirmed. Call get_template: if draft_revision is one more than you sent, it landed; otherwise run update again.`;
    }
  }
  const folderOperation = FOLDER_OPERATIONS.includes(networkOperation);
  if (folderOperation) {
    Object.assign(messages, {
      invalid_input: 'The folder must be inside the project folder, outside any dot-folder such as .viberdocs, and hold only regular files and folders, no symlinks. Dotfiles in it are ignored.',
      invalid_output: 'Choose a new folder, or an empty one, inside the project folder, with no dot-folder in its path.',
      invalid_file: 'A file in the folder is larger than 10 MiB or could not be read.',
      file_changed: 'A file in the folder changed while it was being read; run the command again once it is stable.',
      invalid_state: `The .viberdocs.json in the folder is not valid. Delete it and run ${selfCommand()} pull again, or, for a new doc, push the folder with --workspace and --name.`,
      checks_failed: 'The checks found errors, so nothing was published. Fix every error finding (its fix says how) and run the command again.',
      doc_version_conflict: 'Someone published this doc after the folder was pulled, so nothing was published and there is no override. changed_here, changed_there and both name the files each side changed. Pull the live version into a new folder with the suggestion, merge your changes into it, and push that folder.',
      edit_refused: 'The server refused an edit; nothing was changed.',
      http_404: 'The doc, its workspace or the draft is unavailable to this login.',
      http_409: 'The doc or its draft conflicts with the request; server_code says which.',
      http_422: 'The server rejected the files; server_code says which. Run check for the findings.',
    });
  }
  const result = { ok: false, code, message: messages[code] || `ViberDocs CLI: ${code}`, retryable: Boolean(error.retryable) };
  if (UUID.test(error.operation_id || '')) result.operation_id = error.operation_id;
  // What the server said, shown only when it has the exact expected shape: its error code for a rejected (422)
  // or conflicting (409, template and doc-folder operations) request, the bounded list of problems for a rejection, and the
  // handle of the template the command was about.
  if (SERVER_CODE.test(error.server_code || '') && (code === 'http_422' || (code === 'http_409' && (templateOperation || folderOperation)))) {
    result.server_code = error.server_code;
  }
  if (code === 'checks_failed') {
    result.findings = cleanFindings(error.findings);
    result.more = cleanCounts(error.more);
    if (Number.isSafeInteger(error.error_count) && error.error_count >= 0) result.error_count = error.error_count;
    if (!jsonOutput) for (const line of findingLines(result.findings)) console.log(line);
  }
  if (code === 'doc_version_conflict') {
    Object.assign(result, cleanConflict({
      expected_active_version: error.base_version, active_version: error.active_version,
      changed_here: error.changed_here, changed_upstream: error.changed_there, both: error.both,
    }));
    if (typeof error.suggestion === 'string') result.suggestion = printable(error.suggestion, 4096);
    if (!jsonOutput) {
      for (const line of conflictLines(result)) console.log(line);
      if (result.suggestion) console.log(`To merge: ${result.suggestion}`);
    }
  }
  if (UUID.test(error.draft_id || '')) result.draft_id = error.draft_id;
  if (code === 'http_422') {
    const problems = printableProblems(error.problems);
    if (problems) result.problems = problems;
  }
  if (TEMPLATE_HANDLE.test(error.handle || '')) result.handle = error.handle;
  if (UUID.test(error.doc_id || '')) result.doc_id = error.doc_id;
  if (Number.isSafeInteger(error.version) && error.version > 0) result.version = error.version;
  console.log(JSON.stringify(result));
  process.exitCode = code === 'invalid_usage' ? 2 : 1;
});
