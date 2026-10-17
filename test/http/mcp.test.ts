// /mcp mounted on the app: reachable through the SDK client, behind the /api guards.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { harness } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const PORT = 4400;
const id = "01hzx3k5m7n9p1q3r5s7t9v1w3";
const listTools = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

function setup(config: Partial<AppConfig> = {}) {
  const app = createApp({
    service: harness().service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain", ...config },
  });
  const post = (url: string, headers: Record<string, string> = {}) =>
    app.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: listTools,
    });
  return { app, post };
}

describe("/mcp on the app", () => {
  it("serves the tools to an SDK client and returns subdomain urls", async () => {
    const { app } = setup();
    const mcp = await connectMcp(`http://localhost:${PORT}/mcp`, { handler: app.fetch });
    const { tools } = await mcp.client.listTools();
    assert.equal(tools.length, 5);
    const r = await mcp.call("artifact_publish", { files: { "index.html": "<p>hi</p>" } });
    assert.equal(r.value.url, `http://${r.value.id}.localhost:${PORT}/`);
  });

  it("accepts the loopback origins and rejects every other Origin with 403 forbidden", async () => {
    const { post } = setup();
    for (const origin of [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]) {
      const res = await post(`http://localhost:${PORT}/mcp`, { origin });
      assert.equal(res.status, 200, origin);
    }
    for (const origin of [
      `http://${id}.localhost:${PORT}`,
      "http://evil.example",
      `http://localhost:${PORT + 1}`,
      "null",
    ]) {
      const res = await post(`http://localhost:${PORT}/mcp`, { origin });
      assert.equal(res.status, 403, origin);
      assert.equal((await res.json()).error, "forbidden");
    }
  });

  it("refuses file_path from a same-origin page; inline files still work", async () => {
    const { app } = setup({ isolation: "path" });
    const dir = mkdtempSync(join(tmpdir(), "artifact-mcp-origin-"));
    try {
      const secret = join(dir, "secret.html");
      writeFileSync(secret, "<p>secret</p>");
      const page = await connectMcp(`http://localhost:${PORT}/mcp`, {
        handler: app.fetch,
        headers: { origin: `http://localhost:${PORT}`, "sec-fetch-site": "same-origin" },
      });
      const r = await page.call("artifact_publish", { file_path: secret });
      assert.equal(r.isError, true);
      assert.deepEqual([r.value.error, r.value.field], ["invalid_input", "file_path"]);
      assert.deepEqual((await page.call("artifact_list")).value.artifacts, []);
      const inline = await page.call("artifact_publish", { files: { "index.html": "<p>ok</p>" } });
      assert.equal(inline.isError, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires the bearer token when ARTIFACT_TOKEN is set", async () => {
    const { app, post } = setup({ token: "s3cret" });
    for (const headers of [
      {},
      { authorization: "Bearer nope" },
      { authorization: "s3cret" },
    ] as Record<string, string>[]) {
      const res = await post(`http://localhost:${PORT}/mcp`, headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
      assert.equal((await res.json()).error, "unauthorized");
    }
    const ok = await post(`http://localhost:${PORT}/mcp`, { authorization: "Bearer s3cret" });
    assert.equal(ok.status, 200);
    await assert.rejects(connectMcp(`http://localhost:${PORT}/mcp`, { handler: app.fetch }));
    const mcp = await connectMcp(`http://localhost:${PORT}/mcp`, {
      handler: app.fetch,
      headers: { authorization: "Bearer s3cret" },
    });
    assert.equal((await mcp.client.listTools()).tools.length, 5);
  });

  it("is only on the main hosts: foreign Host 403, artifact host 404", async () => {
    const { post } = setup();
    assert.equal((await post(`http://evil.example:${PORT}/mcp`)).status, 403);
    assert.equal((await post(`http://${id}.localhost:${PORT}/mcp`)).status, 404);
  });

  it("answers GET with 405 behind the guards", async () => {
    const { app } = setup({ token: "t" });
    const url = `http://localhost:${PORT}/mcp`;
    const get = (headers: Record<string, string>) => app.request(url, { headers });
    assert.equal((await get({ accept: "text/event-stream" })).status, 401);
    const res = await get({ accept: "text/event-stream", authorization: "Bearer t" });
    assert.equal(res.status, 405);
  });
});
