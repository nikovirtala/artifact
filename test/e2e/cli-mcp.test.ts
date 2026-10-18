// `artifact mcp` (docs/decisions/0045): an MCP SDK client over stdio, through the bridge, to a
// real `artifact serve`.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanup, cliCommand, env, freePort, runCli, serve, tempRoot } from "../support/e2e.ts";

after(cleanup);

const TOOLS = [
  "artifact_delete",
  "artifact_list",
  "artifact_publish",
  "artifact_read",
  "artifact_rollback",
];

/** An SDK client that launches `artifact mcp` against `server`; collects the bridge's stderr. */
function bridge(server: string, extraEnv: Record<string, string> = {}) {
  const [command, args] = cliCommand("mcp");
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...(env as Record<string, string>), ARTIFACT_SERVER: server, ...extraEnv },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const client = new Client({ name: "artifact-test", version: "0.0.0" });
  return { client, transport, stderr: () => stderr };
}

async function startServer(extraEnv: Record<string, string> = {}) {
  const port = await freePort();
  await serve(port, tempRoot(), extraEnv);
  return `http://127.0.0.1:${port}`;
}

describe("artifact mcp (e2e)", () => {
  it("lists the tools and publishes through the bridge", async () => {
    const server = await startServer();
    const { client, transport } = bridge(server);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
      const result = await client.callTool({
        name: "artifact_publish",
        arguments: { files: { "index.html": "<p>x</p>" } },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const { id } = result.structuredContent as { id: string };
      const res = await fetch(`${server}/api/artifacts/${id}`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { id: string }).id, id);
    } finally {
      await client.close();
    }
  });

  it("forwards ARTIFACT_TOKEN to a token-protected server", async () => {
    const server = await startServer({ ARTIFACT_TOKEN: "s3cret" });
    const { client, transport } = bridge(server, { ARTIFACT_TOKEN: "s3cret" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, TOOLS.length);
    } finally {
      await client.close();
    }

    const denied = bridge(server);
    await assert.rejects(denied.client.connect(denied.transport), /artifact serve/);
    await denied.client.close();
  });

  it("answers requests with an error naming `artifact serve` when no server runs", async () => {
    const server = `http://127.0.0.1:${await freePort()}`;
    const { client, transport, stderr } = bridge(server);
    // The first request is initialize, so connect is what rejects.
    await assert.rejects(client.connect(transport), (error: Error) => {
      assert.match(error.message, /artifact server unreachable at http:\/\/127\.0\.0\.1:\d+\/mcp/);
      assert.match(error.message, /start it with `artifact serve`/);
      return true;
    });
    await client.close();
    assert.match(stderr(), /artifact mcp: artifact server unreachable at .*`artifact serve`/);
  });

  it("exits 0 without writing to stdout when stdin ends", async () => {
    const result = await runCli(["mcp"], { env: { ARTIFACT_SERVER: await startServer() } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.length, 0);
  });
});
