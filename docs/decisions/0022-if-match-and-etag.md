# 0022. `If-Match`, `if_version` and `ETag`

Status: Accepted (M2)

## Context

`PUT /api/artifacts/:id` takes an optional `If-Match: <version>` (spec). HTTP entity tags are quoted strings, but agents and `curl` users often send a bare number. MCP has no headers, so the body needs the same option.

## Decision

- `If-Match` accepts one version as a bare or quoted positive integer: `3` or `"3"` (surrounding whitespace allowed). `*`, lists (`"1", "2"`), weak tags (`W/"3"`), `0` and anything else → 400 `bad_request`.
- The body may carry `if_version` (positive integer). If both are present and differ → 400. The effective value becomes the core's `ifVersion`. A stale value → 409 `version_conflict` with `currentVersion`.
- `POST /api/artifacts` (create) accepts the same body and ignores `if_version`, as the core does (0015).
- `GET /api/artifacts/:id`, publish (`POST`, `PUT`) and rollback responses carry `ETag: "<currentVersion>"`, so a client can echo it back as `If-Match`.

## Consequences

The ETag is a version number, not a content hash. That is deliberate: it is what `If-Match` compares against, and it is unrelated to the store-derived pointer etag (0014).
