// Raw request target through a server-adapter hook (docs/decisions/0055).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { createApp } from "../../src/http/app.ts";
import { type AppEnv, hostGuard, rawTarget, traversalGuard } from "../../src/http/guards.ts";
import { nodeServerRawTarget, type RawTargetHook } from "../../src/http/raw-target.ts";
import { harness } from "../support/fakes.ts";

const BASE = "http://localhost:4400";

type LambdaEnv = { event?: { rawPath: string; rawQueryString: string } };

/** What a Lambda adapter would pass: API Gateway's undecoded `rawPath` and `rawQueryString`. */
const lambdaRawTarget: RawTargetHook = (c) => {
  const event = (c.env as unknown as LambdaEnv | undefined)?.event;
  if (!event) return undefined;
  return event.rawQueryString ? `${event.rawPath}?${event.rawQueryString}` : event.rawPath;
};

const lambda = (rawPath: string, rawQueryString = "") =>
  ({ event: { rawPath, rawQueryString } }) as unknown as AppEnv["Bindings"];
const node = (url: string) => ({ incoming: { url } }) as unknown as AppEnv["Bindings"];

/** Echoes the raw target the guard saw. */
function echo(hook?: RawTargetHook, withHostGuard = true) {
  const a = new Hono<AppEnv>();
  if (withHostGuard) a.use(hostGuard(4400));
  a.use(traversalGuard(undefined, hook));
  a.all("*", (c) => c.text(rawTarget(c, hook)));
  return a;
}

describe("nodeServerRawTarget", () => {
  it("reads env.incoming.url, and is undefined without it", async () => {
    const res = await echo(nodeServerRawTarget).request(`${BASE}/x`, {}, node("/x?a=%2F"));
    assert.equal(await res.text(), "/x?a=%2F");
    const none = await echo(nodeServerRawTarget).request(`${BASE}/y?b=1`);
    assert.equal(await none.text(), "/y?b=1");
  });

  it("is the default hook", async () => {
    const res = await echo().request(`${BASE}/x`, {}, node("/a/../x"));
    assert.equal(res.status, 400);
  });
});

describe("a Lambda-shaped hook", () => {
  const app = () =>
    createApp({
      service: harness().service,
      events: createMemoryNotifier(),
      config: { port: 4400, isolation: "subdomain" },
      rawTarget: lambdaRawTarget,
    });

  it("rejects traversal in the raw path while the URL is clean", async () => {
    const page = await app().request(`${BASE}/a/x`, {}, lambda("/a/%2e%2e/x"));
    assert.equal(page.status, 400);
    assert.equal(page.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await page.text(), "bad request: unsafe path\n");
    const api = await app().request(`${BASE}/api/x`, {}, lambda("/api/%2e%2e/x"));
    assert.equal(api.status, 400);
    assert.equal((await api.json()).error, "bad_request");
  });

  it("passes safe raw targets through", async () => {
    const res = await app().request(
      `${BASE}/api/artifacts`,
      {},
      lambda("/api/artifacts", "limit=5"),
    );
    assert.equal(res.status, 200);
    const seen = await echo(lambdaRawTarget).request(
      `${BASE}/a/b.html`,
      {},
      lambda("/a/b.html", "q=.."),
    );
    assert.equal(seen.status, 200);
    assert.equal(await seen.text(), "/a/b.html?q=..");
  });

  it("falls back to the URL when the hook returns undefined", async () => {
    const res = await echo(lambdaRawTarget).request(`${BASE}/x?q=1`, {}, node("/a/../x"));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "/x?q=1");
    const never: RawTargetHook = () => undefined;
    assert.equal(await (await echo(never).request(`${BASE}/z`)).text(), "/z");
  });
});

describe("traversalGuard without a host guard", () => {
  it("treats the request as the main host", async () => {
    const api = await echo(lambdaRawTarget, false).request(
      `${BASE}/api/x`,
      {},
      lambda("/api/%2e%2e"),
    );
    assert.equal(api.status, 400);
    assert.equal((await api.json()).error, "bad_request");
    const page = await echo(lambdaRawTarget, false).request(`${BASE}/x`, {}, lambda("/%2e%2e/x"));
    assert.equal(page.status, 400);
    assert.equal(page.headers.get("content-type"), "text/plain; charset=utf-8");
  });
});
