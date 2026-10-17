// Live reload over real sockets: a spawned `serve`, SSE connections, publishes via the API.
import assert from "node:assert/strict";
import { type ClientRequest, request } from "node:http";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { cleanup, freePort, serve, tempRoot } from "../support/e2e.ts";
import { type SseReader, sseReader } from "../support/sse.ts";

after(cleanup);

/** Delivery budget from the API response to the SSE event (the spec allows 1 s to reload). */
const BUDGET_MS = 1000;

type Connection = { status: number; sse: SseReader; close(): void };
const open: ClientRequest[] = [];
after(() => {
  for (const req of open) req.destroy();
});

/** GET `path` with an explicit Host (fetch cannot set one), as a stream of SSE frames. */
function connect(
  port: number,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { ...headers, host } }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        sse: sseReader(Readable.toWeb(res) as ReadableStream<Uint8Array>),
        close: () => req.destroy(),
      });
    });
    open.push(req);
    req.on("error", reject);
    req.end();
  });
}

async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const page = (n: number) => ({ files: { "index.html": `<body>v${n}</body>` } });

describe("live reload (e2e)", () => {
  it("delivers published within 1 s of a publish and of a rollback, in both modes", async (t) => {
    const port = await freePort();
    const server = await serve(port, tempRoot());
    const created = await api(port, "POST", "/artifacts", page(1));
    assert.equal(created.status, 201);
    const { id } = created.json;

    for (const [mode, host, query] of [
      ["subdomain", `${id}.localhost:${port}`, `?id=${id}`],
      ["path", `localhost:${port}`, `?id=${id}`],
    ]) {
      const { status, sse, close } = await connect(port, `/__artifact/events${query}`, host);
      assert.equal(status, 200, mode);
      assert.equal((await sse.next())?.event, "published", mode);

      let started = performance.now();
      const published = await api(port, "PUT", `/artifacts/${id}`, page(2));
      assert.equal(published.status, 200);
      const onPublish = await sse.next(BUDGET_MS);
      const publishMs = performance.now() - started;
      const { version } = published.json;
      assert.deepEqual(onPublish, {
        event: "published",
        id: String(version),
        data: JSON.stringify({ version }),
      });

      started = performance.now();
      const rolledBack = await api(port, "POST", `/artifacts/${id}/rollback`, { version: 1 });
      assert.equal(rolledBack.status, 200);
      const onRollback = await sse.next(BUDGET_MS);
      const rollbackMs = performance.now() - started;
      assert.deepEqual(onRollback, { event: "published", id: "1", data: '{"version":1}' });

      // Measured from sending the API request, so this includes the publish itself.
      assert.ok(publishMs < BUDGET_MS, `${mode} publish: ${publishMs} ms`);
      assert.ok(rollbackMs < BUDGET_MS, `${mode} rollback: ${rollbackMs} ms`);
      t.diagnostic(
        `${mode}: publish→event ${publishMs.toFixed(1)} ms, rollback→event ${rollbackMs.toFixed(1)} ms`,
      );
      close();
    }

    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });

  it("serves reload.js on both origins and 404s events for an unknown id", async () => {
    const port = await freePort();
    const server = await serve(port, tempRoot());
    const { id } = (await api(port, "POST", "/artifacts", page(1))).json;
    for (const host of [`${id}.localhost:${port}`, `localhost:${port}`]) {
      const { status, close } = await connect(port, "/__artifact/reload.js", host);
      assert.equal(status, 200, host);
      close();
    }
    const unknown = await connect(
      port,
      "/__artifact/events?id=0000000000000000000000000z",
      `localhost:${port}`,
    );
    assert.equal(unknown.status, 404);
    unknown.close();
    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });

  it("after a restart, a reconnect with a stale Last-Event-ID gets the current version", async () => {
    const port = await freePort();
    const root = tempRoot();
    let server = await serve(port, root);
    const { id } = (await api(port, "POST", "/artifacts", page(1))).json;
    const host = `${id}.localhost:${port}`;
    const before = await connect(port, `/__artifact/events?id=${id}`, host);
    assert.equal((await before.sse.next())?.id, "1");

    // The server goes away: the open stream ends (a reset), as EventSource would see it.
    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
    assert.equal(await before.sse.next().catch(() => undefined), undefined);

    // Back up, and a publish lands before the tab reconnects.
    server = await serve(port, root);
    assert.equal((await api(port, "PUT", `/artifacts/${id}`, page(2))).status, 200);
    const reconnected = await connect(port, `/__artifact/events?id=${id}`, host, {
      "Last-Event-ID": "1",
    });
    assert.equal(reconnected.status, 200);
    const first = await reconnected.sse.next(BUDGET_MS);
    assert.deepEqual(first, {
      event: "published",
      id: "2",
      data: '{"version":2}',
      retry: "1000",
    });
    reconnected.close();
    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });

  it("delivers deleted on DELETE and ends the stream", async () => {
    const port = await freePort();
    const server = await serve(port, tempRoot());
    const { id } = (await api(port, "POST", "/artifacts", page(1))).json;
    const { sse } = await connect(port, `/__artifact/events?id=${id}`, `${id}.localhost:${port}`);
    await sse.next();
    assert.equal((await api(port, "DELETE", `/artifacts/${id}`)).status, 204);
    assert.deepEqual(await sse.next(BUDGET_MS), { event: "deleted", data: "{}" });
    assert.equal(await sse.next(), undefined);
    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });
});
