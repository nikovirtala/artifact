# 0023. HTTP status codes, error body and the list limit

Status: Accepted (M2)

## Decision

Every error body is `{"error": "<code>", "message": "<text>", ...extra}`, where extra is every other field of the core error.

| Status | Code | When |
| --- | --- | --- |
| 400 | `bad_request` | Unreadable or malformed request: bad JSON, bad `If-Match`, header/body disagreement, bad query params (including `limit`, `version`), URL traversal on viewing routes (`../`, `%2e%2e`, `%2f`) |
| 401 | `unauthorized` | `ARTIFACT_TOKEN` set and the bearer token is missing or wrong (`WWW-Authenticate: Bearer`) |
| 403 | `forbidden` | Host or Origin guard (0027) |
| 404 | `not_found` | Unknown artifact, version, file or `/api` route |
| 409 | `version_conflict` | Stale `If-Match`/`if_version`, or retries exhausted (0015); extra `currentVersion` |
| 413 | `too_large` | Bytes only: 16 MiB per file, 64 MiB per publish; extra `limit`, `subject` (`file` or `publish`), `path?` |
| 422 | `invalid_request` | Schema issues, including malformed base64; extra Zod `issues` |
| 422 | `invalid_path` | Unsafe, reserved, duplicate or disallowed path; extra `path` |
| 422 | `invalid_input` | Valid JSON with a bad value: label > 60 chars, > 255 files, malformed id; extra `field`, `limit?` |
| 500 | `internal` | Unexpected error |

- Request bodies over 96 MiB (64 MiB as base64 plus JSON overhead) are cut off before parsing → 413 `too_large` `{subject: "publish", limit: 67108864}`.
- `GET /api/artifacts?limit=` defaults to 50 and accepts an integer 1..500 written in canonical form; anything else (including a repeated param) → 400. No pagination in v1.
- The list response is wrapped: `{"artifacts": [{id, title?, currentVersion, updatedAt, url}]}`, so fields can be added later without breaking clients.
- Core `list()` validates its own limit too (integer 1..500, else `invalid_input` `{field: "limit", limit: 500}`) and returns a `Result`. Without a limit it lists everything; the gallery uses that.
