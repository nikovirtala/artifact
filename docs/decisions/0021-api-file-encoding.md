# 0021. API file encoding and the shared Zod schema

Status: Accepted (M2)

## Context

The spec says the `files` map holds "base64 or utf8" without saying how a client marks which one it sent. A heuristic (try base64, else text) would corrupt text that happens to be valid base64.

## Decision

- Each `files` value is either a plain JSON string (UTF-8 text) or `{"base64": "<data>"}` (binary). Nothing else is accepted.
- The body schemas live in one Zod module, `src/schemas.ts`, outside `core/`. The HTTP API uses it now and the MCP tools reuse it in M4.
  - `PublishBodySchema`: `{title?, label?, files, if_version?}`; `RollbackBodySchema`: `{version}`.
  - Objects are strict, so an unknown key such as `if_verison` is an error instead of being ignored.
  - Base64 is checked with Zod's `z.base64()`. Malformed base64 is a schema issue → 422 `invalid_request` (issue path `files.<path>.base64`).
- `decodeFiles` turns the validated map into the core's `Record<string, string | Uint8Array>`.

## Consequences

Clients must wrap binary files explicitly. Text stays human-readable in requests and in logs.
