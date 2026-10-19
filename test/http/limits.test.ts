// Injectable limits through /api and /mcp (docs/decisions/0051): one setting on the service
// drives the request body cap, the 413 bodies, the list bound and the tool schemas.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { LIMITS, type Limits } from "../../src/core/artifact-service.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { readEntryFile } from "../../src/mcp/file-path.ts";
import {
  bodyCapFor,
  DeleteToolInputSchema,
  ListToolInputSchema,
  MAX_BODY_BYTES,
  PublishToolInputSchema,
  ReadToolInputSchema,
  RollbackToolInputSchema,
  toolInputSchemas,
} from "../../src/schemas.ts";
import { harness } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const PORT = 4400;
const BASE = `http://localhost:${PORT}`;
const KIB = { maxFileBytes: 1024, maxPublishBytes: 1024 };

function setup(limits: Partial<Limits>, config: Partial<AppConfig> = {}) {
  const h = harness({ limits });
  const app = createApp({
    service: h.service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain", ...config },
  });
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const mcp = () => connectMcp(`${BASE}/mcp`, { handler: app.fetch });
  return { ...h, app, post, mcp };
}

const pick = (body: Record<string, unknown>) => [body.error, body.subject, body.limit];

describe("body cap", () => {
  it("is 1.5 × maxPublishBytes, rounded up; the default is MAX_BODY_BYTES (96 MiB)", () => {
    assert.equal(bodyCapFor(LIMITS), 96 * 1024 * 1024);
    assert.equal(MAX_BODY_BYTES, 96 * 1024 * 1024);
    assert.equal(bodyCapFor({ ...LIMITS, maxPublishBytes: 1024 }), 1536);
    assert.equal(bodyCapFor({ ...LIMITS, maxPublishBytes: 1025 }), 1538);
  });
});

describe("tool input schemas", () => {
  it("built with LIMITS equal the exported schemas", () => {
    const json = (s: z.ZodType) => z.toJSONSchema(s, { io: "input" });
    const built = toolInputSchemas(LIMITS);
    const exported = {
      PublishToolInputSchema,
      ListToolInputSchema,
      ReadToolInputSchema,
      RollbackToolInputSchema,
      DeleteToolInputSchema,
    };
    assert.deepEqual(Object.keys(built).sort(), Object.keys(exported).sort());
    for (const [name, schema] of Object.entries(exported)) {
      assert.deepEqual(json(built[name as keyof typeof built]), json(schema), name);
    }
  });
});

describe("/api with injected limits", () => {
  it("returns 413 too_large with the configured file limit", async () => {
    const { post } = setup(KIB);
    const res = await post(
      "/api/artifacts",
      JSON.stringify({ files: { "index.html": "x".repeat(1025) } }),
    );
    assert.equal(res.status, 413);
    assert.deepEqual(pick(await res.json()), ["too_large", "file", 1024]);
  });

  it("cuts off a body over the derived cap with 413 too_large and the publish limit", async () => {
    const { post } = setup(KIB);
    const res = await post(
      "/api/artifacts",
      JSON.stringify({ files: { "index.html": "x".repeat(4096) } }),
    );
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.deepEqual(pick(body), ["too_large", "publish", 1024]);
    assert.match(body.message, /1024/);
  });

  it("lets a maxBodyBytes override through to the core's checks", async () => {
    const { post } = setup(KIB, { maxBodyBytes: 2048 });
    const res = await post(
      "/api/artifacts",
      JSON.stringify({ files: { "index.html": "x".repeat(1800) } }),
    );
    assert.equal(res.status, 413);
    assert.deepEqual(pick(await res.json()), ["too_large", "file", 1024]);
  });

  it("bounds ?limit by the configured maxListLimit", async () => {
    const { app } = setup({ maxListLimit: 5 });
    const bad = await app.request(`${BASE}/api/artifacts?limit=6`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).message, /1 to 5/);
    assert.equal((await app.request(`${BASE}/api/artifacts?limit=5`)).status, 200);
  });

  it("defaults the list to at most the configured maxListLimit", async () => {
    const { service, app } = setup({ maxListLimit: 5 });
    for (let i = 0; i < 6; i++) await service.publish({ files: { "index.html": `${i}` } });
    const res = await app.request(`${BASE}/api/artifacts`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).artifacts.length, 5);
  });
});

describe("/mcp with injected limits", () => {
  it("returns too_large with the configured file and publish limits", async () => {
    const mcp = await setup(KIB).mcp();
    const file = await mcp.call("artifact_publish", { files: { "index.html": "x".repeat(1025) } });
    assert.equal(file.isError, true);
    assert.deepEqual(pick(file.value), ["too_large", "file", 1024]);
    const publish = await mcp.call("artifact_publish", {
      files: { "index.html": "x".repeat(600), "a.txt": "y".repeat(600) },
    });
    assert.equal(publish.isError, true);
    assert.deepEqual(pick(publish.value), ["too_large", "publish", 1024]);
    await mcp.close();
  });

  it("checks file_path against the configured file limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-limits-"));
    try {
      const path = join(dir, "page.html");
      writeFileSync(path, "x".repeat(1025));
      const mcp = await setup(KIB).mcp();
      const r = await mcp.call("artifact_publish", { file_path: path });
      assert.equal(r.isError, true);
      assert.deepEqual([...pick(r.value), r.value.path], ["too_large", "file", 1024, "index.html"]);
      await mcp.close();
      const direct = await readEntryFile(path, 1024);
      assert.equal(direct.ok, false);
      assert.equal((await readEntryFile(path)).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the configured numbers in the tool schemas", async () => {
    const mcp = await setup({ maxLabelChars: 3, maxListLimit: 5 }).mcp();
    const { tools } = await mcp.client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    const prop = (tool: string, name: string) =>
      (by[tool].properties as Record<string, { description?: string; maximum?: number }>)[name];
    assert.match(prop("artifact_publish", "label").description ?? "", /at most 3 characters/);
    assert.equal(prop("artifact_list", "limit").maximum, 5);
    assert.match(prop("artifact_list", "limit").description ?? "", /\(default 5\)/);
    await mcp.close();
  });

  it("defaults artifact_list to at most the configured maxListLimit", async () => {
    const h = setup({ maxListLimit: 5 });
    for (let i = 0; i < 6; i++) await h.service.publish({ files: { "index.html": `${i}` } });
    const mcp = await h.mcp();
    const r = await mcp.call("artifact_list", { all: true });
    assert.equal(r.isError, false);
    assert.equal((r.value.artifacts as unknown[]).length, 5);
    await mcp.close();
  });

  it("answers a raw request over the derived cap with 413", async () => {
    const { post } = setup(KIB);
    const res = await post(
      "/mcp",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "artifact_publish",
          arguments: { files: { "index.html": "x".repeat(4096) } },
        },
      }),
      { accept: "application/json, text/event-stream" },
    );
    assert.equal(res.status, 413);
  });

  it("lets a maxBodyBytes override through to the core's checks", async () => {
    const mcp = await setup(KIB, { maxBodyBytes: 2048 }).mcp();
    const r = await mcp.call("artifact_publish", { files: { "index.html": "x".repeat(1800) } });
    assert.equal(r.isError, true);
    assert.deepEqual(pick(r.value), ["too_large", "file", 1024]);
    await mcp.close();
  });
});
