import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { createApp } from "../../src/http/app.ts";
import { harness, unwrap } from "../support/fakes.ts";

const PORT = 4400;
const client = readFileSync(new URL("../../src/http/reload-client.js", import.meta.url), "utf8");

async function setup() {
  const { service } = harness();
  const { id } = unwrap(await service.publish({ files: { "index.html": "x" } }));
  const app = createApp({
    service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain", csp: "default-src 'self'" },
  });
  return { app, id };
}

describe("GET /__artifact/reload.js", () => {
  it("serves the reload client on artifact subdomains and the main host", async () => {
    const { app, id } = await setup();
    for (const host of [`${id}.localhost`, "localhost", "127.0.0.1", "[::1]"]) {
      const res = await app.request(`http://${host}:${PORT}/__artifact/reload.js`);
      assert.equal(res.status, 200, host);
      assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "no-cache");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(await res.text(), client);
    }
  });

  it("answers HEAD without a body and needs no token", async () => {
    const { service } = harness();
    const app = createApp({
      service,
      events: createMemoryNotifier(),
      config: { port: PORT, isolation: "subdomain", token: "secret" },
    });
    const res = await app.request(`http://localhost:${PORT}/__artifact/reload.js`, {
      method: "HEAD",
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  it("is still guarded by Host", async () => {
    const { app } = await setup();
    const res = await app.request("http://evil.example/__artifact/reload.js");
    assert.equal(res.status, 403);
  });

  it("is not served from inside an artifact path", async () => {
    const { app, id } = await setup();
    for (const path of [`/a/${id}/__artifact/reload.js`, `/a/${id}/v/1/__artifact/reload.js`]) {
      assert.equal((await app.request(`http://localhost:${PORT}${path}`)).status, 404, path);
    }
  });
});
