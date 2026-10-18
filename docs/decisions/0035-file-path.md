# 0035. `file_path` in `artifact_publish`

Status: Accepted (M4)

## Context

The spec lets `artifact_publish` take `file_path` (a local HTML file) or a `files` map, with "sibling files referenced by relative paths included only if listed in `files`", and rejects `file_path` on AWS.

## Decision

- **Absolute paths only.** A relative path → `invalid_input` (`field: "file_path"`). The server's working directory is not the agent's, so a relative path would silently name the wrong file.
- **`.html` or `.htm` only** (case-insensitive), else `invalid_input`. The file is published as `index.html`, whatever its name.
- **One file is read.** Supporting files are never read from disk. They are included only if the agent passes them in `files` (inline content, as usual). `file_path` and `files` combine: `files` adds the supporting files, and must not contain `index.html` itself (`invalid_input`, "pass only one"). `files` is optional when `file_path` is given; with neither, `invalid_request`.
- **Errors.** A missing, unreadable or non-regular file → `invalid_input` with the errno code (`ENOENT`, …). The size is checked with `stat` before reading: over 16 MiB → `too_large` `{subject: "file", path: "index.html"}`. After that, the core applies every usual rule to the combined files (path rules and traversal for `files` keys, per-file and per-publish sizes, file count).
- **Where.** `src/mcp/file-path.ts`, in the MCP adapter. The core still never imports `node:fs` (0004).
- **Not from browser pages.** A request carrying `Origin` or `Sec-Fetch-Site` came from a web page, and its `file_path` → `invalid_input`: "file_path is not accepted from browser pages; …". Path-mode artifact pages (`/a/<id>/`, mounted in every isolation mode) are same-origin with `/mcp` and pass the Origin guard (0027), so without this a hostile page could publish, then read, any local `.html` file. Non-browser MCP clients send neither header. `Sec-Fetch-Mode` does not count: Node's `fetch` sends `Sec-Fetch-Mode: cors`, so Node-based agents would be refused. Inline `files` stay available to every caller.
- **Disabling.** `AppConfig.allowFilePath` / `McpConfig.allowFilePath` (default `true`). With `false`, `file_path` → `invalid_input`: "file_path is not supported by this server; send the page inline as files['index.html']", and the tool description says so. The input schema stays the same, as the spec wants for AWS. The local CLI has no flag for it.

## Consequences

A non-browser MCP client can make the server read any `.html` file the server user can read and publish it to loopback viewers. That is the same trust the local agent already has; with `--host` off loopback, `ARTIFACT_TOKEN` is required (0011) before `/mcp` can be called at all. Artifact pages can still call the other tools from path-mode URLs, as they can call `/api` (0027), but they cannot reach the disk.

## Update (M4 follow-up)

The "Not from browser pages" rule moved to the guards: every request with `Origin` or a `Sec-Fetch-Site` other than `none` gets 403 on `/mcp` before any tool runs ([0037](0037-no-browser-requests-to-api-and-mcp.md)), so the adapter no longer checks it. Path-mode pages can no longer call any tool.
