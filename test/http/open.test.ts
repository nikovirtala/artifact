// Auto-open (docs/decisions/0040) through the API and MCP with a fake opener.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { harness } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const PORT = 4400;
const BASE = `http://localhost:${PORT}`;
const files = { "index.html": "<p>x</p>" };

function setup(config: Partial<AppConfig> = {}, result = true) {
  const opened: string[] = [];
  const app = createApp({
    service: harness().service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain", ...config },
    opener: (url) => {
      opened.push(url);
      return result;
    },
  });
  const call = async (method: string, path: string, body: unknown) => {
    const res = await app.request(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  return { app, opened, call };
}

describe("auto-open via the API", () => {
  it("opens a created artifact once, at its current URL; never on update or rollback", async () => {
    const { opened, call } = setup();
    const created = await call("POST", "/api/artifacts", { files });
    assert.equal(created.opened, true);
    assert.deepEqual(opened, [`http://${created.id}.localhost:${PORT}/`]);
    const updated = await call("PUT", `/api/artifacts/${created.id}`, { files, open: true });
    assert.equal(updated.opened, false);
    const rolled = await call("POST", `/api/artifacts/${created.id}/rollback`, { version: 1 });
    assert.equal(rolled.version, 1);
    assert.equal("opened" in rolled, false);
    assert.equal(opened.length, 1);
  });

  it("uses the path-mode URL with isolation path", async () => {
    const { opened, call } = setup({ isolation: "path" });
    const created = await call("POST", "/api/artifacts", { files });
    assert.deepEqual(opened, [`http://localhost:${PORT}/a/${created.id}/`]);
  });

  it("open: false suppresses it for that call", async () => {
    const { opened, call } = setup();
    const created = await call("POST", "/api/artifacts", { files, open: false });
    assert.equal(created.opened, false);
    assert.deepEqual(opened, []);
    assert.equal((await call("POST", "/api/artifacts", { files, open: true })).opened, true);
  });

  it("reports what the opener did, and nothing opens without one or on failure", async () => {
    const failing = setup({}, false);
    assert.equal((await failing.call("POST", "/api/artifacts", { files })).opened, false);
    assert.equal(failing.opened.length, 1);
    const none = createApp({
      service: harness().service,
      events: createMemoryNotifier(),
      config: { port: PORT, isolation: "subdomain" },
    });
    const res = await none.request(`${BASE}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    assert.equal((await res.json()).opened, false);
    const bad = await setup().call("POST", "/api/artifacts", { files: {} });
    assert.equal(bad.error, "invalid_path");
  });
});

describe("auto-open via MCP", () => {
  it("opens on create only; open is not an MCP argument", async () => {
    const { app, opened } = setup();
    const mcp = await connectMcp(`${BASE}/mcp`, { handler: app.fetch });
    const created = await mcp.call("artifact_publish", { files });
    assert.equal(created.value.opened, true);
    assert.deepEqual(opened, [created.value.url]);
    const id = created.value.id;
    const updated = await mcp.call("artifact_publish", { id, files });
    assert.equal(updated.value.opened, false);
    await mcp.call("artifact_rollback", { id, version: 1 });
    assert.equal(opened.length, 1);
    const withOpen = await mcp.call("artifact_publish", { files, open: false });
    assert.equal(withOpen.value.error, "invalid_request");
    const failed = await mcp.call("artifact_publish", { id, if_version: 9, files });
    assert.equal(failed.isError, true);
    assert.equal(opened.length, 1);
  });
});
