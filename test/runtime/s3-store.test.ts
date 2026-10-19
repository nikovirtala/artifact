// S3 store specifics over the fake endpoint, through the real SDK: the error-mapping table of
// docs/decisions/0060, opaque etags, the key prefix, pagination and key order.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import type { BlobStore, PointerStore } from "../../src/core/ports.ts";
import {
  createS3Store,
  isConditionFailure,
  S3BlobStore,
  S3PointerStore,
} from "../../src/runtime/adapters/s3-store.ts";
import { type FakeS3, fakeS3Client, startFakeS3 } from "../support/fake-s3-server.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) =>
  b === undefined ? undefined : new TextDecoder().decode(b);
const preconditionFailed = { ok: false, reason: "precondition_failed" };
const bucket = "unit";

type Store = BlobStore & PointerStore;
type Expect = "precondition_failed" | "throws" | "undefined";

/** Each store operation, the HTTP method it sends, and its outcome per injected error. */
const operations: {
  name: string;
  method: string;
  run(store: Store): Promise<unknown>;
  outcome(status: number, code: string): Expect;
}[] = [
  {
    name: "put (unconditional)",
    method: "PUT",
    run: (s) => s.put("k/x", enc("x")),
    outcome: () => "throws",
  },
  {
    name: "put ifNoneMatch",
    method: "PUT",
    run: (s) => s.put("k/x", enc("x"), { ifNoneMatch: "*" }),
    outcome: (status, code) =>
      status === 412 || code === "ConditionalRequestConflict" ? "precondition_failed" : "throws",
  },
  {
    name: "write ifNoneMatch",
    method: "PUT",
    run: (s) => s.write("k/x", enc("x"), { ifNoneMatch: "*" }),
    outcome: (status, code) =>
      status === 412 || code === "ConditionalRequestConflict" ? "precondition_failed" : "throws",
  },
  {
    name: "write ifMatch",
    method: "PUT",
    run: (s) => s.write("k/x", enc("x"), { ifMatch: '"etag"' }),
    outcome: (status, code) =>
      status === 412 || code === "ConditionalRequestConflict" || code === "NoSuchKey"
        ? "precondition_failed"
        : "throws",
  },
  {
    name: "get",
    method: "GET",
    run: (s) => s.get("k/x"),
    outcome: (_, code) => (code === "NoSuchKey" ? "undefined" : "throws"),
  },
  {
    name: "read",
    method: "GET",
    run: (s) => s.read("k/x"),
    outcome: (_, code) => (code === "NoSuchKey" ? "undefined" : "throws"),
  },
  { name: "list", method: "GET", run: (s) => s.list("k/"), outcome: () => "throws" },
  { name: "delete", method: "DELETE", run: (s) => s.delete("k/x"), outcome: () => "throws" },
];

const errors: [number, string][] = [
  [412, "PreconditionFailed"],
  [409, "ConditionalRequestConflict"],
  [409, "OperationAborted"],
  [404, "NoSuchKey"],
  [404, "NoSuchBucket"],
  [403, "AccessDenied"],
  [400, "InvalidRequest"],
  [500, "InternalError"],
  [503, "SlowDown"],
];

describe("s3 store", () => {
  let fake: FakeS3;
  let client: S3Client;
  let store: Store;
  let n = 0;

  before(async () => {
    fake = await startFakeS3();
    // One attempt, so an injected 5xx reaches the store instead of being retried away.
    client = fakeS3Client(fake.endpoint, { maxAttempts: 1 });
  });
  after(async () => {
    client.destroy();
    await fake.close();
  });
  beforeEach(() => {
    store = createS3Store({ client, bucket, prefix: `t${++n}/` });
    fake.requests.length = 0;
  });

  describe("error mapping", () => {
    for (const op of operations) {
      for (const [status, code] of errors) {
        const expected = op.outcome(status, code);
        it(`${op.name}: ${status} ${code} → ${expected}`, async () => {
          fake.failNext({ method: op.method }, status, code);
          const outcome = op.run(store);
          if (expected === "throws") {
            await assert.rejects(outcome, (error: Error) => {
              assert.equal(error.name, code);
              return true;
            });
          } else if (expected === "undefined") {
            assert.equal(await outcome, undefined);
          } else {
            assert.deepEqual(await outcome, preconditionFailed);
          }
          assert.equal(fake.requests.length, 1, "exactly one request, no retry");
        });
      }
    }

    it("a network failure throws", async () => {
      const dead = fakeS3Client("http://127.0.0.1:1", { maxAttempts: 1 });
      try {
        const s = createS3Store({ client: dead, bucket });
        await assert.rejects(s.write("k/x", enc("x"), { ifNoneMatch: "*" }));
        await assert.rejects(s.get("k/x"));
      } finally {
        dead.destroy();
      }
    });

    it("isConditionFailure reads the status and the error name", () => {
      const e = (httpStatusCode: number | undefined, name: string) =>
        Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
      assert.equal(isConditionFailure(e(412, "PreconditionFailed"), "ifNoneMatch"), true);
      assert.equal(isConditionFailure(e(409, "ConditionalRequestConflict"), "ifMatch"), true);
      assert.equal(isConditionFailure(e(409, "OperationAborted"), "ifMatch"), false);
      assert.equal(isConditionFailure(e(404, "NoSuchKey"), "ifMatch"), true);
      assert.equal(isConditionFailure(e(404, "NoSuchKey"), "ifNoneMatch"), false);
      assert.equal(isConditionFailure(e(404, "NoSuchBucket"), "ifMatch"), false);
      assert.equal(isConditionFailure(e(undefined, "TypeError"), "ifMatch"), false);
      assert.equal(isConditionFailure(new Error("plain"), "ifNoneMatch"), false);
      assert.equal(isConditionFailure("not an error", "ifNoneMatch"), false);
    });
  });

  it("real lost races map to precondition_failed with the default retry settings", async () => {
    const retrying = fakeS3Client(fake.endpoint);
    try {
      const s = createS3Store({ client: retrying, bucket, prefix: "races/" });
      assert.equal((await s.write("p", enc("1"), { ifNoneMatch: "*" })).ok, true);
      fake.requests.length = 0;
      assert.deepEqual(await s.write("p", enc("2"), { ifNoneMatch: "*" }), preconditionFailed);
      assert.deepEqual(await s.write("p", enc("2"), { ifMatch: '"stale"' }), preconditionFailed);
      assert.deepEqual(await s.write("absent", enc("2"), { ifMatch: '"x"' }), preconditionFailed);
      assert.deepEqual(await s.put("p", enc("2"), { ifNoneMatch: "*" }), preconditionFailed);
      assert.deepEqual(
        fake.requests.map((r) => r.status),
        [412, 412, 404, 412],
        "no retries of a failed precondition",
      );
    } finally {
      retrying.destroy();
    }
  });

  it("returns the S3 etag and sends it back to If-Match verbatim", async () => {
    const created = await store.write("m.json", enc("v1"), { ifNoneMatch: "*" });
    assert.ok(created.ok);
    assert.match(created.etag, /^"[0-9a-f]{32}"$/);
    const read = await store.read("m.json");
    assert.equal(read?.etag, created.etag);
    await store.write("m.json", enc("v2"), { ifMatch: created.etag });
    const sent = fake.requests.filter((r) => r.method === "PUT").map((r) => r.ifMatch);
    assert.deepEqual(sent, [undefined, created.etag]);
    const blob = await store.put("b.bin", enc("x"));
    assert.ok(blob.ok);
    assert.equal(blob.etag, fake.objects(bucket).get(`t${n}/b.bin`)?.etag);
  });

  it("keys live under the prefix, and results come back without it", async () => {
    const a = createS3Store({ client, bucket, prefix: "iso/a/" });
    const b = createS3Store({ client, bucket, prefix: "iso/b/" });
    await a.put("x/1", enc("a1"));
    await a.write("x/meta.json", enc("am"), { ifNoneMatch: "*" });
    await b.put("x/1", enc("b1"));
    assert.ok(fake.objects(bucket).has("iso/a/x/1"));
    assert.ok(fake.objects(bucket).has("iso/a/x/meta.json"));
    assert.equal(dec(await a.get("x/1")), "a1");
    assert.equal(dec(await b.get("x/1")), "b1");
    assert.equal(await b.read("x/meta.json"), undefined);
    assert.deepEqual((await a.list("")).keys, ["x/1", "x/meta.json"]);
    assert.deepEqual((await b.list("")).keys, ["x/1"]);
    assert.deepEqual((await a.list("", { delimiter: "/" })).commonPrefixes, ["x/"]);
    await b.delete("x/1");
    assert.equal(dec(await a.get("x/1")), "a1");
    const bare = createS3Store({ client, bucket });
    assert.ok((await bare.list("iso/")).keys.includes("iso/a/x/1"));
  });

  it("follows continuation tokens, with and without a delimiter", async () => {
    const small = await startFakeS3({ maxKeys: 2 });
    const c = fakeS3Client(small.endpoint);
    try {
      const s = createS3Store({ client: c, bucket, prefix: "pg/" });
      const keys = ["a/1", "a/2", "b/1", "c", "d", "e/1/2", "f"];
      for (const key of keys) await s.put(key, enc(key));
      const all = await s.list("");
      assert.deepEqual(all.keys, keys);
      assert.deepEqual(
        all.objects.map((o) => o.key),
        keys,
      );
      for (const o of all.objects) assert.ok(o.lastModified instanceof Date);
      assert.deepEqual(
        await s.list("", { delimiter: "/" }).then((r) => [r.keys, r.commonPrefixes]),
        [
          ["c", "d", "f"],
          ["a/", "b/", "e/"],
        ],
      );
      const lists = small.requests.filter((r) => r.method === "GET" && r.key === undefined);
      assert.ok(lists.length >= 6, `paged: ${lists.length} requests`);
    } finally {
      c.destroy();
      await small.close();
    }
  });

  it("sorts keys by UTF-16 code units like the other stores, not by UTF-8 bytes", async () => {
    const astral = "u/\u{1F600}";
    const bmp = "u/\uFFFD";
    await store.put(bmp, enc("bmp"));
    await store.put(astral, enc("astral"));
    await store.put(`${bmp}/x`, enc("x"));
    await store.put(`${astral}/x`, enc("x"));
    assert.deepEqual((await store.list("u/")).keys, [astral, `${astral}/x`, bmp, `${bmp}/x`]);
    const grouped = await store.list("u/", { delimiter: "/" });
    assert.deepEqual(grouped.keys, [astral, bmp]);
    assert.deepEqual(grouped.commonPrefixes, [`${astral}/`, `${bmp}/`]);
  });

  it("rejects a bad prefix option", () => {
    for (const prefix of ["a", "/a/", "a//", "a/../", "a\\b/", "./"]) {
      assert.throws(() => createS3Store({ client, bucket, prefix }), TypeError, prefix);
      assert.throws(() => new S3BlobStore({ client, bucket, prefix }), TypeError, prefix);
      assert.throws(() => new S3PointerStore({ client, bucket, prefix }), TypeError, prefix);
    }
    for (const prefix of ["", "a/", "a/b/", "artifact-test/123-ab/"]) {
      createS3Store({ client, bucket, prefix });
    }
  });

  it("rejects malformed keys and prefixes before sending any request", async () => {
    for (const key of ["", "/abs", "a/../b", "a//b", "a\\b", "dir/"]) {
      await assert.rejects(store.get(key), TypeError);
      await assert.rejects(store.put(key, enc("x")), TypeError);
      await assert.rejects(store.read(key), TypeError);
      await assert.rejects(store.write(key, enc("x"), { ifNoneMatch: "*" }), TypeError);
      await assert.rejects(store.delete(key), TypeError);
    }
    await assert.rejects(store.list("/abs"), TypeError);
    await assert.rejects(store.list("a//"), TypeError);
    assert.equal(fake.requests.length, 0);
  });

  it("S3BlobStore and S3PointerStore share one key space", async () => {
    const blobs = new S3BlobStore({ client, bucket, prefix: "split/" });
    const pointers = new S3PointerStore({ client, bucket, prefix: "split/" });
    await pointers.write("a/meta.json", enc("m"), { ifNoneMatch: "*" });
    assert.equal(dec(await blobs.get("a/meta.json")), "m");
    assert.deepEqual((await blobs.list("a/")).keys, ["a/meta.json"]);
    await pointers.delete("a/meta.json");
    assert.equal(await blobs.get("a/meta.json"), undefined);
  });
});
