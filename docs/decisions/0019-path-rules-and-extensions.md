# 0019. Path rules and disallowed extensions

Status: Accepted (M1)

## Context

The spec says: reject absolute paths, `..` segments, backslashes, NUL, and anything resolving outside the version directory; derive content types from a 20-extension allowlist. It does not say what happens to a file whose extension is not on the list.

## Decision

- `normalizePath` drops `.` segments and the empty segments left by repeated `/`. It rejects: empty paths, absolute paths, Windows drive prefixes (`c:`), backslashes, NUL and every other C0 control character or DEL, `..` segments, and trailing `/` (a directory). Accepted paths are idempotent under normalisation. A fast-check property shows they stay inside the version directory under both posix and native `path.resolve`.
- **Disallowed or missing extensions are rejected as `invalid_path`** for the whole publish, not silently dropped or served as `application/octet-stream`. An agent learns immediately which file was refused, and the server never hosts types it cannot label (`nosniff` is sent in M2). The list is exactly the spec's: `htm` and `jpeg` are not included, so `photo.jpeg` must be renamed. Extensions match case-insensitively (`APP.JS` is fine).
- Paths that differ only in case (`A.css` and `a.css`) are rejected as duplicates. The default local disk (macOS APFS) is case-insensitive and would merge them. Paths that become equal after normalisation (`./index.html` and `index.html`) are duplicates too.
- `index.html` must be present at the version root. Its absence is `invalid_path` with `path: "index.html"`.
- Percent-decoding is not done here. URL handling (`%2e%2e`) belongs to the HTTP layer (M2), which must decode before calling the core.

## Consequences

Adding an extension later means one line in `core/paths.ts`, plus a decision record if it widens what the server hosts.
