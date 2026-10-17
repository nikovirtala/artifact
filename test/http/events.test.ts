import assert from "node:assert/strict";
import { request } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import { type AppConfig, createApp } from "../../src/http/app.ts";
import { listen } from "../../src/http/server.ts";
import { HEARTBEAT_MS, RETRY_MS } from "../../src/http/sse.ts";
import { harness, recordingNotifier, unwrap } from "../support/fakes.ts";
import { sseReader, waitFor } from "../support/sse.ts";

const PORT = 4400;

async function setup(config: Partial<AppConfig> = {}) {
  const events = createMemoryNotifier();
  const h = harness({ notifier: recordingNotifier((e) => void events.notify(e)) });
  const { service } = h;
  const { id } = unwrap(await service.publish({ files: { "index.html": "one" } }));
  unwrap(await service.publish({ id, files: { "index.html": "two" } }));
  const app = createApp({
    service,
    events,
    config: { port: PORT, isolation: "subdomain", ...config },
  });
  const connect = (host = `localhost:${PORT}`, query = `?id=${id}`, init?: RequestInit) =>
    app.request(`http://${host}/__artifact/events${query}`, init);
  return { ...h, app, id, events, connect };
}

const publishedFrame = (version: number) => ({
  event: "published",
  id: String(version),
  data: JSON.stringify({ version }),
});

describe("GET /__artifact/events", () => {
  it("opens an SSE stream that starts with the current version", async () => {
    const { connect, events, id } = await setup();
    const res = await connect();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const sse = sseReader(res.body);
    assert.deepEqual(await sse.next(), { ...publishedFrame(2), retry: String(RETRY_MS) });
    assert.equal(events.listenerCount(id), 1);
    await sse.cancel();
    await waitFor(() => events.listenerCount(id) === 0, "unsubscribe");
  });

  it("sends published on publish and on rollback", async () => {
    const { connect, service, id } = await setup();
    const sse = sseReader((await connect()).body);
    assert.equal((await sse.next())?.id, "2");
    unwrap(await service.publish({ id, files: { "index.html": "three" } }));
    assert.deepEqual(await sse.next(), publishedFrame(3));
    unwrap(await service.rollback(id, 1));
    assert.deepEqual(await sse.next(), publishedFrame(1));
    await sse.cancel();
  });

  it("only sends events of the requested artifact", async () => {
    const { connect, service, id } = await setup();
    const other = unwrap(await service.publish({ files: { "index.html": "x" } }));
    const sse = sseReader((await connect()).body);
    await sse.next();
    unwrap(await service.publish({ id: other.id, files: { "index.html": "y" } }));
    unwrap(await service.publish({ id, files: { "index.html": "three" } }));
    assert.deepEqual(await sse.next(), publishedFrame(3));
    await sse.cancel();
  });

  it("replies to a reconnect with the current version, whatever Last-Event-ID says", async () => {
    const { connect, service, id } = await setup();
    // Missed a publish while disconnected: loaded v1, current is v2.
    for (const lastEventId of ["1", "2", "99", "garbage", ""]) {
      const res = await connect(undefined, undefined, {
        headers: { "Last-Event-ID": lastEventId },
      });
      assert.equal(res.status, 200, lastEventId);
      const sse = sseReader(res.body);
      assert.deepEqual(await sse.next(), { ...publishedFrame(2), retry: String(RETRY_MS) });
      await sse.cancel();
    }
    unwrap(await service.publish({ id, files: { "index.html": "three" } }));
    const sse = sseReader(
      (await connect(undefined, undefined, { headers: { "Last-Event-ID": "2" } })).body,
    );
    assert.equal((await sse.next())?.data, '{"version":3}');
    await sse.cancel();
  });

  it("sends deleted and ends the stream on delete", async () => {
    const { connect, service, events, id } = await setup();
    const sse = sseReader((await connect()).body);
    await sse.next();
    unwrap(await service.delete(id));
    assert.deepEqual(await sse.next(), { event: "deleted", data: "{}" });
    assert.equal(await sse.next(), undefined);
    await waitFor(() => events.listenerCount(id) === 0, "unsubscribe");
    assert.equal((await connect()).status, 404);
  });

  it("sends a heartbeat comment at the injected interval", async () => {
    const { connect } = await setup({ heartbeatMs: 20 });
    const sse = sseReader((await connect()).body);
    await sse.next();
    assert.deepEqual(await sse.next(), { comment: "heartbeat" });
    assert.deepEqual(await sse.next(), { comment: "heartbeat" });
    await sse.cancel();
  });

  it("sends a heartbeat every 20 s by default", async (t) => {
    assert.equal(HEARTBEAT_MS, 20_000);
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { connect } = await setup();
    const sse = sseReader((await connect()).body);
    await sse.next();
    t.mock.timers.tick(HEARTBEAT_MS);
    assert.deepEqual(await sse.next(), { comment: "heartbeat" });
    await sse.cancel();
  });

  it("works on the artifact's own subdomain and on 127.0.0.1", async () => {
    const { connect, id } = await setup();
    for (const host of [
      `${id}.localhost:${PORT}`,
      `${id.toUpperCase()}.localhost:${PORT}`,
      `127.0.0.1:${PORT}`,
    ]) {
      const res = await connect(host, `?id=${id.toUpperCase()}`);
      assert.equal(res.status, 200, host);
      const sse = sseReader(res.body);
      assert.equal((await sse.next())?.event, "published");
      await sse.cancel();
    }
  });

  it("returns a plain 404 instead of a stream for unknown, malformed or foreign ids", async () => {
    const { connect, events, id } = await setup();
    const unknown = "0000000000000000000000000z";
    for (const [host, query] of [
      [undefined, `?id=${unknown}`],
      [undefined, "?id=nope"],
      [undefined, "?id="],
      [undefined, ""],
      [`${unknown}.localhost:${PORT}`, `?id=${id}`],
    ] as const) {
      const res = await connect(host, query);
      assert.equal(res.status, 404, `${host} ${query}`);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await res.text(), "not found\n");
    }
    assert.equal(events.listenerCount(unknown), 0);
    assert.equal(events.listenerCount(id), 0);
  });

  it("refuses HEAD and other methods without opening a stream", async () => {
    const { connect, events, id } = await setup();
    const head = await connect(undefined, undefined, { method: "HEAD" });
    assert.equal(head.status, 405);
    assert.equal(head.headers.get("allow"), "GET");
    assert.equal((await connect(undefined, undefined, { method: "POST" })).status, 404);
    assert.equal(events.listenerCount(id), 0);
  });

  it("is still guarded by Host, but needs no token", async () => {
    const { connect } = await setup({ token: "secret" });
    assert.equal((await connect("evil.example")).status, 403);
    const res = await connect();
    assert.equal(res.status, 200);
    await sseReader(res.body).cancel();
  });

  it("leaks no listeners after 1,000 connect/disconnect cycles", async () => {
    const { connect, events, id } = await setup({ heartbeatMs: 1 });
    for (let i = 0; i < 1000; i++) {
      const sse = sseReader((await connect()).body);
      await sse.next();
      await sse.cancel();
    }
    await waitFor(() => events.listenerCount(id) === 0, "all listeners removed");

    // Many open at once, then all closed.
    const open = await Promise.all(
      Array.from({ length: 100 }, async () => sseReader((await connect()).body)),
    );
    for (const sse of open) await sse.next();
    assert.equal(events.listenerCount(id), 100);
    await Promise.all(open.map((sse) => sse.cancel()));
    await waitFor(() => events.listenerCount(id) === 0, "all listeners removed");
  });

  it("unsubscribes when a real socket disconnects", async () => {
    const { app, events, id } = await setup();
    const listening = await listen(getRequestListener(app.fetch), {
      port: 0,
      host: "127.0.0.1",
      warn: () => {},
    });
    try {
      const address = listening.servers[0].address();
      assert.ok(address && typeof address === "object");
      // Host must carry the configured port for the guard; the socket port is random.
      const url = `http://127.0.0.1:${address.port}/__artifact/events?id=${id}`;
      for (let i = 0; i < 100; i++) {
        const abort = new AbortController();
        const res = await fetchWithHost(url, `localhost:${PORT}`, abort.signal);
        assert.equal(res.status, 200);
        const sse = sseReader(res.body);
        await sse.next();
        abort.abort();
        await sse.cancel().catch(() => {});
      }
      await waitFor(() => events.listenerCount(id) === 0, "all listeners removed");
    } finally {
      await listening.close();
    }
  });
});

/** fetch() forbids setting Host, so go through node:http and wrap the body as a web stream. */
async function fetchWithHost(url: string, host: string, signal: AbortSignal) {
  return new Promise<{ status: number; body: ReadableStream<Uint8Array> }>((resolve, reject) => {
    const req = request(url, { headers: { host }, signal }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
      });
    });
    req.on("error", (error) => {
      if (error.name !== "AbortError") reject(error);
    });
    req.end();
  });
}
