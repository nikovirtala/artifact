# 0043. `artifact publish` and `artifact read`

Status: Accepted (M5)

## Context

`publish` turns local files into the API body (0021); `read` must return exactly what was published so edit → republish round-trips work.

## Decision

- **publish `<file or dir>`.** A file must be `.html`/`.htm` (case-insensitive) and is sent as `index.html` alone (as `file_path`, 0035). A directory sends every regular file below it under its `/`-separated relative path. Names starting with `.` (files and directories) are skipped, and so are symlinks (with a stderr note), so nothing outside the directory is read. Files whose extension is not on the server's allowlist (`contentTypeFor` in `src/core/paths.ts`, the same list, 0019) are skipped too, so a `README` or `.ts` next to the page does not fail the publish; stderr gets `skipped <n> file(s) with unsupported types: <paths>`. A directory with nothing left, or without a top-level `index.html`, is an `invalid_input` error (exit 1) before any request. The server stays strict and applies its usual rules (path rules, limits); its errors are printed as-is.
- **Encoding** is shared with `artifact_read` (`encodeFileValue` in `src/schemas.ts`): a file whose content type (from `src/core/paths.ts`) is text, JSON or SVG and whose bytes are valid UTF-8 is sent as a string; everything else is sent as `{"base64": …}`.
- **Create vs update.** Without `--id`: `POST /api/artifacts` with the derived project (0042), `--title`, `--label`, and `open: false` when `--no-open` is given (0040). With `--id`: `PUT /api/artifacts/<id>`. `--if-version <n>` adds `If-Match: <n>` and is a usage error without `--id`. stdout gets the URL; stderr gets `created <id> (version 1, opened in the browser)` or `updated <id> to version <n>`. `--json` prints the API response body unchanged, plus `skipped: [paths]` only when files were skipped.
- **read `<id>`.** It prints the raw bytes of `--path` (default `index.html`) of `--version` (default current) to stdout, from `GET /api/artifacts/<id>/files/<path>?version=`. That is the `src/` file, without the reload tag. `--json` prints meta and versions (`GET /api/artifacts/<id>`).
- **read `--out <dir>`** writes every file of the version under `<dir>`, creating directories and overwriting files of the same name, and prints `wrote <n> files of <id> version <v> to <dir>`. A path that would resolve outside `<dir>` is an error. `artifact publish <dir> --id <id>` then republishes the edit.
- **New API route** for `--out`: `GET /api/artifacts/:id/versions/:version` returns the version's manifest `{id, version, createdAt, label?, files: [{path, size, sha256, contentType}]}` (core `readManifest`; committed versions only, else `not_found`; a malformed version is 400 `bad_request`). It is read-only and behind the same guards as the rest of `/api`, and is kept as built (owner decision) and listed in the spec's API table.
- `--json`, `--path` and `--out` are mutually exclusive.

## Consequences

`read` without `--json` is byte-exact and is safe to redirect into a file. The manifest route is the only API addition in M5, and MCP is unchanged.
