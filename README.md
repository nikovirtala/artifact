# @nikovirtala/artifact

Local server that hosts HTML artifacts at stable URLs, keeps every publish as an immutable version, and live-reloads open tabs when an agent republishes. See [docs/00-plan.md](docs/00-plan.md) for the spec and [docs/decisions/](docs/decisions/) for decision records.

**Status: M4 (MCP).** `artifact serve` serves artifacts, a gallery, the JSON API and an MCP endpoint for agents, and open tabs reload when an artifact is republished. The client CLI commands, including the `artifact mcp` stdio bridge (M5), are not done yet.

## Serve

```sh
node src/cli/main.ts serve                # http://localhost:4400/, storage in ~/.artifacts
node src/cli/main.ts serve --help
```

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--port <n>` / `ARTIFACT_PORT` | `4400` | Port. If it is taken, the server exits; it never picks another. |
| `--root <dir>` | `~/.artifacts` | Storage root. One server per root (`<root>/.lock`). |
| `--host <addr>` | `127.0.0.1` + `::1` | Bind only this address. A non-loopback address requires `ARTIFACT_TOKEN`. |
| `--isolation subdomain\|path` | `subdomain` | URL style returned by the API and the gallery. |
| `--csp <policy>` / `ARTIFACT_CSP` | none | `Content-Security-Policy` sent on artifact pages. |
| `ARTIFACT_TOKEN` | unset | If set, `/api` and `/mcp` require `Authorization: Bearer <token>`. Viewing stays open. |

URLs:

- `http://<id>.localhost:4400/`: current version, one browser origin per artifact. Pinned: `/v/<n>/`.
- `http://localhost:4400/a/<id>/`: path mode, always available. Pinned: `/a/<id>/v/<n>/`.
- `http://localhost:4400/`: gallery.

Publish with the API:

```sh
curl -X POST http://localhost:4400/api/artifacts -H 'content-type: application/json' \
  -d '{"title":"Hello","files":{"index.html":"<h1>hi</h1>"}}'
```

The API routes are in the spec ("HTTP: JSON API"). The details are in ADRs [0021](docs/decisions/0021-api-file-encoding.md) (file encoding: a string, or `{"base64": …}`), [0022](docs/decisions/0022-if-match-and-etag.md) (`If-Match`/`ETag`) and [0023](docs/decisions/0023-http-errors-and-list-limit.md) (errors).

Notes:

- **CSP.** A custom `--csp` must allow `'self'` scripts and connections (`script-src 'self'; connect-src 'self'`, or `default-src 'self'`). Otherwise live reload cannot load `/__artifact/reload.js` or open its event stream.
- **Safari.** Safari resolves `http://<id>.localhost:4400/` without `/etc/hosts` entries ([0010](docs/decisions/0010-safari-localhost.md)). If `*.localhost` does not resolve somewhere, use `http://localhost:4400/a/<id>/`, or start with `--isolation path`.
- **Path mode shares one origin.** Pages under `/a/<id>/` share storage (localStorage, cookies) with each other and can call `/api` on the same origin. Set `ARTIFACT_TOKEN` if that matters. Subdomain pages cannot call the API.

## MCP (agents)

With the server running, connect Claude Code:

```sh
claude mcp add --transport http artifacts http://localhost:4400/mcp
# with ARTIFACT_TOKEN set:
claude mcp add --transport http artifacts http://localhost:4400/mcp --header "Authorization: Bearer $ARTIFACT_TOKEN"
```

Any MCP client that speaks Streamable HTTP can use `http://localhost:4400/mcp`. The endpoint is stateless (no sessions) and has the same Origin and token guards as `/api`.

| Tool | Input | Result |
| --- | --- | --- |
| `artifact_publish` | `files` and/or `file_path`, `id?`, `title?`, `label?`, `if_version?` | `{id, version, url}`. Omit `id` to create; pass it to update in place (same URL, open tabs reload). |
| `artifact_list` | `limit?` (1..500, default 50) | `{artifacts: [{id, title?, currentVersion, updatedAt, url}]}`. Find an id before updating. |
| `artifact_read` | `id`, `version?`, `path?` (default `index.html`) | `{id, version, path, contentType, content}`: the file as published, without the reload tag. |
| `artifact_rollback` | `id`, `version` | `{id, version, url}`: current moves back to that version. |
| `artifact_delete` | `id`, `confirm: true` | `{ok: true}`. Only when the user asks. |

`files` uses the API encoding: a string is UTF-8, `{"base64": "…"}` is binary. `file_path` is the absolute path of a local `.html` file, published as `index.html`; supporting files are only included if they are also listed in `files`. It is refused on requests from browser pages. Errors come back as tool errors (`isError`) with the API's `{"error", "message", …}` object. See ADRs [0033](docs/decisions/0033-mcp-transport-and-sdk.md)–[0036](docs/decisions/0036-mcp-tool-descriptions.md).

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
