import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { errorBody, httpError, statusFor } from "../../src/http/errors.ts";
import {
  type AppEnv,
  browserGuard,
  classifyHost,
  hasUnsafeSegment,
  hostGuard,
  isBrowserRequest,
  parseIfMatch,
  tokenGuard,
  traversalGuard,
} from "../../src/http/guards.ts";

const id = "01hzx3k5m7n9p1q3r5s7t9v1w3";

describe("classifyHost", () => {
  it("accepts loopback names and valid <id>.localhost on the configured port", () => {
    assert.deepEqual(classifyHost("localhost:4400", 4400), { kind: "main" });
    assert.deepEqual(classifyHost("127.0.0.1:4400", 4400), { kind: "main" });
    assert.deepEqual(classifyHost("[::1]:4400", 4400), { kind: "main" });
    assert.deepEqual(classifyHost("LOCALHOST:4400", 4400), { kind: "main" });
    assert.deepEqual(classifyHost(`${id}.localhost:4400`, 4400), { kind: "artifact", id });
    assert.deepEqual(classifyHost(`${id.toUpperCase()}.localhost:4400`, 4400), {
      kind: "artifact",
      id,
    });
    assert.deepEqual(classifyHost("localhost", 80), { kind: "main" });
  });

  it("refuses other hosts, ports and malformed ids", () => {
    for (const host of [
      "evil.example",
      "evil.example:4400",
      "localhost:4401",
      "localhost",
      "127.0.0.2:4400",
      "notanid.localhost:4400",
      `x.${id}.localhost:4400`,
      `${id}.localhost.evil.example:4400`,
      ".localhost:4400",
      "localhost.:4400",
    ]) {
      assert.equal(classifyHost(host, 4400), undefined, host);
    }
  });
});

describe("hasUnsafeSegment", () => {
  it("flags traversal, encoded separators, control chars and bad escapes", () => {
    for (const path of [
      "/../x",
      "/a/../../x",
      "/%2e%2e/x",
      "/%2E%2e/",
      "/.%2e/x",
      "/a%2fb",
      "/a%2Fb",
      "/a%5cb",
      "/a\\b",
      "/a%00",
      "/a%0a",
      "/%zz",
      "/./x",
      "/a/.",
    ]) {
      assert.equal(hasUnsafeSegment(path), true, path);
    }
  });

  it("allows ordinary paths and ignores the query", () => {
    for (const path of [
      "/",
      "/a/b.html",
      "/a/%20b.html",
      "/?q=..",
      "/v/1/",
      "/a..b/c.css",
      "//x",
    ]) {
      assert.equal(hasUnsafeSegment(path), false, path);
    }
  });
});

describe("parseIfMatch", () => {
  it("accepts a bare or quoted positive integer", () => {
    for (const [value, version] of [
      ["3", 3],
      ['"3"', 3],
      [' "3" ', 3],
      ["12", 12],
    ] as const) {
      assert.deepEqual(parseIfMatch(value), { ok: true, value: version }, value);
    }
  });

  it("rejects wildcards, lists, weak tags and non-canonical numbers", () => {
    for (const value of [
      "*",
      'W/"3"',
      '"1", "2"',
      "1,2",
      "0",
      "03",
      "abc",
      "",
      '"3',
      "9".repeat(20),
    ]) {
      assert.deepEqual(parseIfMatch(value), { ok: false }, value);
    }
  });
});

describe("isBrowserRequest", () => {
  it("is true for any Origin or a Sec-Fetch-Site other than none", () => {
    const is = (h: Record<string, string>) => isBrowserRequest(new Headers(h));
    assert.equal(is({ origin: "null" }), true);
    assert.equal(is({ "sec-fetch-site": "same-origin" }), true);
    assert.equal(is({ "sec-fetch-site": "none" }), false);
    assert.equal(is({ "sec-fetch-mode": "cors", "user-agent": "node" }), false);
    assert.equal(is({}), false);
  });
});

describe("error body", () => {
  it("maps codes to statuses and renames code to error", () => {
    assert.deepEqual(errorBody(httpError("version_conflict", "conflict", { currentVersion: 2 })), {
      error: "version_conflict",
      message: "conflict",
      currentVersion: 2,
    });
    assert.equal(statusFor("invalid_input"), 422);
    assert.equal(statusFor("too_large"), 413);
    assert.equal(statusFor("bad_request"), 400);
  });
});

function app(token?: string) {
  const a = new Hono<AppEnv>();
  a.use(hostGuard(4400));
  a.use(traversalGuard());
  a.use("/api/*", browserGuard());
  a.use("/api/*", tokenGuard(token));
  a.get("*", (c) => c.text("ok"));
  return a;
}

describe("guard middleware", () => {
  it("refuses a foreign Host with 403 and security headers", async () => {
    const res = await app().request("http://evil.example/");
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("rejects traversal in the raw request target", async () => {
    const env = { incoming: { url: "/a/../x" } } as unknown as AppEnv["Bindings"];
    const res = await app().request("http://localhost:4400/x", {}, env);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    const api = await app().request("http://localhost:4400/x", {}, {
      incoming: { url: "/api/%2e%2e/x" },
    } as unknown as AppEnv["Bindings"]);
    assert.equal(api.status, 400);
    assert.equal((await api.json()).error, "bad_request");
  });

  it("refuses every browser request on /api: any Origin, Sec-Fetch-Site other than none", async () => {
    for (const headers of [
      { origin: "http://localhost:4400" },
      { origin: "http://127.0.0.1:4400" },
      { origin: "http://[::1]:4400" },
      { origin: `http://${id}.localhost:4400` },
      { origin: "http://evil.example" },
      { origin: "null" },
      { origin: "" },
      { origin: "http://localhost:4400", "sec-fetch-site": "none" },
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "" },
    ] as Record<string, string>[]) {
      const res = await app().request("http://localhost:4400/api/x", { headers });
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.deepEqual(await res.json(), {
        error: "forbidden",
        message: "the API is not available to web pages; use the CLI or an MCP client",
      });
    }
    for (const headers of [
      {},
      { "sec-fetch-site": "none" },
      { "sec-fetch-mode": "cors" },
    ] as Record<string, string>[]) {
      const res = await app().request("http://localhost:4400/api/x", { headers });
      assert.equal(res.status, 200, JSON.stringify(headers));
    }
    const viewing = await app().request("http://localhost:4400/x", {
      headers: { origin: "http://evil.example" },
    });
    assert.equal(viewing.status, 200);
  });

  it("requires the bearer token on /api only when configured", async () => {
    assert.equal((await app().request("http://localhost:4400/api/x")).status, 200);
    const guarded = app("s3cret");
    const missing = await guarded.request("http://localhost:4400/api/x");
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), "Bearer");
    assert.equal((await missing.json()).error, "unauthorized");
    const wrong = await guarded.request("http://localhost:4400/api/x", {
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(wrong.status, 401);
    const right = await guarded.request("http://localhost:4400/api/x", {
      headers: { authorization: "bearer s3cret" },
    });
    assert.equal(right.status, 200);
    assert.equal((await guarded.request("http://localhost:4400/x")).status, 200);
  });
});
