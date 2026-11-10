# ViberDocs plugin for Claude

ViberDocs turns an HTML file into a shared, versioned doc at a link. This plugin lets Claude publish, update and download those docs and save document templates, and it connects the ViberDocs MCP server so Claude can browse your workspaces, folders and docs.

It has two parts:

- **A skill with a command-line tool.** In a Claude session with a shell, the `viberdocs` skill runs a small Node program bundled in this plugin (`skills/viberdocs/scripts/viberdocs.mjs`) to sign in, upload a doc's HTML, download a version and save template drafts, so the HTML never passes through the conversation. The skill pre-approves that one script and nothing else.
- **The ViberDocs connector.** The plugin's `.mcp.json` points at the ViberDocs MCP server, `https://viberdocs.com/mcp`, the same connector claude.ai offers.

## Install

**Claude Code** (2.1.275 or newer):

```
/plugin install viberdocs --marketplace Waterbear-AI/viberdocs-plugin
```

Or add the marketplace first, then install by name:

```
/plugin marketplace add Waterbear-AI/viberdocs-plugin
/plugin install viberdocs@waterbearai
```

Then run `/mcp` and sign in to ViberDocs if it needs authentication. In Claude Code the plugin's server replaces a claude.ai ViberDocs connector, so it asks for its own sign-in once.

**Claude Code's sandbox.** If you turned the sandbox on, allow `viberdocs.com` when Claude asks, or add it to `sandbox.network.allowedDomains` in your settings.

**Claude Desktop and Cowork.** Open Customize, then Plugins, then Add, then Add marketplace, and enter `Waterbear-AI/viberdocs-plugin`. Install ViberDocs, then connect it on the plugin's Connectors tab. In chat the plugin adds only the connector for now.

**Updates.** Marketplaces other than Anthropic's do not update by default. Turn on auto-update under `/plugin`, then Marketplaces, or run:

```
claude plugin update viberdocs@waterbearai
```

**Claude only, for now.** The skill's commands rely on a Claude Code variable that Codex does not define. Codex users add the ViberDocs connector instead.

## What the plugin runs, sends and fetches

The command-line tool needs Node.js 22 or 24 on macOS, Linux or WSL. It does only this:

- It talks to one host, `https://viberdocs.com`, and no other. It sends that host your sign-in requests, the files you publish, and the doc, folder and workspace ids you name, and it downloads the docs and template schema you ask for. The release file beside the script (`plugin-release.json`) names that host, and the script refuses any host that is not on its built-in list. The list also holds ViberDocs' test server (`https://test.viberdocs.com`) and a local development address (`https://localhost:8543`), for builds made by ViberDocs' own developers; this release never uses them.
- It uploads only the doc folder, HTML file or template file you name, and only from inside your project folder. It will not read a file under a dot-folder (such as `.git` or `.viberdocs`), outside the project, or through a symlink, and it skips dotfiles inside a doc folder.
- It writes a doc into a folder you name inside your project folder (`pull`), which must be new or empty and may not sit under a dot-folder, with a `.viberdocs.json` beside the files that remembers which doc and version the folder came from. It downloads one HTML file only into the file you name, which must end in `.html`, and saves the public template schema only to a `.json` file named the same way.
- It opens your browser once per sign-in, to the ViberDocs approval page (`https://viberdocs.com/api/oauth/device?user_code=...`), unless you turn that off with `--no-browser` or `VIBERDOCS_NO_BROWSER`. You approve the login there and choose which workspaces it covers and whether it may write. The `preview` command also opens the link to your draft (a short-lived address of the form `https://pv-<id>.vibercontent.com/`, ViberDocs' content domain) unless you pass `--no-open`. To open a page it runs the system's own launcher, `open` on macOS or `xdg-open` on Linux, with the checked link as its only argument and no shell. It opens nothing over SSH, in CI, or on Linux without a display; then it only prints the link.
- It runs `git ls-files` in your project to refuse to keep a login in a folder that git tracks.
- It keeps its login and unfinished operations in `<project>/.viberdocs/state`, readable only by you, with a local ignore file so git skips the folder. It never prints a token.
- It has no dependencies and runs nothing it downloads.

The plugin also connects the ViberDocs MCP server at `https://viberdocs.com/mcp`. It signs in with its own OAuth login to ViberDocs, and Claude Code asks you to approve its tools as it does for any connector. Its tools act on your ViberDocs account:

- read: list and search workspaces, folders, docs and a doc's files, read the build guide, styles, templates, doc records and sign-off decisions, and check on a bulk operation;
- write docs: start a draft of a doc, edit its files, preview it at a short-lived link, and publish it as the doc's next version, or make an earlier version live again;
- organize: create workspaces and folders, and move, copy, trash and restore docs and folders (after a preview of what each would affect);
- templates and styles: create and update template drafts, save styles, and promote a template to ViberDocs' public community library, which a moderator reviews;
- records and transfers: add and update a doc's records, and mint short-lived transfer tokens for uploads from a shell without the plugin.

## Using it

Ask Claude to publish an HTML file to ViberDocs, to update a doc, to download one so you can edit it, or to save a template. The first time, Claude shows you a code and a link, you approve the sign-in in your browser, and Claude carries on.

## Privacy, terms and support

- [Privacy policy](https://viberdocs.com/privacy.html)
- [Terms of service](https://viberdocs.com/terms.html)
- [Support and issues](https://github.com/Waterbear-AI/viberdocs-plugin/issues)

## License

MIT. See [LICENSE](LICENSE).
