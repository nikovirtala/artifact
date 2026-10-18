# @nikovirtala/artifact

Local server that hosts HTML artifacts at stable URLs, keeps every publish as an immutable version, and live-reloads open tabs when an agent republishes. See [docs/00-plan.md](docs/00-plan.md) for the spec and [docs/decisions/](docs/decisions/) for decision records.

**Status: M5 (CLI + polish): v1 complete, pending the owner's acceptance.** `artifact serve` serves artifacts, a gallery, the JSON API and an MCP endpoint for agents, opens new artifacts in the browser, and open tabs reload when an artifact is republished. The client commands publish, list, read, open, roll back and delete artifacts, `artifact mcp` bridges stdio MCP clients, and `artifact init` writes the agent instructions.

## Quick start

Requires Node 24.

```sh
npx @nikovirtala/artifact serve        # keep running: http://localhost:4400/
claude mcp add --scope user --transport http artifacts http://localhost:4400/mcp
npx @nikovirtala/artifact init --global
```

The second line connects Claude Code once per machine. The third writes the agent instructions to `~/.claude/CLAUDE.md` (see [MCP](#mcp-agents) for why they are needed). Then ask Claude for an HTML page: it publishes here and the page opens in your browser.

From a clone:

```sh
pnpm install
node src/cli/main.ts serve
node src/cli/main.ts publish page.html   # in another terminal; prints the URL
```

## CLI

Every command has `--help`. Client commands talk to the server at `--server <url>`, `ARTIFACT_SERVER` or `http://localhost:4400`, and send `Authorization: Bearer $ARTIFACT_TOKEN` when `ARTIFACT_TOKEN` is set. They only use the API, never the storage directly.

| Command | Flags | Does |
| --- | --- | --- |
| `artifact serve` | `--port`, `--root`, `--host`, `--isolation`, `--csp`, `--no-open` | Run the server (see [Serve](#serve)). |
| `artifact publish <file or dir>` | `--id`, `--if-version <n>` (with `--id`), `--title`, `--label`, `--project` / `--no-project`, `--no-open`, `--json`, `--server` | Create an artifact, or add a version with `--id`, and print the URL. A file must be `.html` (or `.htm`) and becomes `index.html`. A directory needs `index.html`; names starting with `.`, symlinks and file types the server does not accept (such as `README` or `.ts`) are skipped, and the skipped types are listed on stderr. |
| `artifact list` | `--project` / `--all`, `--limit <n>`, `--json`, `--server` | List artifacts, newest first. By default only the current repository's project (derived from git as agents derive it); the first line names the filter, and stderr says how many artifacts it hid (`3 more in other projects (or without a project); use --all`). |
| `artifact read <id>` | `--version <n>`, `--path <path>` / `--out <dir>` / `--json`, `--server` | Print a file exactly as published (default `index.html` of the current version). `--out` writes every file of the version; edit them and republish with `artifact publish <dir> --id <id>`. |
| `artifact open <id>` | `--version <n>`, `--json`, `--server` | Print the URL (pinned with `--version`) and open it in the browser, unless `BROWSER=none`. |
| `artifact rollback <id> <version>` | `--json`, `--server` | Make an earlier version current again and print the URL. |
| `artifact rm <id>` | `--yes`, `--json`, `--server` | Delete an artifact and all its versions. On a terminal it shows `Delete "<title>" (<id>, <n> versions)? [y/N]`; scripts must pass `--yes`. |
| `artifact init` | `--global`, `--project`, `--deny-builtin`, `--dry-run`, `--server` | Write the agent instructions (see [MCP](#mcp-agents)). |
| `artifact mcp` | `--server` | stdio MCP bridge to the running server's `/mcp`. |

Output is human-readable; `--json` prints the API response (`open` prints `{id, url, opened}`, `rm` prints `{"ok": true}`, `publish` adds `skipped` when it skipped files). Errors go to stderr as `error: <code>: <message>`; with `--json` they go to stderr as one JSON line in the API's shape, `{"error": "<code>", "message": "…", …}`. Usage errors are always the message plus usage. Exit codes: `0` ok, `1` error (including API errors such as `version_conflict` and no server answering), `2` usage error. Details: ADRs [0041](docs/decisions/0041-cli-client-conventions.md)–[0046](docs/decisions/0046-artifact-init.md).

## Serve

```sh
npx @nikovirtala/artifact serve           # http://localhost:4400/, storage in ~/.artifacts
npx @nikovirtala/artifact serve --help
```

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--port <n>` / `ARTIFACT_PORT` | `4400` | Port. If it is taken, the server exits; it never picks another. |
| `--root <dir>` | `~/.artifacts` | Storage root. One server per root (`<root>/.lock`). |
| `--host <addr>` | `127.0.0.1` + `::1` | Bind only this address. A non-loopback address requires `ARTIFACT_TOKEN`. |
| `--isolation subdomain\|path` | `subdomain` | URL style returned by the API and the gallery. |
| `--csp <policy>` / `ARTIFACT_CSP` | none | `Content-Security-Policy` sent on artifact pages. |
| `ARTIFACT_TOKEN` | unset | If set, `/api` and `/mcp` require `Authorization: Bearer <token>`. Viewing stays open. |
| `--no-open` / `ARTIFACT_OPEN=0` / `BROWSER=none` | open | Do not open new artifacts in the browser. Also skipped over SSH (`SSH_CONNECTION`), on Linux without `DISPLAY`/`WAYLAND_DISPLAY`, and with a non-loopback `--host`. |
| `ARTIFACT_OPENER_LOG=<file>` | unset | Write opened URLs to this file instead of launching a browser (for tests and CI). Applies to `serve` and `artifact open`. |

URLs:

- `http://<id>.localhost:4400/`: current version, one browser origin per artifact. Pinned: `/v/<n>/`.
- `http://localhost:4400/a/<id>/`: path mode, always available. Pinned: `/a/<id>/v/<n>/`.
- `http://localhost:4400/`: gallery.

Publish with the API:

```sh
curl -X POST http://localhost:4400/api/artifacts -H 'content-type: application/json' \
  -d '{"title":"Hello","files":{"index.html":"<h1>hi</h1>"}}'
```

A publish that creates an artifact opens it in your default browser; the response says `"opened": true`. Pass `"open": false` in the body to skip that for one call. Updates and rollbacks never open a tab: the open one reloads ([0040](docs/decisions/0040-auto-open-new-artifacts.md)).

The API routes are in the spec ("HTTP: JSON API"). The details are in ADRs [0021](docs/decisions/0021-api-file-encoding.md) (file encoding: a string, or `{"base64": …}`), [0022](docs/decisions/0022-if-match-and-etag.md) (`If-Match`/`ETag`) and [0023](docs/decisions/0023-http-errors-and-list-limit.md) (errors).

Notes:

- **CSP.** A custom `--csp` must allow `'self'` scripts and connections (`script-src 'self'; connect-src 'self'`, or `default-src 'self'`). Otherwise live reload cannot load `/__artifact/reload.js` or open its event stream.
- **Safari.** Safari resolves `http://<id>.localhost:4400/` without `/etc/hosts` entries ([0010](docs/decisions/0010-safari-localhost.md)). If `*.localhost` does not resolve somewhere, use `http://localhost:4400/a/<id>/`, or start with `--isolation path`.
- **Orphan sweep.** On startup, `serve` deletes uncommitted versions and folders without `meta.json` left by a crash, once they are at least 10 minutes old; committed versions are never touched ([0047](docs/decisions/0047-orphan-sweep.md)).
- **Path mode shares one origin.** Pages under `/a/<id>/` share storage (localStorage, cookies) with each other. No web page can call `/api` or `/mcp`: requests with an `Origin` header or a `Sec-Fetch-Site` other than `none` get 403 ([0037](docs/decisions/0037-no-browser-requests-to-api-and-mcp.md)). Use curl, the CLI or an MCP client.

## MCP (agents)

With the server running, connect Claude Code:

```sh
claude mcp add --scope user --transport http artifacts http://localhost:4400/mcp
# with ARTIFACT_TOKEN set:
claude mcp add --scope user --transport http artifacts http://localhost:4400/mcp --header "Authorization: Bearer $ARTIFACT_TOKEN"
```

Then tell the agent to use it. **This step is required in Claude Code:** its built-in `Artifact` tool takes priority over any MCP tool description, so without the instruction Claude publishes to claude.ai instead. Paste this into `~/.claude/CLAUDE.md` (every project), a project's `CLAUDE.md`, or `AGENTS.md`:

```md
For HTML pages, mock-ups, visualizations, reports, dashboards and "artifacts", use the `artifacts` MCP server (`artifact_publish`) instead of the built-in Artifact tool, and give me the URL. Reuse ids via `artifact_list` instead of creating duplicates. Pass `project` on every call, derived as the tool describes (`git remote get-url origin`, else `local:` + the git toplevel, else `local:` + the working directory).
```

If Claude still reaches for the built-in tool, block it in `~/.claude/settings.json` with `{"permissions": {"deny": ["Artifact"]}}` (deny rules always win; not yet verified for this tool, and it disables the built-in feature everywhere until removed). `artifact init --global --deny-builtin` adds it for you.

To pin the project, add a line such as:

```md
For this codebase, pass exactly `project: "github.com/you/repo"` on every artifacts tool call.
```

`artifact init` writes the snippet and this line for the current repository into its `CLAUDE.md` and/or `AGENTS.md`; `artifact init --global` writes the snippet alone to `~/.claude/CLAUDE.md`. Re-running it updates the block in place.

Any MCP client that speaks Streamable HTTP can use `http://localhost:4400/mcp`. The endpoint is stateless (no sessions) and has the same browser and token guards as `/api`. For clients that only launch stdio servers, `artifact mcp` forwards stdio to the running server ([0045](docs/decisions/0045-stdio-mcp-bridge.md)):

```sh
claude mcp add --scope user artifacts -- npx @nikovirtala/artifact mcp
```

| Tool | Input | Result |
| --- | --- | --- |
| `artifact_publish` | `files` and/or `file_path`, `id?`, `title?`, `label?`, `if_version?`, `project?` | `{id, version, url, project?, opened}`. Omit `id` to create (opens in the browser); pass it to update in place (same URL, open tabs reload). |
| `artifact_list` | `limit?` (1..500, default 50), `project?`, `all?` | `{artifacts: [{id, title?, project?, currentVersion, updatedAt, url}]}`. Find an id before updating. |
| `artifact_read` | `id`, `version?`, `path?` (default `index.html`) | `{id, version, path, contentType, content}`: the file as published, without the reload tag. |
| `artifact_rollback` | `id`, `version` | `{id, version, url}`: current moves back to that version. |
| `artifact_delete` | `id`, `confirm: true` | `{ok: true}`. Only when the user asks. |

`files` uses the API encoding: a string is UTF-8, `{"base64": "…"}` is binary. `file_path` is the absolute path of a local `.html` file, published as `index.html`; supporting files are only included if they are also listed in `files`. Errors come back as tool errors (`isError`) with the API's `{"error", "message", …}` object. See ADRs [0033](docs/decisions/0033-mcp-transport-and-sdk.md)–[0040](docs/decisions/0040-auto-open-new-artifacts.md).

**Projects.** Every artifact can belong to the codebase it was made in, so an agent sees only that project's artifacts. The agent passes `project` (a git remote URL, or `local:<absolute path>` without a remote); the server normalises it, so `git@github.com:you/repo.git` and `https://github.com/You/repo` are the same project, `github.com/you/repo`. It is set when the artifact is created and never changes. `artifact_list` with `project` returns only that project's artifacts; `all: true`, or no `project`, returns everything, including artifacts made before projects existed. It is a filter, not a permission: any id can still be read or updated. The gallery shows each artifact's project and filters with `http://localhost:4400/?project=github.com/you/repo` ([0039](docs/decisions/0039-project-identifier-and-filtering.md)).

## Live reload

A tab open on the current URL reloads within a second of a publish or rollback to that id. Pinned `/v/<n>/` tabs never reload. If the artifact is deleted, open tabs show a small "This artifact was deleted." banner instead.

How it works: each served HTML page carries `<script src="/__artifact/reload.js" data-version="<n>" defer>`, added at publish time. On current-version pages the script opens `EventSource('/__artifact/events?id=<id>')`. The server sends the current version on every connect, then a `published` event on each publish or rollback, and the page reloads when the version differs from its own. A tab that missed a publish (server restart, dropped connection) therefore catches up when it reconnects. See ADRs [0028](docs/decisions/0028-sse-handshake-and-reconnect.md)–[0032](docs/decisions/0032-events-unknown-id.md).

## Development

Requires [mise](https://mise.jdx.dev) (pins Node 24 and pnpm via `mise.toml`).

```sh
mise install
pnpm install
pnpm check                    # typecheck (tsc 7) + lint (biome) + test (node:test)
node src/cli/main.ts --help   # runs TypeScript directly, no build step
pnpm build                    # emit dist/ for the npm package
pnpm format                   # apply biome formatting and fixes
```

## License

[MIT](LICENSE)
