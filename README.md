# @nikovirtala/artifact

Local server that hosts HTML artifacts at stable URLs, keeps every publish as an immutable version, and live-reloads open tabs when an agent republishes. See [docs/00-plan.md](docs/00-plan.md) for the spec and [docs/decisions/](docs/decisions/) for decision records.

**Status: M2 (HTTP serving + JSON API).** `artifact serve` serves artifacts, a gallery and the JSON API. Live reload (M3), MCP (M4) and the client CLI commands (M5) are not done yet.

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
| `ARTIFACT_TOKEN` | unset | If set, `/api` requires `Authorization: Bearer <token>`. Viewing stays open. |

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

- **CSP.** A custom `--csp` must allow `'self'` scripts (`script-src 'self'`). Otherwise live reload, which arrives in M3, cannot load `/__artifact/reload.js`.
- **Safari.** Safari resolves `http://<id>.localhost:4400/` without `/etc/hosts` entries ([0010](docs/decisions/0010-safari-localhost.md)). If `*.localhost` does not resolve somewhere, use `http://localhost:4400/a/<id>/`, or start with `--isolation path`.
- **Path mode shares one origin.** Pages under `/a/<id>/` share storage (localStorage, cookies) with each other and can call `/api` on the same origin. Set `ARTIFACT_TOKEN` if that matters. Subdomain pages cannot call the API.

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
