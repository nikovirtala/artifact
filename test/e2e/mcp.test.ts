// The spec's M4 agent scenarios over real sockets: a spawned `serve`, MCP SDK clients on /mcp,
// and an SSE connection standing in for the open browser tab.
import assert from "node:assert/strict";
import { type ClientRequest, request } from "node:http";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { cleanup, freePort, serve, tempRoot } from "../support/e2e.ts";
import { connectMcp } from "../support/mcp.ts";
import { type SseReader, sseReader } from "../support/sse.ts";

after(cleanup);

const open: ClientRequest[] = [];
after(() => {
  for (const req of open) req.destroy();
});

type Got = { status: number; body: string };

/** GET with an explicit Host (fetch cannot set one). */
function get(port: number, path: string, host: string): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The open tab's event stream on the artifact's own origin. */
function events(port: number, id: string): Promise<SseReader> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: `/__artifact/events?id=${id}`,
        headers: { host: `${id}.localhost:${port}` },
      },
      (res) => resolve(sseReader(Readable.toWeb(res) as ReadableStream<Uint8Array>)),
    );
    open.push(req);
    req.on("error", reject);
    req.end();
  });
}

const page = (heading: string) => `<!doctype html><html><body><h1>${heading}</h1></body></html>`;

describe("agent scenarios over MCP (e2e)", () => {
  it("create, republish in the same session, then update by id from a new session", async (t) => {
    const port = await freePort();
    const server = await serve(port, tempRoot());
    const endpoint = `http://localhost:${port}/mcp`;

    // 1. "Make an HTML page": publish without an id creates an artifact and returns its URL.
    const first = await connectMcp(endpoint);
    const created = await first.call("artifact_publish", {
      title: "Greeting",
      files: { "index.html": page("Hello") },
    });
    assert.equal(created.isError, false, JSON.stringify(created.value));
    const { id, url } = created.value as { id: string; url: string };
    assert.equal(created.value.version, 1);
    assert.equal(url, `http://${id}.localhost:${port}/`);
    const served = await get(port, "/", `${id}.localhost:${port}`);
    assert.equal(served.status, 200);
    assert.match(served.body, /<h1>Hello<\/h1>/);
    t.diagnostic(`1. created ${id} v1 at ${url}`);

    // 2. "Change the heading": same session republishes to the id; the open tab is told to reload.
    const tab = await events(port, id);
    assert.deepEqual(await tab.next(), {
      event: "published",
      id: "1",
      retry: "1000",
      data: '{"version":1}',
    });
    const read = await first.call("artifact_read", { id });
    assert.equal(read.value.content, page("Hello"));
    const edited = String(read.value.content).replace("Hello", "Hello, world");
    const republished = await first.call("artifact_publish", {
      id,
      files: { "index.html": edited },
    });
    assert.deepEqual(republished.value, { id, version: 2, url });
    assert.deepEqual(await tab.next(1000), {
      event: "published",
      id: "2",
      data: '{"version":2}',
    });
    t.diagnostic("2. republished v2; open tab received published v2");
    await first.close();

    // 3. A new session finds the artifact via artifact_list and updates it by id.
    const second = await connectMcp(endpoint);
    const listed = await second.call("artifact_list");
    const artifacts = listed.value.artifacts as { id: string; title?: string; url: string }[];
    assert.equal(artifacts.length, 1);
    const found = artifacts.find((a) => a.title === "Greeting");
    assert.ok(found);
    assert.equal(found.id, id);
    const updated = await second.call("artifact_publish", {
      id: found.id,
      files: { "index.html": page("Updated from a new session") },
    });
    assert.deepEqual(updated.value, { id, version: 3, url });
    assert.equal((await tab.next(1000))?.data, '{"version":3}');
    const afterUpdate = await second.call("artifact_list");
    assert.equal((afterUpdate.value.artifacts as unknown[]).length, 1);
    t.diagnostic("3. new session listed 1 artifact, updated it to v3; count still 1");
    await second.close();

    await tab.cancel();
    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });

  it("a new session with the same project, spelled differently, finds and updates it", async (t) => {
    const port = await freePort();
    const server = await serve(port, tempRoot());
    const endpoint = `http://localhost:${port}/mcp`;

    const first = await connectMcp(endpoint);
    const created = await first.call("artifact_publish", {
      title: "Report",
      project: "git@github.com:Acme/Widgets.git",
      files: { "index.html": page("Report") },
    });
    assert.equal(created.isError, false, JSON.stringify(created.value));
    const { id, url } = created.value as { id: string; url: string };
    assert.equal(created.value.project, "github.com/acme/widgets");
    // Noise from other codebases and from before projects existed.
    await first.call("artifact_publish", {
      title: "Report",
      project: "https://github.com/acme/other",
      files: { "index.html": page("Other") },
    });
    await first.call("artifact_publish", { title: "Report", files: { "index.html": page("Old") } });
    await first.close();
    t.diagnostic(`session 1 created ${id} in github.com/acme/widgets (+2 unrelated)`);

    const second = await connectMcp(endpoint);
    const listed = await second.call("artifact_list", {
      project: "https://github.com/acme/widgets",
    });
    const artifacts = listed.value.artifacts as { id: string; project?: string }[];
    assert.deepEqual(
      artifacts.map((a) => [a.id, a.project]),
      [[id, "github.com/acme/widgets"]],
    );
    const updated = await second.call("artifact_publish", {
      id,
      project: "https://github.com/acme/widgets",
      files: { "index.html": page("Report v2") },
    });
    assert.deepEqual(
      [updated.value.id, updated.value.version, updated.value.url, updated.value.project],
      [id, 2, url, "github.com/acme/widgets"],
    );
    const again = await second.call("artifact_list", { project: "github.com/acme/widgets" });
    assert.equal((again.value.artifacts as unknown[]).length, 1);
    const all = await second.call("artifact_list", { all: true });
    assert.equal((all.value.artifacts as unknown[]).length, 3);
    t.diagnostic(
      "session 2 (https spelling) listed 1, updated it to v2; still 1 in project, 3 total",
    );
    await second.close();

    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });

  it("rejects browser requests with 403 and enforces ARTIFACT_TOKEN on /mcp", async () => {
    const port = await freePort();
    const server = await serve(port, tempRoot(), { ARTIFACT_TOKEN: "e2e-token" });
    const endpoint = `http://localhost:${port}/mcp`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body,
      });
    const auth = { authorization: "Bearer e2e-token" };

    const fromArtifact = await post({
      ...auth,
      origin: `http://01hzx3k5m7n9p1q3r5s7t9v1w3.localhost:${port}`,
    });
    assert.equal(fromArtifact.status, 403);
    assert.equal((await fromArtifact.json()).error, "forbidden");
    for (const page of [
      { origin: `http://localhost:${port}` },
      { "sec-fetch-site": "same-origin" },
    ] as Record<string, string>[]) {
      const res = await post({ ...auth, ...page });
      assert.equal(res.status, 403, JSON.stringify(page));
    }
    const noToken = await post({});
    assert.equal(noToken.status, 401);
    assert.equal(noToken.headers.get("www-authenticate"), "Bearer");
    assert.equal((await post(auth)).status, 200);

    await assert.rejects(connectMcp(endpoint));
    const client = await connectMcp(endpoint, { headers: auth });
    assert.equal((await client.client.listTools()).tools.length, 5);
    await client.close();

    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });
});
