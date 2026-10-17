# 0025. Security headers and CSP

Status: Accepted (M2)

## Decision

- **Artifact pages** (and viewing 400/403/404 responses) always get `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cross-Origin-Opener-Policy: same-origin`.
- **No CSP on artifact pages by default**, since artifacts may load from CDNs. `--csp "<policy>"` or `ARTIFACT_CSP` sends exactly that `Content-Security-Policy` header on artifact pages. A custom policy must allow `'self'` scripts, or the reload client (M3) is blocked; the README says so.
- **Content-Type** comes from the extension allowlist (0019); nothing else is served.
- **Caching.** Current-version files: `Cache-Control: no-cache`. Pinned `/v/<n>/` files are immutable: `public, max-age=31536000, immutable`.
- **Gallery:** the same three headers, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` and `Cache-Control: no-store`.
- **API file reads** (`GET /api/artifacts/:id/files/*`) return raw `src/` bytes on the API origin, so they get `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. HTML returned there never runs.
