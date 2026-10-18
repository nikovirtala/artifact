# 0037. Browser requests to `/api` and `/mcp` are refused

Status: Accepted (M4 follow-up). Replaces the Origin rule of 0027 and the `file_path` browser rule of 0035.

## Context

Path-mode artifact pages (`http://localhost:<port>/a/<id>/`) are mounted in every isolation mode, so they are same-origin with `/api` and `/mcp`. Their `fetch` calls carry `Origin: http://localhost:<port>`, which the Origin guard (0027) allowed. Without `ARTIFACT_TOKEN`, a published page could therefore delete, overwrite or roll back any artifact, or publish through `/mcp`. Nothing legitimate calls these endpoints from a web page: the gallery is server-rendered and read-only, and the clients are the CLI, scripts and MCP clients.

## Decision

- `/api` and `/mcp` refuse every request that carries an `Origin` header (any value, including `null`) or a `Sec-Fetch-Site` header with a value other than `none`. The answer is 403 with the usual error body (0023): `{"error": "forbidden", "message": "the API is not available to web pages; use the CLI or an MCP client"}`. The rule applies with or without `ARTIFACT_TOKEN` and runs before the token guard.
- Why these headers. Browsers send `Origin` on every cross-origin request and on same-origin non-GET requests, and send `Sec-Fetch-Site` on every request to a potentially trustworthy origin (localhost included). `Sec-Fetch-Site: none` means the user typed the URL or opened a bookmark, which a page cannot cause. Non-browser clients send neither header. Node's `fetch` (undici, and so the MCP SDK client) sends `Sec-Fetch-Mode: cors` but no `Origin` or `Sec-Fetch-Site` (checked against Node 24 and SDK 1.32), so `Sec-Fetch-Mode` does not count.
- `file_path` loses its own browser check (0035): such requests never reach the tools.
- Path-mode routes stay mounted in every mode (0010); the gallery does not call `/api`.

## Consequences

- No web page, path-mode or not, can call the API or the MCP endpoint, so `ARTIFACT_TOKEN` is no longer needed on loopback to protect artifacts from each other.
- Breaking for anyone who called `/api` from browser JavaScript on `localhost:<port>`. Such a caller now needs a non-browser client.
- Old browsers that send neither header on same-origin GETs could still read `/api` from a path-mode page; reads expose only what the page could already view.
