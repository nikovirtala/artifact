import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { escapeHtml } from "../../src/http/gallery.ts";
import { harness, unwrap } from "../support/fakes.ts";

const PORT = 4400;

function setup(config: Partial<AppConfig> = {}) {
  const h = harness();
  const app = createApp({
    service: h.service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain", ...config },
  });
  const gallery = () => app.request(`http://localhost:${PORT}/`);
  return { ...h, app, gallery };
}

describe("gallery", () => {
  it("lists artifacts newest first with title, version, time and link", async () => {
    const { service, clock, gallery } = setup();
    const a = unwrap(await service.publish({ title: "Alpha", files: { "index.html": "a" } }));
    clock.advance(60_000);
    const b = unwrap(await service.publish({ files: { "index.html": "b" } }));
    unwrap(await service.publish({ id: b.id, files: { "index.html": "b2" } }));
    const res = await gallery();
    assert.equal(res.status, 200);
    const html = await res.text();
    const posB = html.indexOf(`href="http://${b.id}.localhost:${PORT}/"`);
    const posA = html.indexOf(`href="http://${a.id}.localhost:${PORT}/"`);
    assert.ok(posB > 0 && posA > posB, "newest first");
    assert.match(html, /Alpha<\/a> <span>v1<\/span>/);
    assert.match(html, /<em>untitled<\/em><\/a> <span>v2<\/span>/);
    assert.match(html, /<time datetime="2026-10-17T12:01:00.000Z">2026-10-17 12:01 UTC<\/time>/);
  });

  it("escapes user content and contains no script", async () => {
    const { service, gallery } = setup();
    unwrap(
      await service.publish({
        title: `<script>alert(1)</script>&"'`,
        files: { "index.html": "x" },
      }),
    );
    const html = await (await gallery()).text();
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;"));
    assert.ok(!html.includes("<script"));
    assert.equal(
      escapeHtml(`<a href="x">'&'</a>`),
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("links follow the isolation mode", async () => {
    const { service, gallery } = setup({ isolation: "path" });
    const { id } = unwrap(await service.publish({ files: { "index.html": "x" } }));
    assert.match(
      await (await gallery()).text(),
      new RegExp(`href="http://localhost:${PORT}/a/${id}/"`),
    );
  });

  it("sends the strict gallery CSP and security headers", async () => {
    const res = await setup({ csp: "default-src *" }).gallery();
    assert.equal(
      res.headers.get("content-security-policy"),
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  });

  it("shows an empty state", async () => {
    assert.match(await (await setup().gallery()).text(), /No artifacts yet\./);
  });

  it("is not served on <id>.localhost", async () => {
    const { service, app } = setup();
    const { id } = unwrap(await service.publish({ files: { "index.html": "page" } }));
    const res = await app.request(`http://${id}.localhost:${PORT}/`);
    assert.ok((await res.text()).startsWith("page"));
  });
});

describe("gallery projects", () => {
  it("shows each artifact's project, escaped, and filters with ?project=", async () => {
    const { service, app } = setup();
    const a = unwrap(
      await service.publish({
        title: "A",
        project: "git@github.com:acme/a.git",
        files: { "index.html": "a" },
      }),
    );
    const odd = unwrap(
      await service.publish({
        title: "Odd",
        project: 'local:/tmp/<x>&"y"',
        files: { "index.html": "o" },
      }),
    );
    const plain = unwrap(await service.publish({ title: "Plain", files: { "index.html": "p" } }));
    const all = await (await app.request(`http://localhost:${PORT}/`)).text();
    assert.match(
      all,
      /A<\/a> <a class="project" href="\/\?project=github.com%2Facme%2Fa">github.com\/acme\/a<\/a> <span>v1/,
    );
    assert.ok(all.includes("local:/tmp/&lt;x&gt;&amp;&quot;y&quot;"));
    assert.ok(all.includes(`href="/?project=local%3A%2Ftmp%2F%3Cx%3E%26%22y%22"`));
    assert.match(all, /Plain<\/a> <span>v1/);
    assert.ok(!all.includes("<script"));

    const res = await app.request(`http://localhost:${PORT}/?project=https://github.com/ACME/a`);
    assert.equal(res.status, 200);
    const filtered = await res.text();
    assert.ok(filtered.includes(`${a.id}.localhost`));
    assert.ok(!filtered.includes(`${odd.id}.localhost`));
    assert.ok(!filtered.includes(`${plain.id}.localhost`));
    assert.match(
      filtered,
      /Project <strong>github.com\/acme\/a<\/strong> · <a href="\/">all projects<\/a>/,
    );
    const empty = await (
      await app.request(`http://localhost:${PORT}/?project=github.com/x/y`)
    ).text();
    assert.match(empty, /No artifacts in this project\./);
  });

  it("answers an invalid project with 400", async () => {
    const res = await setup().app.request(`http://localhost:${PORT}/?project=nope`);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  });
});
