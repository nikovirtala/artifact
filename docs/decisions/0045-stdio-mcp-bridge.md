# 0045. `artifact mcp`: stdio bridge

Status: Accepted (M5)

## Context

Some MCP clients only launch stdio servers. The server's MCP endpoint is stateless Streamable HTTP (0033). The bridge must not own any tool logic, or the two would drift apart.

## Decision

- `artifact mcp [--server <url>]` pipes two MCP SDK transports together: `StdioServerTransport` on stdin/stdout and `StreamableHTTPClientTransport` to `<server>/mcp` (with `Authorization: Bearer $ARTIFACT_TOKEN` when set). Every JSON-RPC message is forwarded unchanged in both directions, so tools, schemas and errors are exactly the HTTP endpoint's. This is about 60 lines with no new dependency, and is simpler than a hand-written proxy because the SDK handles framing and JSON/SSE responses.
- **stdout is the protocol.** Diagnostics go to stderr only.
- **Server unreachable or rejecting.** If forwarding a request fails, the bridge answers that request id with a JSON-RPC error (`code: -32000`, `message: "artifact server unreachable at <url>/mcp: <cause>; start it with \`artifact serve\`"`) and writes the same line to stderr. Failed notifications are only logged. The bridge keeps running, so the client recovers once the server is up.
- It exits 0 when stdin ends or the client closes, and on SIGINT/SIGTERM.
- Setup: `claude mcp add --scope user artifacts -- npx @nikovirtala/artifact mcp`.

## Consequences

The bridge is stateless like the endpoint. The HTTP transport's optional GET stream is refused with 405, which the SDK treats as "no stream".
