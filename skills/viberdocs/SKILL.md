---
name: viberdocs
description: Publish, edit, preview or download ViberDocs docs (a doc is a folder of files) and save templates with the ViberDocs command-line tool bundled in this plugin. Use it when the user asks to publish a doc to ViberDocs, change a doc, look at a doc before it goes live, pull a doc to edit it, or save a template.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs *)
---

# ViberDocs CLI

This skill publishes, previews and pulls ViberDocs docs and saves template drafts with a Node command-line tool bundled in the plugin, so a doc's files never pass through the conversation. A doc is a folder of files: an `index.html` plus the styles, scripts, data, images and fonts it uses. Only that one script is pre-approved. Never run any other Node script on its behalf.

## Choosing a path

- **With a shell, Node 22 or 24 and macOS or Linux (WSL counts): use this CLI** for docs (`pull`, `check`, `preview`, `push`). `upload` and `download` are only for one HTML file the user hands you.
- **Without Node 22 or 24, or not on macOS, Linux or WSL, or when the CLI cannot log in or reach the API** (for example `login_unavailable` or `network_error`): use the MCP draft tools for docs (`start_doc_draft`, `view_doc_file` and `search_doc_files`, `edit_doc_draft`, `preview_doc_draft`, `publish_doc_draft`), and `create_template` and `update_template` for templates. The draft tools cost more tokens, so say so. The transfer-token runbook (`create_transfer_token`) stays only for a single HTML file.
- **On `network_error`**, ask the user to allow the API host the message names, through the host's normal permission process, then run the command again (resume a saved operation if the result shows one). If it stays blocked, use the draft tools; they reach the host through the connector. Do not disable TLS validation or look for another way around the block.

To write the doc itself, call `get_guide` with topic `build_doc`: it returns a short core, and you fetch a section by name (the `section` argument) only when the core's index says it applies.

## Reading the guide with this CLI

The guide describes the MCP draft tools. With this CLI, run the mapped command wherever the guide names a draft tool:

| The guide names | Run this instead |
| --- | --- |
| `start_doc_draft` for a doc that exists | `pull --doc <doc_id> --dir <new_folder>` |
| `start_doc_draft` for a new doc | Make a new folder: `push` creates the doc (with `--workspace` and `--name`, and `--folder` to file it) |
| `edit_doc_draft`, `view_doc_file`, `search_doc_files`, `list_doc_files` | Edit, read and search the files in the folder |
| `preview_doc_draft` | `preview <folder>` |
| `publish_doc_draft` | `push <folder>` |
| findings from an edit or a publish | `check <folder>` (and the findings `push` prints) |
| `DOC_VERSION_CONFLICT` | `doc_version_conflict` from `push`: see "If someone else published first" |
| `get_guide` with topic `template_schema` | `template schema --output <template-schema.json>` |
| `create_template`, `update_template` | `template create <template.json>`, `template update <template.json>` |

Steps the guide leaves to the CLI:

- **Updating an existing doc.** `pull` it into a new folder: its `.viberdocs.json` remembers the base version, so the version stays the same doc. Edit only what must change, then `check` and `push` from that folder. Never start a fresh folder just to publish an update: that defeats the conflict check.
- **A doc with sign-off.** Read the decisions first with the `get_doc_signoffs` tool, then change the files in the folder.
- **Filing a new doc in a folder.** Find or create the folder with `list_folders` and `create_folder`, then pass its id as `push --folder <folder_id>` with the same `--workspace`.
- **Templates.** `template schema` writes the package schema to a file; `template create` and `template update` save a draft (see "Templates").

## Where to run it

Run every command from the **project root**, the folder that holds (or will hold) `.viberdocs/`. The login is kept in `<project>/.viberdocs/state`, so a command run from another folder finds no login. Pass folders and files as arguments and **never `cd` into a doc folder**. The CLI refuses `/` and the home folder as a project root (`unsafe_root`).

Add `.viberdocs/` to the project's `.gitignore`. Never read, print or share anything under `.viberdocs/state`; it holds the login.

## Commands

Every command prints one JSON line with `--json`. Use `--json` always, and read the result instead of scraping text.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs --version
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs status --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs login --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs login --workspace <workspace_id> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs login --resume --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs login --cancel --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs logout --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs pull --doc <doc_id> --dir <new_folder> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs pull --doc <doc_id> --dir <new_folder> --version <n> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs check <folder> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs preview <folder> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs preview <folder> --no-open --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs push <folder> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs push <folder> --workspace <workspace_id> --name "<name>" --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs push <folder> --workspace <workspace_id> --name "<name>" --folder <folder_id> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs upload <file.html> --workspace <workspace_id> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs upload <file.html> --workspace <workspace_id> --folder <folder_id> --name "<name>" --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs upload <file.html> --doc <doc_id> --base-version <active_version> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs upload <file.html> --resume <operation_id> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs download --doc <doc_id> --output <file.html> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs download --doc <doc_id> --version <n> --output <file.html> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs template schema --output <template-schema.json> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs template create <template.json> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs template create <template.json> --workspace <workspace_id> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs template create <template.json> --resume <operation_id> --json
node ${CLAUDE_SKILL_DIR}/scripts/viberdocs.mjs template update <template.json> --handle <handle> --draft-revision <draft_revision> --json
```

- **Docs are folders.** `pull` writes a doc into a new (or empty) folder with a `.viberdocs.json` beside the files, which says which doc and version the folder came from. Edit the files, then `check` (what publishing would find), `preview` (a link to look at the draft before it goes live: it prints the link and opens the default browser; with `--no-open`, or where no browser can open, it only prints the link) and `push` (publishes the folder as the doc's next version; the folder's files replace the doc's files). A folder with no `.viberdocs.json` is a new doc: `push` (and `check` and `preview`) make it, in `--workspace` (required under an all-workspaces login) with `--name` (default: the folder's name) and optionally `--folder`. `push` of a folder that matches the version it came from prints "nothing to publish" and exits 0.
- **Each part is its own file.** Write the page as `index.html` plus a stylesheet and a script (`css/site.css`, `js/app.js`), and data and images as files (`data/rows.json`, `img/logo.png`), linked by relative paths. Don't inline them in the page: later edits then change one small file. Load Chart.js from `/_vd/lib/chart.js@4.6.1/chart.umd.js`, never a CDN.
- A doc folder holds regular files and folders only: no symlinks, and dotfiles (including `.viberdocs.json`) are ignored. Paths use letters, digits, `.`, `_` and `-`, at most 6 levels deep and 200 characters, with a type from html, css, js, mjs, json, md, txt, csv, svg, png, jpg, jpeg, gif, webp, avif, woff2 or ico; `_vd/`, `__srv/` and a root `sdk.js` are reserved. At most 500 files, 10 MiB each, 25 MiB in all. The folder must be inside the project folder with no dot-folder in its path. A page whose JavaScript uses `ViberDocs.*` loads `<script src="/sdk.js"></script>` (without it the `sdk.missing_script` finding blocks the push).
- **Findings.** `check` and `push` print each finding as `severity code file:line message`, then its `fix` on the next line (with `--json`, they are in `findings`). Every `error` finding must be fixed before `push` succeeds (`checks_failed`: nothing was published); warnings and info do not block. Run `check` or `preview` after edits, not only at the end.
- `upload` without `--doc` creates a doc; with `--doc` and `--base-version` it publishes a new version of an existing one. `--workspace` is required for a new doc under an all-workspaces login; an update follows its doc and takes no workspace. `--folder` files the new doc in a folder (ids from `list_folders`). Do not mix `--doc` with `--workspace`, `--folder` or `--name`.
- A file passed to `upload`, `template create` or `template update` must be a regular, nonempty file of at most 10 MiB **inside the project folder**, not a symlink, and not under a dot-folder or dot-file such as `.viberdocs/`, `.git/` or `.env`. Otherwise the result is `invalid_input`: copy the file into the project folder first, then pass that path.
- `upload` and `download` are for one HTML file the user hands you. `download` of a version made of files ends with `multi_file_doc`: use `pull` instead. `upload` to a doc made of files replaces all its files with that one page (earlier versions stay; the `activate_doc` tool restores one), so use `push` for such docs.
- `download --output` must end in `.html`, and `template schema --output` in `.json`. The target is a new file or an existing regular file in a folder that already exists, inside the project folder, with no dot-folder or dot-file in its path (`.git/`, `.claude/`, `.env`). Otherwise the result is `invalid_output` and nothing is requested or written.
- Take the doc id, folder id, workspace id and `active_version` from the ViberDocs tools (`list_docs`, `search_docs`, `list_folders`, `list_workspaces`), never from guesses.

## Logging in

1. Run `login --json`. It returns `pending` at once. The CLI opens the approval page in the person's browser when it can (`browser` says whether it did); `--no-browser`, or the environment variable `VIBERDOCS_NO_BROWSER`, turns that off.
2. **Show the person the code and the link before you run anything else.** The result's `next_step` already contains both as two lines (`Code: ...` and `Link: ...`): relay them, even when the page opened, because the person checks the code against the approval page. The person chooses which workspaces the login covers and whether it may write, then approves.
3. Run `login --resume --json` with a timeout of at least 2 minutes: it waits up to 90 seconds for approval. If it still returns `pending`, follow its `next_step`: end your message with the same code and link, do no other work until the person says they approved, and run it again.
4. Do not start a second login while one is pending, and never copy a token or device code into a prompt or a command.

A login covers one workspace or all of the person's workspaces, read-only or read and write; `status` shows which. `read_only_login` means the login cannot publish or save templates: log out and log in again with Read & write. `workspace_mismatch` means the requested workspace differs from a one-workspace login: log out to change it.

## If someone else published first

A folder remembers the version it came from. If another editor published in the meantime, `push` ends with `doc_version_conflict` and **nothing was published**; there is no override, because it would replace their work. The result's `changed_here`, `changed_there` and `both` name the files each side changed (it also prints them as `changed here: file`, `changed there: file` and `both: file`), and `suggestion` is the `pull` to run.

1. Pull the live version into a new folder next to yours, with the `suggestion` (for example `pull --doc <doc_id> --dir <folder>-v<n>`).
2. Merge your changes into that new folder. Files only one side changed take that side's version; for a file in `both`, merge by hand, and when you and they changed the same element or sentence in different ways, stop and ask the user which to keep.
3. `push` the new folder. If it ends in `doc_version_conflict` again, stop and tell the user the doc is being edited by someone else right now.

An `upload` of one HTML file works as before: its `http_409` means nothing was published; download the live version into a different file, merge, and upload with its `active_version` as `--base-version`. For the merge details, call `get_guide` with topic `build_doc` and section `conflicts`.

## Templates

`<template.json>` is one JSON object with `name`, `description`, `category`, `package` (with `sample_doc` inside the package) and optionally `tags`. Call `get_guide` with topic `template_schema`, or run `template schema`, for the package shape, and `get_guide` with topic `author_template` for how to author one. `category` is one of `business`, `product`, `engineering`, `marketing`, `personal` or `data`.

- `template create` makes a private draft, usable at once; `--workspace` shares it into a workspace the user named. The result has the template's `handle` and `draft_revision`. If a create fails in a way that sending it again can fix (`network_error`, `http_429`, a 5xx), the error carries an `operation_id`: run the same command with `--resume <operation_id>` and the same file.
- `template update` needs the `handle` and the `draft_revision` you last read (the create result's, or `get_template`'s). Send the whole `package`, `sample_doc` included, from your own file, never `get_template`'s copy. `draft_revision_conflict` means the draft moved on: read it with `get_template`, merge, and update with the new revision.
- Publishing a template to the community library is not a CLI command. Use the `promote_template` tool, and only when the user asks.

## Results and exit codes

A success has `ok: true`. A failure has `ok: false`, a `code`, a `message` and `retryable`, and exits 1, except `invalid_usage`, which exits 2. Read the message: it names the next step. Do not retry a failure whose `retryable` is false.

| Code | What to do |
| --- | --- |
| `invalid_usage` | The command is malformed. The message is the usage line. |
| `unsafe_install`, `invalid_release` | The plugin's files are damaged or edited. Reinstall the plugin. |
| `unsafe_root` | Run from the project folder, not `/` or the home folder. |
| `login_unavailable` | CLI login is not switched on for this server. Use the draft tools for docs and `create_template` / `update_template` for templates. Do not retry. |
| `invalid_input`, `invalid_output` | The file, folder or path breaks the rules above (a symlink in a doc folder, a folder outside the project, a `pull --dir` that is not new or empty). Fix it; nothing was sent or written. |
| `invalid_state` | A folder's `.viberdocs.json` is not valid. Delete it and `pull` the doc again, or push the folder as a new doc. |
| `checks_failed` | The folder has error findings (printed, and in `findings`). Fix each, using its `fix`, and run `check` again. Nothing was published. |
| `doc_version_conflict` | Someone published first (see "If someone else published first"). Nothing was published. |
| `multi_file_doc` | `download` of a doc made of files. Use `pull`. |
| `edit_refused` | The server refused an edit; nothing was changed. |
| `invalid_file`, `file_changed` | The file is missing, empty, over 10 MiB, or changed while it was read. Retry with a stable file. |
| `reauth_required`, `login_expired`, `no_pending_login` | Log out, then log in again (or start a new login). |
| `network_error` | See "Choosing a path". For `upload` and `template create`, resume with the `operation_id`. For `template update`, call `get_template` first. |
| `http_401`, `http_403`, `http_404` | The login cannot do this, or the doc, folder or workspace is unavailable to it. Check ids and access; do not retry with wider access. |
| `http_402` | The workspace plan or quota does not permit publishing. Tell the user. |
| `http_409` | A version conflict (see above), or for templates a changed draft or an ownership change. Nothing was saved. |
| `http_413`, `http_422` | The server rejected the file. For a template, `problems` lists what to fix. |
| `http_429`, `http_500`, `http_502`, `http_503`, `http_504` | Retryable. Wait, then resume or run again. |
| `integrity_failed` | The download did not match the size or hash the server listed. Nothing was written; retry. |
| `no_active_version` | The doc has no active version. Pass `--version <n>`. |
| `lock_timeout` | Another command is using this project's login. Wait and retry. |
| `invalid_response`, `request_failed`, `operation_failed` | The server's answer was not one the CLI accepts, or the command failed in a way it does not name. Retry only if `retryable` is true; otherwise tell the user, and use the draft tools for docs. |
| `unsupported_host`, `unsafe_state`, `tracked_state` | The host or the `.viberdocs/` folder cannot hold a login safely (not macOS or Linux, wrong Node, unsafe permissions, or the state is tracked by git). Fix that, or use the draft tools. |
