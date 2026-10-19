// TokenVerifier port (docs/decisions/0054): the guard parses the header and answers 401; the
// verifier only judges the presented token.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { localTokenVerifier, type TokenVerifier } from "../../src/http/token.ts";
import { harness } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const BASE = "http://localhost:4400";

describe("localTokenVerifier", () => {
  it("accepts exactly the configured token", async () => {
    const verify = localTokenVerifier("s3cret");
    assert.ok(verify);
    assert.equal(await verify("s3cret"), true);
    for (const other of ["nope", "", "s3cre", "s3cret2", "S3CRET"]) {
      assert.equal(await verify(other), false, other);
    }
  });

  it("is absent without a token, so the API stays open", () => {
    assert.equal(localTokenVerifier(undefined), undefined);
  });
});

describe("createApp with a custom verifier", () => {
  function setup(verdict: boolean, config: Partial<AppConfig> = {}) {
    const seen: string[] = [];
    const verifyToken: TokenVerifier = async (presented) => {
      seen.push(presented);
      return verdict;
    };
    const app = createApp({
      service: harness().service,
      events: createMemoryNotifier(),
      config: { port: 4400, isolation: "subdomain", ...config },
      verifyToken,
    });
    const get = (headers: Record<string, string> = {}) =>
      app.request(`${BASE}/api/artifacts`, { headers });
    return { app, seen, get };
  }

  it("gates /api: true lets the request through, false is 401 with WWW-Authenticate", async () => {
    const allow = setup(true);
    const ok = await allow.get({ authorization: "Bearer abc" });
    assert.equal(ok.status, 200);
    assert.deepEqual(allow.seen, ["abc"]);
    const deny = setup(false);
    const res = await deny.get({ authorization: "bearer  xyz " });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await res.json(), {
      error: "unauthorized",
      message: "missing or invalid bearer token",
    });
    assert.deepEqual(deny.seen, ["xyz"]);
  });

  it("gates /mcp", async () => {
    const allow = setup(true);
    const mcp = await connectMcp(`${BASE}/mcp`, {
      handler: allow.app.fetch,
      headers: { authorization: "Bearer abc" },
    });
    const listed = await mcp.call("artifact_list", { all: true });
    await mcp.close();
    assert.equal(listed.isError, false);
    assert.ok(allow.seen.length > 0 && allow.seen.every((t) => t === "abc"));
    const deny = setup(false);
    const res = await deny.app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer abc", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
  });

  it("is never called without or with a malformed Authorization header", async () => {
    const { seen, get } = setup(true);
    for (const headers of [
      {},
      { authorization: "" },
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: "Basic abc" },
      { authorization: "Bearer a b" },
    ] as Record<string, string>[]) {
      assert.equal((await get(headers)).status, 401, JSON.stringify(headers));
    }
    assert.deepEqual(seen, []);
  });

  it("takes precedence over config.token", async () => {
    const { seen, get } = setup(false, { token: "s3cret" });
    assert.equal((await get({ authorization: "Bearer s3cret" })).status, 401);
    assert.deepEqual(seen, ["s3cret"]);
    const open = setup(true, { token: "s3cret" });
    assert.equal((await open.get({ authorization: "Bearer other" })).status, 200);
  });
});
