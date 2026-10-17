# 0027. Listeners, `--host`, token and request guards

Status: Accepted (M2)

## Decision

**Listeners.**
- Without `--host`, bind `127.0.0.1` and `::1` (IPv6-only socket) on the port. A failure on `127.0.0.1` is fatal. If `::1` fails with `EADDRNOTAVAIL` or `EAFNOSUPPORT`, warn and continue IPv4-only.
- `EADDRINUSE` on either address → the port message from 0009, exit non-zero.
- `--host <addr>` replaces both with exactly that address. Loopback is `localhost`, `::1` or `127.0.0.0/8`. Non-loopback needs `ARTIFACT_TOKEN` (0011): without it the server refuses to start, with it a warning is printed.

**Guards, in order** (all routes first, then `/api/*`):
1. **Host** (all routes). Host must be `localhost`, `127.0.0.1`, `[::1]` or `<id>.localhost` (valid ULID, case-insensitive) with the configured port, else 403 plain text. Port 80 also accepts the port-less form.
2. **Traversal** (all routes). Checked on the raw request target, because `@hono/node-server` (via `new URL()`) normalises `..` and `%2e%2e` before Hono sees the path. Each segment is percent-decoded: a decode error, a decoded `.` or `..`, or a decoded `/`, `\`, NUL or other control character → 400. Under `/api` the body is JSON `bad_request`.
3. **Origin** (`/api`, later `/mcp`). If `Origin` is present it must be exactly `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>`. Anything else, explicitly including `http://<id>.localhost:<port>` and `null`, → 403 JSON `forbidden`. No CORS headers are sent.
4. **Token** (`/api`, later `/mcp`). If `ARTIFACT_TOKEN` is set: `Authorization: Bearer <token>` (scheme case-insensitive), compared with `timingSafeEqual` over SHA-256 digests; else 401 with `WWW-Authenticate: Bearer`.

## Consequences

- Artifact pages on `<id>.localhost` cannot call the API: their requests carry their own Host (served as viewing) or a rejected Origin.
- Path-mode pages share the `localhost:<port>` origin, so their same-origin requests to `/api` pass the Origin guard. Set `ARTIFACT_TOKEN` if that matters.
- The Host guard does not add the `--host` address. Remote clients must send a `localhost` Host (for example through an SSH tunnel). This keeps the owner's Host rule literal; revisit if remote use matters.
