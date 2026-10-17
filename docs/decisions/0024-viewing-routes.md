# 0024. Viewing routes

Status: Accepted (M2)

## Decision

- **Dispatch by Host.** A request on `<id>.localhost:<port>` is only ever subdomain viewing; `/api` and the gallery are not reachable there. On `localhost`, `127.0.0.1` or `[::1]`: `/api/*`, `GET /` (gallery), and path-mode viewing under `/a/<id>/`.
- **URL forms.** Current: `/` (subdomain) or `/a/<id>/` (path). Pinned: `/v/<n>/…` or `/a/<id>/v/<n>/…`. `/__artifact/*` is reserved for the platform (M3) and is 404 for now.
- **Directory index.** A path ending in `/` serves `<dir>/index.html`. A last segment without an extension (`/docs`) redirects to `/docs/` when `docs/index.html` exists in that version, else 404.
- **Redirects use 308.** `/v/3` → `/v/3/`, `/a/<id>` → `/a/<id>/`, `/a/<id>/v/3` → `/a/<id>/v/3/`, `/docs` → `/docs/`. 308 is permanent and keeps the method. `Location` is relative and keeps the query string. Redirects get `Cache-Control: no-store`, because whether `docs/index.html` exists can change on republish.
- **Plain 404.** Missing files, unknown or malformed ids (browsers lowercase hostnames, so case is not meaningful), unknown versions, non-canonical version numbers (`/v/0/`, `/v/01/`) and orphan versions all return `text/plain` `not found` with the security headers (0025).
- **Static read.** Viewing reads `www/` through `ArtifactService.readServed(id, {version?, path})`: pointer, committed-version check, path normalisation, one blob read, content type from the extension allowlist. No manifest read, so serving maps to S3 + CloudFront later.
- **Reserved publish paths.** A published file whose first segment is `v` or `__artifact` (case-insensitive) is rejected with 422 `invalid_path`, since those URLs are taken by pinned versions and the platform. The rule lives in `core/paths.ts`.
- **Traversal.** The raw request target is checked before routing (0027). `..`, `.`, encoded `%2e%2e`, encoded `/` or `\`, control characters, and undecodable escapes → 400.
