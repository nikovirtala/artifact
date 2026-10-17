// An MCP SDK client over Streamable HTTP, against a real URL or an in-process fetch handler.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type Handler = (request: Request) => Promise<Response> | Response;

export type McpClient = {
  client: Client;
  /** Call a tool; `structuredContent` plus whether it was a tool error. */
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError: boolean; value: Record<string, unknown>; result: CallToolResult }>;
  close(): Promise<void>;
};

export async function connectMcp(
  url: string,
  options: { handler?: Handler; headers?: Record<string, string> } = {},
): Promise<McpClient> {
  const { handler, headers } = options;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
    fetch: handler ? async (input, init) => handler(new Request(input, init)) : undefined,
  });
  const client = new Client({ name: "artifact-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return {
        isError: result.isError === true,
        value: (result.structuredContent ?? {}) as Record<string, unknown>,
        result,
      };
    },
    close: () => client.close(),
  };
}
