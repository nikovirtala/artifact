// HostPolicy port (docs/decisions/0053): the local policy matches today's guard and URLs; the
// domain policy accepts only the view domain and `<id>.<viewDomain>`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { createApp } from "../../src/http/app.ts";
import { classifyHost } from "../../src/http/guards.ts";
import { DomainHostPolicy, LocalHostPolicy } from "../../src/http/host-policy.ts";
import { harness, unwrap } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const id = "01hzx3k5m7n9p1q3r5s7t9v1w3";
const ID = id.toUpperCase();
const DOMAIN = "art.example.dev";

// Every host from test/http/guards.test.ts, plus a few more.
const LOCAL_HOSTS = [
  "localhost:4400",
  "127.0.0.1:4400",
  "[::1]:4400",
  "LOCALHOST:4400",
  `${id}.localhost:4400`,
  `${ID}.localhost:4400`,
  "localhost",
  "evil.example",
  "evil.example:4400",
  "localhost:4401",
  "127.0.0.2:4400",
  "notanid.localhost:4400",
  `x.${id}.localhost:4400`,
  `${id}.localhost.evil.example:4400`,
  ".localhost:4400",
  "localhost.:4400",
  `${id}.localhost`,
  "localhost:80",
];

describe("LocalHostPolicy", () => {
  it("classifies every host as classifyHost does, in both isolation modes and on port 80", () => {
    for (const port of [4400, 80]) {
      for (const isolation of ["subdomain", "path"] as const) {
        const policy = new LocalHostPolicy({ port, isolation });
        for (const host of LOCAL_HOSTS) {
          const expected = classifyHost(host, port) ?? { kind: "reject" };
          assert.deepEqual(policy.classify(host), expected, `${host} @${port} ${isolation}`);
        }
      }
    }
  });

  it("builds today's artifact and gallery URLs", () => {
    const sub = new LocalHostPolicy({ port: 4400, isolation: "subdomain" });
    const path = new LocalHostPolicy({ port: 4400, isolation: "path" });
    assert.equal(sub.artifactUrl(id), `http://${id}.localhost:4400/`);
    assert.equal(path.artifactUrl(id), `http://localhost:4400/a/${id}/`);
    assert.equal(sub.galleryUrl(), "http://localhost:4400/");
    const sub80 = new LocalHostPolicy({ port: 80, isolation: "subdomain" });
    assert.equal(sub80.artifactUrl(id), `http://${id}.localhost:80/`);
    assert.equal(
      new LocalHostPolicy({ port: 80, isolation: "path" }).artifactUrl(id),
      `http://localhost:80/a/${id}/`,
    );
    assert.equal(sub80.galleryUrl(), "http://localhost:80/");
  });
});

describe("DomainHostPolicy", () => {
  const policy = new DomainHostPolicy({ viewDomain: DOMAIN });

  it("accepts the apex and valid <id> labels, any case, with no port or :443", () => {
    const cases: [string, unknown][] = [
      [DOMAIN, { kind: "main" }],
      ["ART.Example.Dev", { kind: "main" }],
      [`${DOMAIN}:443`, { kind: "main" }],
      [`${id}.${DOMAIN}`, { kind: "artifact", id }],
      [`${ID}.${DOMAIN}`, { kind: "artifact", id }],
      [`${id}.ART.EXAMPLE.DEV`, { kind: "artifact", id }],
      [`${id}.${DOMAIN}:443`, { kind: "artifact", id }],
    ];
    for (const [host, expected] of cases) assert.deepEqual(policy.classify(host), expected, host);
  });

  it("rejects unknown labels, foreign domains, IP literals, other ports and a trailing dot", () => {
    for (const host of [
      // unknown or nested labels
      `www.${DOMAIN}`,
      `api.${DOMAIN}`,
      `notanid.${DOMAIN}`,
      `x.${id}.${DOMAIN}`,
      `.${DOMAIN}`,
      `${id}1.${DOMAIN}`,
      // foreign and look-alike domains
      "evil.example",
      `${id}.${DOMAIN}.evil.example`,
      `${id}.evilart.example.dev`,
      `evil${DOMAIN}`,
      "example.dev",
      `${id}.localhost`,
      "localhost",
      // IP literals
      "127.0.0.1",
      "[::1]",
      "10.0.0.1",
      "[::1]:443",
      // port forms
      `${DOMAIN}:80`,
      `${DOMAIN}:8443`,
      `${DOMAIN}:4400`,
      `${DOMAIN}:`,
      `${id}.${DOMAIN}:80`,
      `${id}.${DOMAIN}:`,
      `${DOMAIN}:443:443`,
      // trailing dot
      `${DOMAIN}.`,
      `${id}.${DOMAIN}.`,
      "",
    ]) {
      assert.deepEqual(policy.classify(host), { kind: "reject" }, host);
    }
  });

  it("builds https URLs on the view domain", () => {
    assert.equal(policy.artifactUrl(id), `https://${id}.${DOMAIN}/`);
    assert.equal(policy.galleryUrl(), `https://${DOMAIN}/`);
  });

  it("normalises an uppercase view domain and refuses malformed ones", () => {
    const upper = new DomainHostPolicy({ viewDomain: "ART.Example.DEV" });
    assert.deepEqual(upper.classify(`${id}.${DOMAIN}`), { kind: "artifact", id });
    assert.equal(upper.galleryUrl(), `https://${DOMAIN}/`);
    for (const viewDomain of ["", "https://x", "x:443", ".x", "x.", "x/y", "a..b"]) {
      assert.throws(() => new DomainHostPolicy({ viewDomain }), RangeError, viewDomain);
    }
  });
});

describe("createApp with a DomainHostPolicy", () => {
  function setup() {
    const h = harness();
    const app = createApp({
      service: h.service,
      events: createMemoryNotifier(),
      config: { port: 4400, isolation: "subdomain" },
      hosts: new DomainHostPolicy({ viewDomain: DOMAIN }),
    });
    return { ...h, app };
  }

  it("serves the gallery on the apex and artifacts on <id>.<viewDomain>", async () => {
    const { app, service } = setup();
    const a = unwrap(await service.publish({ title: "A", files: { "index.html": "<p>a</p>" } }));
    const gallery = await app.request(`https://${DOMAIN}/`);
    assert.equal(gallery.status, 200);
    assert.ok((await gallery.text()).includes(`href="https://${a.id}.${DOMAIN}/"`));
    const page = await app.request(`https://${a.id}.${DOMAIN}/`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("<p>a</p>"));
  });

  it("returns view-domain URLs from /api and refuses localhost", async () => {
    const { app } = setup();
    const res = await app.request(`https://${DOMAIN}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "index.html": "<p>1</p>" } }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; url: string };
    assert.equal(body.url, `https://${body.id}.${DOMAIN}/`);
    const list = await app.request(`https://${DOMAIN}/api/artifacts`);
    assert.equal(
      ((await list.json()) as { artifacts: { url: string }[] }).artifacts[0].url,
      body.url,
    );
    const mcp = await connectMcp(`https://${DOMAIN}/mcp`, { handler: app.fetch });
    const listed = await mcp.call("artifact_list", { all: true });
    await mcp.close();
    assert.equal((listed.value.artifacts as { url: string }[])[0].url, body.url);
    for (const url of ["http://localhost:4400/", `http://${body.id}.localhost:4400/`]) {
      assert.equal((await app.request(url)).status, 403, url);
    }
  });
});
