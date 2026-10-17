import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { createMemoryStore } from "../../src/adapters/memory-store.ts";
import { reloadScriptTag } from "../../src/core/inject.ts";
import type { PointerStore } from "../../src/core/ports.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import type { AppEnv } from "../../src/http/guards.ts";
import { harness, unwrap } from "../support/fakes.ts";

const PORT = 4400;

async function setup(config: Partial<AppConfig> = {}, h = harness()) {
  const { service } = h;
  const { id } = unwrap(
    await service.publish({
      files: {
        "index.html": "<body>one</body>",
        "docs/index.html": "<p>docs</p>",
        "css/site.css": "a{}",
        "img/a.png": new Uint8Array([1, 2]),
      },
    }),
  );
  unwrap(await service.publish({ id, files: { "index.html": "<body>two</body>" } }));
  const app = createApp({
    service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain", ...config },
  });
  const sub = (path: string, init?: RequestInit) =>
    app.request(`http://${id}.localhost:${PORT}${path}`, init);
  const main = (path: string, init?: RequestInit) =>
    app.request(`http://localhost:${PORT}${path}`, init);
  const raw = (host: string, target: string) =>
    app.request(`http://${host}/`, {}, {
      incoming: { url: target },
    } as unknown as AppEnv["Bindings"]);
  return { app, id, sub, main, raw, service };
}

const two = `<body>two${reloadScriptTag(2)}</body>`;
const one = `<body>one${reloadScriptTag(1)}</body>`;

describe("subdomain viewing", () => {
  it("serves the current version at / and pinned versions at /v/<n>/", async () => {
    const { sub } = await setup();
    const current = await sub("/");
    assert.equal(current.status, 200);
    assert.equal(current.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(current.headers.get("cache-control"), "no-cache");
    assert.equal(await current.text(), two);
    assert.equal(await (await sub("/index.html")).text(), two);
    const pinned = await sub("/v/1/");
    assert.equal(await pinned.text(), one);
    assert.equal(pinned.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await (await sub("/v/1/css/site.css")).text(), "a{}");
    assert.equal(await (await sub("/v/2/")).text(), two);
  });

  it("redirects /v/<n> and extensionless directories with 308", async () => {
    const { sub } = await setup();
    const v = await sub("/v/1?x=1");
    assert.equal(v.status, 308);
    assert.equal(v.headers.get("location"), "/v/1/?x=1");
    assert.equal(v.headers.get("cache-control"), "no-store");
    const docs = await sub("/v/1/docs");
    assert.equal(docs.status, 308);
    assert.equal(docs.headers.get("location"), "/v/1/docs/");
    assert.equal(await (await sub("/v/1/docs/")).text(), `<p>docs</p>${reloadScriptTag(1)}`);
    assert.equal((await sub("/docs")).status, 404, "v2 has no docs/index.html");
  });

  it("uses the extension allowlist for content types", async () => {
    const { sub } = await setup();
    assert.equal(
      (await sub("/v/1/css/site.css")).headers.get("content-type"),
      "text/css; charset=utf-8",
    );
    const png = await sub("/v/1/img/a.png");
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await png.arrayBuffer()), new Uint8Array([1, 2]));
  });

  it("sends the security headers, and a CSP only when configured", async () => {
    const plain = await setup();
    for (const res of [await plain.sub("/"), await plain.sub("/nope.css")]) {
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(res.headers.get("content-security-policy"), null);
    }
    const strict = await setup({ csp: "default-src 'self'" });
    assert.equal(
      (await strict.sub("/")).headers.get("content-security-policy"),
      "default-src 'self'",
    );
    assert.equal(
      (await strict.main(`/a/${strict.id}/`)).headers.get("content-security-policy"),
      "default-src 'self'",
    );
  });

  it("returns a plain 404 for missing files, versions and unknown or malformed ids", async () => {
    const { sub, app } = await setup();
    for (const path of [
      "/nope.css",
      "/v/3/",
      "/v/0/",
      "/v/01/",
      "/v/x/",
      "/v",
      "/__artifact/reload.js",
    ]) {
      const res = await sub(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await res.text(), "not found\n");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    }
    const unknown = await app.request(`http://0000000000000000000000000z.localhost:${PORT}/`);
    assert.equal(unknown.status, 404);
    assert.equal((await sub("/", { method: "POST" })).status, 404);
  });

  it("serves an uppercase id host as the same artifact", async () => {
    const { app, id } = await setup();
    const res = await app.request(`http://${id.toUpperCase()}.localhost:${PORT}/`);
    assert.equal(await res.text(), two);
  });

  it("never serves an orphan version", async () => {
    const store = createMemoryStore();
    let crash = false;
    const pointers: PointerStore = {
      ...store,
      write: async (key, body, condition) => {
        if (crash) throw new Error("simulated crash");
        return store.write(key, body, condition);
      },
    };
    const { sub, id, service } = await setup({}, harness({ blobs: store, pointers }));
    crash = true;
    await assert.rejects(service.publish({ id, files: { "index.html": "orphan" } }));
    assert.equal((await sub("/v/3/")).status, 404);
  });
});

describe("path-mode viewing", () => {
  it("serves /a/<id>/ and /a/<id>/v/<n>/ while isolation is subdomain", async () => {
    const { main, id } = await setup();
    assert.equal(await (await main(`/a/${id}/`)).text(), two);
    assert.equal(await (await main(`/a/${id}/v/1/`)).text(), one);
    assert.equal(await (await main(`/a/${id.toUpperCase()}/`)).text(), two);
    const bare = await main(`/a/${id}`);
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.get("location"), `/a/${id}/`);
    const pinned = await main(`/a/${id}/v/1`);
    assert.equal(pinned.status, 308);
    assert.equal(pinned.headers.get("location"), `/a/${id}/v/1/`);
    const docs = await main(`/a/${id}/v/1/docs`);
    assert.equal(docs.headers.get("location"), `/a/${id}/v/1/docs/`);
  });

  it("works the same with isolation path, and 404s bad ids", async () => {
    const { main, id } = await setup({ isolation: "path" });
    assert.equal(await (await main(`/a/${id}/`)).text(), two);
    for (const path of ["/a/nope/", "/a/0000000000000000000000000z/", "/a/", "/a", "/nope"]) {
      assert.equal((await main(path)).status, 404, path);
    }
  });
});

describe("viewing guards", () => {
  it("rejects traversal in the raw target with 400", async () => {
    const { raw, id } = await setup();
    const sub = `${id}.localhost:${PORT}`;
    for (const [host, target] of [
      [sub, "/../../etc/passwd"],
      [sub, "/%2e%2e/%2e%2e/etc/passwd"],
      [sub, "/a%2f..%2fb.html"],
      [sub, "/v/1/..%5cx"],
      [`localhost:${PORT}`, `/a/${id}/../../x`],
      [`localhost:${PORT}`, `/a/${id}/%2e%2e/x`],
    ]) {
      const res = await raw(host, target);
      assert.equal(res.status, 400, target);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    }
  });

  it("returns 403 for a foreign Host", async () => {
    const { app } = await setup();
    for (const url of [
      "http://evil.example/",
      `http://evil.example:${PORT}/a/x/`,
      "http://localhost:9999/",
    ]) {
      const res = await app.request(url);
      assert.equal(res.status, 403, url);
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    }
  });
});
