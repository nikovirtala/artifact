// The browser reload client, run as-is in a VM context with a fake document, location and
// EventSource.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../src/http/reload-client.js", import.meta.url), "utf8");
const ID = "01m55g1mv87q1zb2gpj07jz10e";

type Listener = (event: { data: string }) => void;

class FakeEventSource {
  readonly url: string;
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

type FakeElement = { attributes: Record<string, string>; textContent: string; style: object };

function load(url: string, version: string | null = "2") {
  const { hostname, pathname } = new URL(url);
  const sources: FakeEventSource[] = [];
  const appended: FakeElement[] = [];
  let reloads = 0;
  const element = (): FakeElement & { setAttribute(k: string, v: string): void } => ({
    attributes: {},
    textContent: "",
    style: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
  });
  const context = {
    document: {
      currentScript:
        version === null
          ? null
          : { getAttribute: (k: string) => (k === "data-version" ? version : null) },
      createElement: element,
      body: { appendChild: (e: FakeElement) => appended.push(e) },
      documentElement: { appendChild: (e: FakeElement) => appended.push(e) },
    },
    location: {
      hostname,
      pathname,
      reload: () => {
        reloads++;
      },
    },
    EventSource: class extends FakeEventSource {
      constructor(u: string) {
        super(u);
        sources.push(this);
      }
    },
  };
  runInNewContext(source, context);
  return {
    sources,
    appended,
    get reloads() {
      return reloads;
    },
  };
}

const published = (version: number) => JSON.stringify({ version });

describe("reload client", () => {
  it("subscribes on a current subdomain page and reloads when the version differs", () => {
    const page = load(`http://${ID}.localhost:4400/`);
    assert.equal(page.sources.length, 1);
    const [es] = page.sources;
    assert.equal(es.url, `/__artifact/events?id=${ID}`);
    // The initial event on connect (and on every reconnect) carries the current version.
    es.emit("published", published(2));
    assert.equal(page.reloads, 0);
    es.emit("published", published(3));
    assert.equal(page.reloads, 1);
    assert.equal(es.closed, true);
  });

  it("reloads on rollback to an earlier version", () => {
    const page = load(`http://${ID}.localhost:4400/docs/`, "3");
    page.sources[0].emit("published", published(1));
    assert.equal(page.reloads, 1);
  });

  it("catches up after a reconnect that reports a version it missed", () => {
    const page = load(`http://${ID}.localhost:4400/`);
    const [es] = page.sources;
    es.emit("published", published(2)); // first connect: up to date
    // Connection dropped, server restarted, a publish happened meanwhile; EventSource
    // reconnects (Last-Event-ID: 2) and the server starts with the current version.
    es.emit("published", published(4));
    assert.equal(page.reloads, 1);
  });

  it("subscribes in path mode with the id from /a/<id>/ (any case, any loopback host)", () => {
    for (const url of [
      `http://localhost:4400/a/${ID}/`,
      `http://127.0.0.1:4400/a/${ID.toUpperCase()}/page.html`,
      `http://[::1]:4400/a/${ID}/docs/v/2/x.html`,
    ]) {
      const page = load(url);
      assert.equal(page.sources.length, 1, url);
      assert.equal(page.sources[0].url, `/__artifact/events?id=${ID}`, url);
    }
  });

  it("stays inert on pinned /v/<n>/ pages in both modes", () => {
    for (const url of [
      `http://${ID}.localhost:4400/v/1/`,
      `http://${ID.toUpperCase()}.LOCALHOST:4400/v/12/docs/index.html`,
      `http://localhost:4400/a/${ID}/v/1/`,
      `http://localhost:4400/a/${ID}/v/3/css/site.css`,
    ]) {
      assert.equal(load(url).sources.length, 0, url);
    }
  });

  it("treats v/ deeper than the version root, or a non-canonical number, as current", () => {
    for (const url of [
      `http://${ID}.localhost:4400/docs/v/1/`,
      `http://${ID}.localhost:4400/v/01/`,
      `http://${ID}.localhost:4400/v/x/`,
    ]) {
      assert.equal(load(url).sources.length, 1, url);
    }
  });

  it("does nothing outside an artifact page or without a usable data-version", () => {
    for (const url of [
      "http://localhost:4400/",
      "http://localhost:4400/a/nope/",
      "http://example.localhost:4400/",
    ]) {
      assert.equal(load(url).sources.length, 0, url);
    }
    for (const version of [null, "", "0", "x", "1.5"]) {
      assert.equal(load(`http://${ID}.localhost:4400/`, version).sources.length, 0, `${version}`);
    }
  });

  it("ignores malformed published data", () => {
    const page = load(`http://${ID}.localhost:4400/`);
    page.sources[0].emit("published", "not json");
    page.sources[0].emit("published", "{}");
    assert.equal(page.reloads, 0);
    assert.equal(page.sources[0].closed, false);
  });

  it("shows a banner and stops listening when the artifact is deleted", () => {
    const page = load(`http://${ID}.localhost:4400/`);
    const [es] = page.sources;
    es.emit("deleted", "{}");
    assert.equal(es.closed, true);
    assert.equal(page.reloads, 0);
    assert.equal(page.appended.length, 1);
    const [banner] = page.appended;
    assert.equal(banner.textContent, "This artifact was deleted.");
    assert.equal(banner.attributes.role, "status");
    assert.equal((banner.style as { position?: string }).position, "fixed");
  });

  it("declares no globals on the page", () => {
    const context: Record<string, unknown> = {
      document: { currentScript: null },
      location: { hostname: "localhost", pathname: "/" },
    };
    runInNewContext(source, context);
    assert.deepEqual(Object.keys(context).sort(), ["document", "location"]);
  });
});
