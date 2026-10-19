// GET /__artifact/version: the current version on every artifact origin (docs/decisions/0057).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { harness, unwrap } from "../support/fakes.ts";

const PORT = 4400;
const CSP = "default-src 'self'";

async function setup(config: Partial<AppConfig> = {}) {
  const { service } = harness();
  const { id } = unwrap(await service.publish({ files: { "index.html": "one" } }));
  const app = createApp({
    service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain", csp: CSP, ...config },
  });
  const get = (host: string, path = "/__artifact/version", init?: RequestInit) =>
    app.request(`http://${host}:${PORT}${path}`, init);
  return { service, app, id, get };
}

async function version(res: Response): Promise<unknown> {
  assert.equal(res.status, 200);
  return ((await res.json()) as { version: unknown }).version;
}

describe("GET /__artifact/version", () => {
  it("serves the current version on the artifact subdomain, uncached", async () => {
    const { get, id } = await setup();
    const res = await get(`${id}.localhost`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(res.headers.get("content-security-policy"), CSP);
    assert.equal(await res.text(), JSON.stringify({ version: 1 }));
  });

  it("follows republish and rollback", async () => {
    const { get, service, id } = await setup();
    unwrap(await service.publish({ id, files: { "index.html": "two" } }));
    assert.equal(await version(await get(`${id}.localhost`)), 2);
    unwrap(await service.rollback(id, 1));
    assert.equal(await version(await get(`${id}.localhost`)), 1);
  });

  it("needs ?id= on the main host (any case, any loopback host)", async () => {
    const { get, id } = await setup();
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      for (const query of [id, id.toUpperCase()]) {
        const res = await get(host, `/__artifact/version?id=${query}`);
        assert.equal(await version(res), 1, `${host} ${query}`);
        assert.equal(res.headers.get("cache-control"), "no-store");
      }
    }
    for (const query of ["", "?id=", "?id=nope", `?id=${id}x`]) {
      const res = await get("localhost", `/__artifact/version${query}`);
      assert.equal(res.status, 404, query);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    }
  });

  it("accepts the subdomain's own id in ?id= and 404s any other", async () => {
    const { get, service, id } = await setup();
    const other = unwrap(await service.publish({ files: { "index.html": "x" } })).id;
    assert.equal(await version(await get(`${id}.localhost`, `/__artifact/version?id=${id}`)), 1);
    for (const query of [other, "nope", ""]) {
      const res = await get(`${id}.localhost`, `/__artifact/version?id=${query}`);
      assert.equal(res.status, 404, query);
    }
  });

  it("404s unknown and deleted artifacts", async () => {
    const { get, service, id } = await setup();
    const unknown = "01m55g1mv87q1zb2gpj07jz10e";
    assert.equal((await get(`${unknown}.localhost`)).status, 404);
    assert.equal((await get("localhost", `/__artifact/version?id=${unknown}`)).status, 404);
    unwrap(await service.delete(id));
    for (const res of [
      await get(`${id}.localhost`),
      await get("localhost", `/__artifact/version?id=${id}`),
    ]) {
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    }
  });

  it("answers HEAD without a body and other methods with 404", async () => {
    const { get, id } = await setup();
    const head = await get(`${id}.localhost`, "/__artifact/version", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("cache-control"), "no-store");
    assert.equal(await head.text(), "");
    for (const host of [`${id}.localhost`, "localhost"]) {
      const res = await get(host, `/__artifact/version?id=${id}`, { method: "POST" });
      assert.equal(res.status, 404, host);
    }
  });

  it("needs no token", async () => {
    const { get, id } = await setup({ token: "secret" });
    assert.equal(await version(await get(`${id}.localhost`)), 1);
    assert.equal(await version(await get("localhost", `/__artifact/version?id=${id}`)), 1);
  });

  it("is not served from inside an artifact path and is guarded by Host", async () => {
    const { app, get, id } = await setup();
    for (const path of [`/a/${id}/__artifact/version`, `/a/${id}/v/1/__artifact/version`]) {
      assert.equal((await get("localhost", path)).status, 404, path);
    }
    const res = await app.request(`http://evil.example/__artifact/version?id=${id}`);
    assert.equal(res.status, 403);
  });
});
