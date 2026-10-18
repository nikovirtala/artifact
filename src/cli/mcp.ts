// `artifact mcp` (docs/decisions/0045): a stdio MCP server that forwards every JSON-RPC message
// unchanged to the running server's Streamable HTTP endpoint, so the tools are exactly /mcp's.
// stdout is the protocol; diagnostics go to stderr only.
import type { Readable, Writable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isInitializeRequest,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { envValue } from "../config.ts";
import { parseCommand } from "./args.ts";
import { networkCause, resolveServer } from "./client.ts";
import { type CliContext, EXIT } from "./output.ts";

export const USAGE = `Usage: artifact mcp [options]

Runs an MCP server on stdin/stdout for clients that only launch stdio servers, forwarding
everything to the running server's /mcp endpoint (start it with \`artifact serve\`). Sends
ARTIFACT_TOKEN as a bearer token when it is set.

  claude mcp add --scope user artifacts -- npx @nikovirtala/artifact mcp

Options:
  --server <url>        Server URL (default ARTIFACT_SERVER or http://localhost:4400)
  -h, --help            Show this help
`;

/** JSON-RPC "server error": the request never reached the artifact server. */
const UNREACHABLE = -32000;

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const { values } = parseCommand(args, { options: { server: { type: "string" } } });
  const endpoint = `${resolveServer(values.server, ctx.env)}/mcp`;
  const token = envValue(ctx.env, "ARTIFACT_TOKEN");
  const log = (message: string) => ctx.stderr.write(`artifact mcp: ${message}\n`);

  const stdio = new StdioServerTransport(ctx.stdin as Readable, ctx.stdout as Writable);
  const http = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });

  // `send` reports its failure to onerror and then rejects; those are logged once, by the
  // send handler, so onerror defers and skips them.
  const reported = new WeakSet<object>();
  const pending = new Set<Promise<void>>();
  const initializeIds = new Set<string | number>();

  stdio.onmessage = (message: JSONRPCMessage) => {
    if (isJSONRPCRequest(message) && isInitializeRequest(message)) initializeIds.add(message.id);
    const sent = http.send(message).catch(async (error: unknown) => {
      if (typeof error === "object" && error !== null) reported.add(error);
      const text = `artifact server unreachable at ${endpoint}: ${networkCause(error)}; start it with \`artifact serve\``;
      log(text);
      if (isJSONRPCRequest(message)) {
        await stdio.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: UNREACHABLE, message: text },
        });
      }
    });
    pending.add(sent);
    sent.finally(() => pending.delete(sent));
  };
  http.onmessage = (message: JSONRPCMessage) => {
    // Later POSTs carry the negotiated version, as the SDK client's would.
    if (isJSONRPCResultResponse(message) && initializeIds.delete(message.id)) {
      const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof version === "string") http.setProtocolVersion(version);
    }
    stdio.send(message).catch((error: Error) => log(error.message));
  };
  http.onerror = (error: Error) => {
    setImmediate(() => {
      if (!reported.has(error)) log(error.message);
    });
  };
  stdio.onerror = (error: Error) => log(error.message);

  let finish: (drain: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const onEnd = () => finish(true);
  const onSignal = () => finish(false);
  ctx.stdin.once("end", onEnd);
  ctx.stdin.once("close", onEnd);
  stdio.onclose = onEnd;
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  await http.start();
  await stdio.start();
  // When stdin ends, answer what was already sent before shutting down.
  if (await done) await Promise.allSettled([...pending]);

  ctx.stdin.off("end", onEnd);
  ctx.stdin.off("close", onEnd);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  stdio.onclose = undefined;
  await http.close();
  await stdio.close();
  return EXIT.ok;
}
