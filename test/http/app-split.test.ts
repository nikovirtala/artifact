// The viewing and control apps (docs/decisions/0056): each runs standalone; createApp composes
// them with one shared error handler.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { createControlApp } from "../../src/http/control-app.ts";
import type { AppEnv } from "../../src/http/guards.ts";
import { createViewingApp } from "../../src/http/viewing-app.ts";
import { harness, unwrap } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const PORT = 4400;
const BASE = `http://localhost:${PORT}`;

function setup(config: Partial<AppConfig> = {}) {
  const h = harness();
  const deps = {
    service: h.service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain" as const, ...config },
  };
  return { ...h, deps };
}

const publish = async (h: ReturnType<typeof setup>) =>
  unwrap(await h.service.publish({ title: "T", files: { "index.html": "<p>hi</p>" } }));

describe("viewing app alone", () => {
  it("serves artifacts, the gallery, path mode and the reload client", async () => {
    const h = setup();
    const { id } = await publish(h);
    const app = createViewingApp(h.deps);
    const sub = await app.request(`http://${id}.localhost:${PORT}/`);
    assert.equal(sub.status, 200);
    assert.ok((await sub.text()).includes("<p>hi</p>"));
    const gallery = await app.request(`${BASE}/`);
    assert.equal(gallery.status, 200);
    assert.ok((await gallery.text()).includes(`href="http://${id}.localhost:${PORT}/"`));
    const path = await app.request(`${BASE}/a/${id}/`);
    assert.equal(path.status, 200);
    assert.ok((await path.text()).includes("<p>hi</p>"));
    const reload = await app.request(`${BASE}/__artifact/reload.js`);
    assert.equal(reload.status, 200);
    assert.equal((await app.request("http://evil.example/")).status, 403);
  });

  it("has no /api or /mcp", async () => {
    const app = createViewingApp(setup().deps);
    for (const [method, path] of [
      ["GET", "/api/artifacts"],
      ["POST", "/api/artifacts"],
      ["POST", "/mcp"],
      ["GET", "/mcp"],
    ]) {
      const res = await app.request(`${BASE}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    }
  });
});

describe("control app alone", () => {
  it("serves /api and /mcp on any host", async () => {
    const h = setup();
    const { id } = await publish(h);
    const app = createControlApp(h.deps);
    const list = await app.request("https://control.example/api/artifacts");
    assert.equal(list.status, 200);
    const body = (await list.json()) as { artifacts: { id: string; url: string }[] };
    assert.deepEqual(
      body.artifacts.map((a) => [a.id, a.url]),
      [[id, `http://${id}.localhost:${PORT}/`]],
    );
    const mcp = await connectMcp(`${BASE}/mcp`, { handler: app.fetch });
    const tools = await mcp.client.listTools();
    await mcp.close();
    assert.ok(tools.tools.some((t) => t.name === "artifact_publish"));
  });

  it("keeps the browser and token guards on /api and /mcp", async () => {
    const app = createControlApp(setup({ token: "s3cret" }).deps);
    for (const path of ["/api/artifacts", "/mcp"]) {
      const method = path === "/mcp" ? "POST" : "GET";
      const missing = await app.request(`${BASE}${path}`, { method });
      assert.equal(missing.status, 401, path);
      const browser = await app.request(`${BASE}${path}`, {
        method,
        headers: { origin: "http://evil.example", authorization: "Bearer s3cret" },
      });
      assert.equal(browser.status, 403, path);
    }
    const ok = await app.request(`${BASE}/api/artifacts`, {
      headers: { authorization: "Bearer s3cret" },
    });
    assert.equal(ok.status, 200);
  });

  it("has no gallery or viewing", async () => {
    const h = setup();
    const { id } = await publish(h);
    const app = createControlApp(h.deps);
    for (const url of [`${BASE}/`, `${BASE}/a/${id}/`, `${BASE}/__artifact/reload.js`]) {
      const res = await app.request(url);
      assert.equal(res.status, 404, url);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    }
  });

  it("rejects traversal in the raw target", async () => {
    const app = createControlApp(setup().deps);
    const env = { incoming: { url: "/api/%2e%2e/x" } } as unknown as AppEnv["Bindings"];
    const res = await app.request(`${BASE}/x`, {}, env);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "bad_request");
  });
});

describe("createApp error handling", () => {
  it("renders a thrown error as plain text on viewing routes and JSON on /api", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const h = setup();
    const { id } = await publish(h);
    const boom = async () => {
      throw new Error("boom");
    };
    h.service.list = boom;
    h.service.readServed = boom;
    const app = createApp(h.deps);
    for (const url of [`${BASE}/`, `http://${id}.localhost:${PORT}/`, `${BASE}/a/${id}/`]) {
      const res = await app.request(url);
      assert.equal(res.status, 500, url);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await res.text(), "internal server error\n");
    }
    const api = await app.request(`${BASE}/api/artifacts`);
    assert.equal(api.status, 500);
    assert.deepEqual(await api.json(), { error: "internal", message: "internal server error" });
    assert.equal(logged.mock.callCount(), 4);
  });

  it("renders the same way in the standalone apps", async (t) => {
    t.mock.method(console, "error", () => {});
    const h = setup();
    h.service.list = async () => {
      throw new Error("boom");
    };
    const viewing = await createViewingApp(h.deps).request(`${BASE}/`);
    assert.equal(viewing.status, 500);
    assert.equal(await viewing.text(), "internal server error\n");
    const control = await createControlApp(h.deps).request(`${BASE}/api/artifacts`);
    assert.equal(control.status, 500);
    assert.equal((await control.json()).error, "internal");
  });
});
