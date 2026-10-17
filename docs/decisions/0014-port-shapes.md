# 0014. S3-shaped ports and typed error results

Status: Accepted (M1)

## Context

The core must run unchanged on local disk now and on S3 (or DynamoDB for the pointer) in M6. The API and MCP layers need to map failures to status codes without catching exceptions.

## Decision

- `src/core/ports.ts` defines `BlobStore`, `PointerStore`, `Notifier`, `Clock` and `IdGen`. Storage ports take full string keys. The layout (`artifacts/<id>/…`) is built only in `core/paths.ts`, so adapters know nothing about artifacts.
- `BlobStore`: `get`, `put(key, body, { ifNoneMatch: "*" }?)`, `list(prefix, { delimiter }?)`, `delete`. `list` uses plain string prefixes and S3 `ListObjectsV2` grouping into `commonPrefixes`. The service uses that grouping to enumerate artifacts.
- `PointerStore`: `read` returns `{ body, etag }`; `write(key, body, { ifNoneMatch: "*" } | { ifMatch: etag })` covers create-if-absent and compare-and-swap; `delete`. Bodies are bytes and etags are opaque strings, which is the S3 `PutObject` + `If-Match` shape.
- A failed precondition is the value `{ ok: false, reason: "precondition_failed" }`. Adapters throw only for I/O failures and malformed keys.
- `Notifier` has only `notify(event)`. Subscribing is an adapter concern (the memory notifier has `subscribe`), because on AWS the browser subscribes to AppSync directly.
- `core/errors.ts` uses a `Result<T>` discriminated union. Errors are `version_conflict` (`currentVersion`), `not_found`, `invalid_path` (`path`) and `too_large` (`limit`, `subject`). The spec has no other error codes, so `too_large.subject` (`file`, `publish`, `file_count`, `label`) says which limit applies, and its `limit` is in bytes, files or characters. A label over 60 characters is therefore `too_large` with `subject: "label"`. Malformed or unknown ids are `not_found`.
- Erasable syntax only: string-literal unions, no enums, namespaces or parameter properties.
- `src/index.ts` now exports the service, error and port types, and the local adapters (as foreseen in 0006).

## Update (M2)

- New error `invalid_input` (`field`, `limit?`) for values that are well-formed but unacceptable. HTTP maps it to 422 (0023).
- A label over 60 characters (`field: "label"`) and more than 255 files (`field: "files"`) are now `invalid_input`, not `too_large`.
- `too_large` is for bytes only; `subject` narrows to `file` | `publish`.
- Malformed ids are `invalid_input` with `field: "id"` and a message pointing to `artifact_list`. Uppercase ids are lowercased before lookup. Unknown well-formed ids stay `not_found`.
- `list` validates its `limit` (integer 1..500, else `invalid_input` `field: "limit"`) and returns a `Result`.
- `src/index.ts` exports nothing; the package is CLI-only in v1 (0006).

## Consequences

The S3 adapter maps 412 to `precondition_failed` and runs the same contract suite (`test/contract/blob-store.contract.ts`). Keys that S3 allows but a filesystem cannot hold (`a` and `a/b` at the same time) never occur in the layout, and the contract does not test them.
