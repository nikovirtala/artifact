import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { harness } from "../support/fakes.ts";

const PORT = 4400;
const BASE = `http://localhost:${PORT}`;
const json = { "content-type": "application/json" };

function setup(config: Partial<AppConfig> = {}) {
  const h = harness();
  const app = createApp({
    service: h.service,
    events: createMemoryNotifier(),
    config: { port: PORT, isolation: "subdomain", ...config },
  });
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${BASE}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : json), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const create = async (body: unknown = { files: { "index.html": "<p>1</p>" } }) => {
    const res = await call("POST", "/api/artifacts", body);
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()) as { id: string; version: number; url: string };
  };
  return { ...h, app, call, create };
}

describe("POST /api/artifacts", () => {
  it("creates an artifact: 201 with id, version, url, ETag and Location", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/artifacts", {
      title: "T",
      files: { "index.html": "<p>hi</p>", "a.png": { base64: "iVBORw0KGgo=" } },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.version, 1);
    assert.equal(body.url, `http://${body.id}.localhost:${PORT}/`);
    assert.equal(res.headers.get("etag"), '"1"');
    assert.equal(res.headers.get("location"), `/api/artifacts/${body.id}`);
    const png = await call("GET", `/api/artifacts/${body.id}/files/a.png`);
    assert.deepEqual(
      new Uint8Array(await png.arrayBuffer()),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("returns path-style urls with isolation path", async () => {
    const { create } = setup({ isolation: "path" });
    const { id, url } = await create();
    assert.equal(url, `http://localhost:${PORT}/a/${id}/`);
  });
});

describe("GET /api/artifacts", () => {
  it("lists newest first with urls, honouring limit", async () => {
    const { call, create, clock } = setup();
    const a = await create({ title: "a", files: { "index.html": "a" } });
    clock.advance(1000);
    const b = await create({ files: { "index.html": "b" } });
    const res = await call("GET", "/api/artifacts");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      artifacts: [
        { id: b.id, currentVersion: 1, updatedAt: "2026-10-17T12:00:01.000Z", url: b.url },
        {
          id: a.id,
          title: "a",
          currentVersion: 1,
          updatedAt: "2026-10-17T12:00:00.000Z",
          url: a.url,
        },
      ],
    });
    const one = await (await call("GET", "/api/artifacts?limit=1")).json();
    assert.deepEqual(
      one.artifacts.map((x: { id: string }) => x.id),
      [b.id],
    );
    assert.equal((await call("GET", "/api/artifacts?limit=500")).status, 200);
  });

  it("defaults to 50 items", async () => {
    const { call, create } = setup();
    for (let i = 0; i < 51; i++) await create();
    assert.equal((await (await call("GET", "/api/artifacts")).json()).artifacts.length, 50);
  });

  it("rejects bad limits with 400", async () => {
    const { call } = setup();
    for (const q of [
      "limit=0",
      "limit=501",
      "limit=abc",
      "limit=1.5",
      "limit=01",
      "limit=",
      "limit=1&limit=2",
    ]) {
      const res = await call("GET", `/api/artifacts?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal((await res.json()).error, "bad_request");
    }
  });
});

describe("GET /api/artifacts/:id and files", () => {
  it("returns details with url and ETag", async () => {
    const { call, create } = setup();
    const { id, url } = await create({ title: "T", label: "first", files: { "index.html": "x" } });
    const res = await call("GET", `/api/artifacts/${id}`);
    assert.equal(res.headers.get("etag"), '"1"');
    assert.deepEqual(await res.json(), {
      id,
      title: "T",
      currentVersion: 1,
      createdAt: "2026-10-17T12:00:00.000Z",
      updatedAt: "2026-10-17T12:00:00.000Z",
      versions: [{ version: 1, createdAt: "2026-10-17T12:00:00.000Z", label: "first" }],
      url,
    });
  });

  it("returns src bytes by version with a sandbox CSP", async () => {
    const { call, create } = setup();
    const { id } = await create({ files: { "index.html": "<p>1</p>", "d/x.json": "{}" } });
    await call("PUT", `/api/artifacts/${id}`, { files: { "index.html": "<p>2</p>" } });
    const current = await call("GET", `/api/artifacts/${id}/files/index.html`);
    assert.equal(await current.text(), "<p>2</p>");
    assert.equal(current.headers.get("x-artifact-version"), "2");
    assert.equal(current.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(current.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(current.headers.get("x-content-type-options"), "nosniff");
    const pinned = await call("GET", `/api/artifacts/${id}/files/index.html?version=1`);
    assert.equal(await pinned.text(), "<p>1</p>");
    assert.equal(
      await (await call("GET", `/api/artifacts/${id}/files/d/x.json?version=1`)).text(),
      "{}",
    );
    assert.equal(
      (await call("GET", `/api/artifacts/${id}/files/index.html?version=abc`)).status,
      400,
    );
    assert.equal(
      (await call("GET", `/api/artifacts/${id}/files/index.html?version=0`)).status,
      400,
    );
    assert.equal(
      (await call("GET", `/api/artifacts/${id}/files/index.html?version=9`)).status,
      404,
    );
    assert.equal((await call("GET", `/api/artifacts/${id}/files/nope.css`)).status, 404);
  });

  it("maps unknown ids to 404 and malformed ids to 422 invalid_input", async () => {
    const { call } = setup();
    const unknown = await call("GET", "/api/artifacts/0000000000000000000000000z");
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, "not_found");
    const bad = await call("GET", "/api/artifacts/NOT-AN-ID");
    assert.equal(bad.status, 422);
    const body = await bad.json();
    assert.equal(body.error, "invalid_input");
    assert.equal(body.field, "id");
    assert.match(body.message, /artifact_list/);
    const route = await call("GET", "/api/nope");
    assert.equal(route.status, 404);
    assert.equal((await route.json()).error, "not_found");
  });
});

describe("PUT /api/artifacts/:id", () => {
  it("updates with If-Match bare or quoted, 409 when stale", async () => {
    const { call, create } = setup();
    const { id } = await create();
    const ok = await call(
      "PUT",
      `/api/artifacts/${id}`,
      { files: { "index.html": "2" } },
      { "if-match": "1" },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("etag"), '"2"');
    assert.deepEqual(await ok.json(), {
      id,
      version: 2,
      url: `http://${id}.localhost:${PORT}/`,
      opened: false,
    });
    const quoted = await call(
      "PUT",
      `/api/artifacts/${id}`,
      { files: { "index.html": "3" } },
      { "if-match": '"2"' },
    );
    assert.equal(quoted.status, 200);
    const stale = await call(
      "PUT",
      `/api/artifacts/${id}`,
      { files: { "index.html": "x" } },
      { "if-match": "1" },
    );
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.error, "version_conflict");
    assert.equal(body.currentVersion, 3);
    const viaBody = await call("PUT", `/api/artifacts/${id}`, {
      if_version: 1,
      files: { "index.html": "x" },
    });
    assert.equal(viaBody.status, 409);
  });

  it("rejects bad If-Match and header/body disagreement with 400", async () => {
    const { call, create } = setup();
    const { id } = await create();
    for (const value of ["*", 'W/"1"', '"1", "2"', "0"]) {
      const res = await call(
        "PUT",
        `/api/artifacts/${id}`,
        { files: { "index.html": "x" } },
        { "if-match": value },
      );
      assert.equal(res.status, 400, value);
    }
    const disagree = await call(
      "PUT",
      `/api/artifacts/${id}`,
      { if_version: 2, files: { "index.html": "x" } },
      { "if-match": "1" },
    );
    assert.equal(disagree.status, 400);
    const agree = await call(
      "PUT",
      `/api/artifacts/${id}`,
      { if_version: 1, files: { "index.html": "x" } },
      { "if-match": "1" },
    );
    assert.equal(agree.status, 200);
  });
});

describe("GET /api/artifacts/:id/versions/:version", () => {
  it("returns the version's manifest", async () => {
    const { call, create } = setup();
    const { id } = await create({ label: "first", files: { "index.html": "x", "a/b.json": "{}" } });
    const res = await call("GET", `/api/artifacts/${id}/versions/1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["id", "version", "createdAt", "label", "files"]);
    assert.equal(body.id, id);
    assert.equal(body.version, 1);
    assert.equal(body.label, "first");
    assert.deepEqual(
      body.files.map((f: { path: string; size: number }) => [f.path, f.size]),
      [
        ["a/b.json", 2],
        ["index.html", 1],
      ],
    );
    assert.match(body.files[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(body.files[0].contentType, "application/json");
  });

  it("is 404 for unknown artifacts and versions, 400 for a malformed version", async () => {
    const { call, create, store } = setup();
    const { id } = await create();
    await store.put(`artifacts/${id}/v/2/manifest.json`, new TextEncoder().encode("{}"));
    for (const path of [
      `/api/artifacts/${id}/versions/2`,
      `/api/artifacts/${id}/versions/9`,
      "/api/artifacts/0000000000000000000000000z/versions/1",
    ]) {
      const res = await call("GET", path);
      assert.equal(res.status, 404, path);
      assert.equal((await res.json()).error, "not_found");
    }
    for (const version of ["0", "x", "01", "1.5"]) {
      const res = await call("GET", `/api/artifacts/${id}/versions/${version}`);
      assert.equal(res.status, 400, version);
      assert.equal((await res.json()).error, "bad_request");
    }
  });

  it("is behind the browser and token guards", async () => {
    const { call, create } = setup();
    const { id } = await create();
    const browser = await call("GET", `/api/artifacts/${id}/versions/1`, undefined, {
      "sec-fetch-site": "same-origin",
    });
    assert.equal(browser.status, 403);
    const guarded = setup({ token: "s3cret" });
    const res = await guarded.call("GET", `/api/artifacts/${id}/versions/1`);
    assert.equal(res.status, 401);
  });
});

describe("rollback and delete", () => {
  it("rolls back with 200 + ETag and emits a published event", async () => {
    const { call, create, notifier } = setup();
    const { id } = await create();
    await call("PUT", `/api/artifacts/${id}`, { files: { "index.html": "2" } });
    const res = await call("POST", `/api/artifacts/${id}/rollback`, { version: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("etag"), '"1"');
    assert.equal((await res.json()).version, 1);
    assert.deepEqual(notifier.events.at(-1), { type: "published", id, version: 1 });
    assert.equal((await call("POST", `/api/artifacts/${id}/rollback`, { version: 7 })).status, 404);
    assert.equal(
      (await call("POST", `/api/artifacts/${id}/rollback`, { version: "1" })).status,
      422,
    );
  });

  it("deletes with 204, then 404", async () => {
    const { call, create } = setup();
    const { id } = await create();
    const res = await call("DELETE", `/api/artifacts/${id}`);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.equal((await call("GET", `/api/artifacts/${id}`)).status, 404);
    assert.equal((await call("DELETE", `/api/artifacts/${id}`)).status, 404);
  });
});

describe("API errors", () => {
  it("maps request and core failures to the documented codes", async () => {
    const { call } = setup();
    const badJson = await call("POST", "/api/artifacts", "{nope");
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, "bad_request");

    const schema = await call("POST", "/api/artifacts", { files: { "index.html": 1 } });
    assert.equal(schema.status, 422);
    const schemaBody = await schema.json();
    assert.equal(schemaBody.error, "invalid_request");
    assert.ok(Array.isArray(schemaBody.issues) && schemaBody.issues.length > 0);

    const b64 = await call("POST", "/api/artifacts", {
      files: { "index.html": "x", "a.png": { base64: "%%%" } },
    });
    assert.equal(b64.status, 422);
    const b64Body = await b64.json();
    assert.equal(b64Body.error, "invalid_request");
    assert.deepEqual(b64Body.issues[0].path, ["files", "a.png", "base64"]);

    const reserved = await call("POST", "/api/artifacts", {
      files: { "index.html": "x", "v/x.html": "y" },
    });
    assert.equal(reserved.status, 422);
    assert.deepEqual((({ error, path }) => ({ error, path }))(await reserved.json()), {
      error: "invalid_path",
      path: "v/x.html",
    });

    const label = await call("POST", "/api/artifacts", {
      label: "x".repeat(61),
      files: { "index.html": "x" },
    });
    assert.equal(label.status, 422);
    const labelBody = await label.json();
    assert.deepEqual(
      [labelBody.error, labelBody.field, labelBody.limit],
      ["invalid_input", "label", 60],
    );

    const big = await call("POST", "/api/artifacts", {
      files: { "index.html": "x", "big.txt": "x".repeat(16 * 1024 * 1024 + 1) },
    });
    assert.equal(big.status, 413);
    const bigBody = await big.json();
    assert.deepEqual(
      [bigBody.error, bigBody.subject, bigBody.limit],
      ["too_large", "file", 16 * 1024 * 1024],
    );

    const badId = await call("PUT", "/api/artifacts/nope", { files: { "index.html": "x" } });
    assert.equal(badId.status, 422);
    assert.equal((await badId.json()).field, "id");
  });
});

describe("API guards", () => {
  it("rejects every Origin; allows no Origin or Sec-Fetch-Site: none", async () => {
    const { call, create } = setup();
    const { id } = await create();
    for (const origin of [
      `http://${id}.localhost:${PORT}`,
      "http://evil.example",
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`,
    ]) {
      const get = await call("GET", "/api/artifacts", undefined, { origin });
      assert.equal(get.status, 403, origin);
      assert.equal((await get.json()).error, "forbidden");
      const post = await call(
        "POST",
        "/api/artifacts",
        { files: { "index.html": "x" } },
        { origin },
      );
      assert.equal(post.status, 403, origin);
    }
    assert.equal((await call("GET", "/api/artifacts")).status, 200);
    assert.equal(
      (await call("GET", "/api/artifacts", undefined, { "sec-fetch-site": "none" })).status,
      200,
    );
  });

  it("rejects browser requests even with a valid token", async () => {
    const { call } = setup({ token: "s3cret" });
    const res = await call("GET", "/api/artifacts", undefined, {
      authorization: "Bearer s3cret",
      "sec-fetch-site": "same-origin",
    });
    assert.equal(res.status, 403);
  });

  it("refuses a same-origin path-mode page deleting another artifact", async () => {
    const { call, create, service } = setup({ isolation: "path" });
    const victim = await create();
    const res = await call("DELETE", `/api/artifacts/${victim.id}`, undefined, {
      origin: `http://localhost:${PORT}`,
      "sec-fetch-site": "same-origin",
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      error: "forbidden",
      message: "the API is not available to web pages; use the CLI or an MCP client",
    });
    assert.equal((await service.read(victim.id)).ok, true);
  });

  it("requires the token on /api when set; viewing stays open", async () => {
    const { call, app, service } = setup({ token: "s3cret" });
    const missing = await call("GET", "/api/artifacts");
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), "Bearer");
    const ok = await call(
      "POST",
      "/api/artifacts",
      { files: { "index.html": "x" } },
      { authorization: "Bearer s3cret" },
    );
    assert.equal(ok.status, 201);
    const { id } = await ok.json();
    assert.equal((await service.read(id)).ok, true);
    assert.equal((await app.request(`http://${id}.localhost:${PORT}/`)).status, 200);
    assert.equal((await app.request(`${BASE}/a/${id}/`)).status, 200);
  });

  it("serves /api on an <id>.localhost host as artifact viewing, not the API", async () => {
    const { app, create } = setup();
    const { id } = await create();
    const res = await app.request(`http://${id}.localhost:${PORT}/api/artifacts`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  });
});

describe("projects on the API", () => {
  it("stores the normalised project, filters the list and keeps it on update", async () => {
    const { call, create, clock } = setup();
    const a = await create({ project: "git@github.com:Acme/A.git", files: { "index.html": "a" } });
    assert.equal((a as { project?: string }).project, "github.com/acme/a");
    clock.advance(1000);
    const b = await create({ project: "https://github.com/acme/b", files: { "index.html": "b" } });
    clock.advance(1000);
    const none = await create();
    const ids = async (query: string) =>
      (
        (await (await call("GET", `/api/artifacts${query}`)).json()).artifacts as { id: string }[]
      ).map((x) => x.id);
    const q = encodeURIComponent("https://github.com/acme/a");
    assert.deepEqual(await ids(`?project=${q}`), [a.id]);
    assert.deepEqual(await ids(`?project=github.com/acme/b`), [b.id]);
    assert.deepEqual(await ids(""), [none.id, b.id, a.id]);
    const listed = await (await call("GET", `/api/artifacts?project=${q}`)).json();
    assert.equal(listed.artifacts[0].project, "github.com/acme/a");
    const details = await (await call("GET", `/api/artifacts/${a.id}`)).json();
    assert.equal(details.project, "github.com/acme/a");

    const put = await call("PUT", `/api/artifacts/${a.id}`, {
      project: "https://github.com/acme/b",
      files: { "index.html": "a2" },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), {
      id: a.id,
      version: 2,
      url: a.url,
      project: "github.com/acme/a",
      opened: false,
    });
    assert.deepEqual(await ids(`?project=${q}`), [a.id]);
  });

  it("rejects an invalid project with 422 and a repeated one with 400", async () => {
    const { call } = setup();
    const post = await call("POST", "/api/artifacts", {
      project: "local:rel",
      files: { "index.html": "x" },
    });
    assert.equal(post.status, 422);
    const body = await post.json();
    assert.deepEqual([body.error, body.field], ["invalid_input", "project"]);
    const list = await call("GET", "/api/artifacts?project=");
    assert.equal(list.status, 422);
    assert.equal((await list.json()).field, "project");
    const repeated = await call("GET", "/api/artifacts?project=a/b&project=a/b");
    assert.equal(repeated.status, 400);
    assert.equal((await repeated.json()).error, "bad_request");
  });
});
