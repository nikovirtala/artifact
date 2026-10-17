# 0033. MCP transport: stateless Streamable HTTP, SDK 1.32 with Zod 4

Status: Accepted (M4)

## Decision

- **SDK.** `@modelcontextprotocol/sdk` `^1.32.1` (runtime dependency allowed by the spec). Its peer and runtime range for Zod is `^3.25 || ^4.0`, so the repo's `zod ^4.6.7` is used as is: no Zod 3 copy, no adapter. Tool input schemas are turned into JSON Schema with Zod 4's own `z.toJSONSchema(schema, {io: "input"})` (draft 2020-12, `type: "object"`, `additionalProperties: false`).
- **Low-level `Server`, not `McpServer`.** `McpServer` validates arguments itself and answers a failure with a plain-text tool error. The tools must return the API's `invalid_request` object instead (0034), so `src/mcp/server.ts` registers `tools/list` and `tools/call` on the low-level `Server` and validates with the shared Zod schemas. The SDK marks `Server` "for advanced use cases"; this is one.
- **Transport.** `WebStandardStreamableHTTPServerTransport` (Web `Request`/`Response`, so it runs in Hono today and on Lambda later) in **stateless** mode: `sessionIdGenerator: undefined`, `enableJsonResponse: true`. Every POST gets a fresh `Server` and transport, which are closed once the response is built. No `Mcp-Session-Id` is issued, and any instance can answer any request.
- **Methods.** Only `POST /mcp` reaches the transport. `GET` (a server-to-client stream) and `DELETE` (end a session) mean nothing without sessions, and a stateless GET stream would stay open with nothing to send, so both get `405` with `Allow: POST` and a JSON-RPC error body. Clients, including the SDK's, treat 405 on GET as "no stream".
- **Mounting.** `/mcp` is on the same Hono app and port, on the main hosts only (on `<id>.localhost` every path is the artifact's). It sits behind the Host and traversal guards (all routes) and the Origin and token guards of `/api` (0027): artifact origins get 403, `ARTIFACT_TOKEN` is enforced. Unexpected errors on `/mcp` get the JSON `internal` body like `/api`.
- **Body limit.** The transport's own POST limit (default 4 MiB) is raised to the API's 96 MiB (`MAX_BODY_BYTES` in `src/schemas.ts`), so the 64 MiB publish limit is reachable. A larger body gets the transport's 413 JSON-RPC error.

## Consequences

The MCP endpoint keeps no state between requests, so the AWS move (Lambda behind a URL) needs no session store. Server-initiated messages (progress, sampling) are not available; the tools do not need them.
