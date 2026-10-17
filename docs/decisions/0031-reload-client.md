# 0031. Reload client

Status: Accepted (M3)

## Decision

- `src/http/reload-client.js` is plain browser JS in one arrow IIFE: no build, no globals on the page. It is served by the platform at `GET /__artifact/reload.js` on every allowed host (`<id>.localhost` and the main hosts), never from an artifact. It is read once when the app module loads.
- Response headers: `Content-Type: text/javascript; charset=utf-8`, `Cache-Control: no-cache` (a server upgrade takes effect at once), and the security headers of 0025. No token, like all viewing routes (0011, 0027).
- **Mode and pinning come from the page URL**, so the injected tag stays the same for current and pinned pages:
  - host `<id>.localhost` (valid ULID, any case) → subdomain mode, the path is relative to the version root;
  - otherwise a path `/a/<id>/…` → path mode;
  - anything else → do nothing.
  - pinned if the path below the artifact root starts with `v/<n>/` (`n` canonical, as the server requires). `v` is reserved as a first segment (0024), so `/docs/v/1/` is an ordinary current page.
- The loaded version is `data-version` on `document.currentScript`, read at load. A missing or invalid value makes the client inert.
- Not pinned: `new EventSource('/__artifact/events?id=<id>')`, root-relative, so it uses the page's own origin in both modes. On `published` with a version other than the loaded one, it closes the source and calls `location.reload()`. Malformed data is ignored. On `deleted`, see 0029.
- Tests run the real file in `node:vm` with a fake `document`, `location` and `EventSource`, instead of exporting test hooks from the browser script.

## Consequences

A custom `--csp` must allow `'self'` scripts and `connect-src 'self'`, or the client is blocked (README).
