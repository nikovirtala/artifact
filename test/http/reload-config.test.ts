// The reload client's config prefix (docs/decisions/0058): the served script is one config line
// plus the shared client, run here per config in a VM context.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { createApp } from "../../src/http/app.ts";
import {
  LOCAL_RELOAD_CONFIG,
  type ReloadClientConfig,
  reloadScript,
  renderReloadConfig,
} from "../../src/http/reload.ts";
import { harness } from "../support/fakes.ts";
import { globalsAfter, load, published } from "../support/reload-vm.ts";

const file = readFileSync(new URL("../../src/http/reload-client.js", import.meta.url), "utf8");
const ID = "01m55g1mv87q1zb2gpj07jz10e";
const DOMAIN: ReloadClientConfig = {
  transport: "sse",
  viewSuffix: ".art.example.dev",
  pathMode: false,
};

describe("reload client config prefix", () => {
  it("renders the local config as line 1 of the client file", () => {
    assert.equal(reloadScript(LOCAL_RELOAD_CONFIG), file);
    assert.equal(renderReloadConfig(LOCAL_RELOAD_CONFIG), file.slice(0, file.indexOf("\n")));
  });

  it("swaps exactly one line and keeps the shared client", () => {
    const line = renderReloadConfig(DOMAIN);
    assert.equal(line.includes("\n"), false);
    assert.equal(
      line,
      'const __artifactReloadConfig = { transport: "sse", viewSuffix: ".art.example.dev", pathMode: false };',
    );
    const script = reloadScript(DOMAIN);
    assert.equal(script, `${line}\n${file.slice(file.indexOf("\n") + 1)}`);
    assert.equal(script.split("\n").length, file.split("\n").length);
  });

  it("declares no globals on the page, whatever the config", () => {
    for (const config of [LOCAL_RELOAD_CONFIG, DOMAIN]) {
      assert.deepEqual(globalsAfter(reloadScript(config)), [], config.viewSuffix);
    }
  });
});

describe("reload client, sse, local config", () => {
  const script = reloadScript(LOCAL_RELOAD_CONFIG);

  it("subscribes on a current subdomain page and reloads when the version differs", () => {
    const page = load(script, `http://${ID}.localhost:4400/`);
    assert.equal(page.sources.length, 1);
    const [es] = page.sources;
    assert.equal(es.url, `/__artifact/events?id=${ID}`);
    es.emit("published", published(2));
    assert.equal(page.reloads, 0);
    es.emit("published", published(3));
    assert.equal(page.reloads, 1);
    assert.equal(es.closed, true);
  });

  it("reloads on rollback to an earlier version", () => {
    const page = load(script, `http://${ID}.localhost:4400/docs/`, "3");
    page.sources[0].emit("published", published(1));
    assert.equal(page.reloads, 1);
  });

  it("subscribes in path mode with the id from /a/<id>/ (any case)", () => {
    for (const url of [
      `http://localhost:4400/a/${ID}/`,
      `http://127.0.0.1:4400/a/${ID.toUpperCase()}/page.html`,
    ]) {
      const page = load(script, url);
      assert.equal(page.sources.length, 1, url);
      assert.equal(page.sources[0].url, `/__artifact/events?id=${ID}`, url);
    }
  });

  it("stays inert on pinned /v/<n>/ pages in both modes", () => {
    for (const url of [`http://${ID}.localhost:4400/v/1/`, `http://localhost:4400/a/${ID}/v/3/`]) {
      assert.equal(load(script, url).sources.length, 0, url);
    }
  });

  it("shows a banner on delete and ignores malformed data", () => {
    const page = load(script, `http://${ID}.localhost:4400/`);
    const [es] = page.sources;
    es.emit("published", "not json");
    es.emit("published", "{}");
    assert.equal(page.reloads, 0);
    es.emit("deleted", "{}");
    assert.equal(es.closed, true);
    assert.equal(page.appended[0]?.textContent, "This artifact was deleted.");
  });
});

describe("reload client, sse, domain config", () => {
  const script = reloadScript(DOMAIN);

  it("subscribes on <id>.<view domain> (any case)", () => {
    for (const url of [
      `https://${ID}.art.example.dev/`,
      `https://${ID.toUpperCase()}.ART.example.dev/docs/`,
    ]) {
      const page = load(script, url);
      assert.equal(page.sources.length, 1, url);
      assert.equal(page.sources[0].url, `/__artifact/events?id=${ID}`, url);
      page.sources[0].emit("published", published(3));
      assert.equal(page.reloads, 1, url);
    }
  });

  it("stays inert on pinned pages, path mode and other hosts", () => {
    for (const url of [
      `https://${ID}.art.example.dev/v/1/`,
      `https://art.example.dev/a/${ID}/`,
      `http://localhost:4400/a/${ID}/`,
      `http://${ID}.localhost:4400/`,
      `https://${ID}.evil.example/`,
    ]) {
      assert.equal(load(script, url).sources.length, 0, url);
    }
  });

  it("stays inert with an unknown transport", () => {
    for (const transport of ["carrier-pigeon", "toString", "constructor"]) {
      const unknown = reloadScript({ ...DOMAIN, transport } as unknown as ReloadClientConfig);
      assert.equal(load(unknown, `https://${ID}.art.example.dev/`).sources.length, 0, transport);
    }
  });
});

describe("GET /__artifact/reload.js with a config", () => {
  it("serves the configured prefix followed by the shared client", async () => {
    const { service } = harness();
    const app = createApp({
      service,
      events: createMemoryNotifier(),
      config: { port: 4400, isolation: "subdomain" },
      reload: DOMAIN,
    });
    const res = await app.request("http://localhost:4400/__artifact/reload.js");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
    const body = await res.text();
    assert.ok(body.startsWith(`${renderReloadConfig(DOMAIN)}\n`));
    assert.equal(body, reloadScript(DOMAIN));
  });
});
