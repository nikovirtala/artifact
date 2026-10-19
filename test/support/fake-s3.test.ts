// The fake S3 endpoint answers the real SDK the way S3 does for the subset the stores use.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { type FakeS3, fakeS3Client, startFakeS3 } from "./fake-s3-server.ts";

const Bucket = "fake-test";
const enc = (s: string) => new TextEncoder().encode(s);

async function rejection(promise: Promise<unknown>): Promise<S3ServiceException> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof S3ServiceException, String(error));
    return error;
  }
  assert.fail("expected the request to fail");
}

describe("fake s3 endpoint", () => {
  let fake: FakeS3;
  let client: S3Client;

  before(async () => {
    fake = await startFakeS3({ maxKeys: 2 });
    client = fakeS3Client(fake.endpoint);
  });
  after(async () => {
    client.destroy();
    await fake.close();
  });

  it("round-trips an object and returns a quoted etag", async () => {
    const put = await client.send(
      new PutObjectCommand({ Bucket, Key: "a/b.txt", Body: enc("hi") }),
    );
    assert.match(put.ETag ?? "", /^"[0-9a-f]{32}"$/);
    const got = await client.send(new GetObjectCommand({ Bucket, Key: "a/b.txt" }));
    assert.equal(await got.Body?.transformToString(), "hi");
    assert.equal(got.ETag, put.ETag);
    assert.ok(got.LastModified instanceof Date);
  });

  it("answers 404 NoSuchKey for an absent key", async () => {
    const error = await rejection(client.send(new GetObjectCommand({ Bucket, Key: "nope" })));
    assert.equal(error.$metadata.httpStatusCode, 404);
    assert.equal(error.name, "NoSuchKey");
  });

  it("If-None-Match on an existing key fails with 412 PreconditionFailed", async () => {
    await client.send(new PutObjectCommand({ Bucket, Key: "c/once", Body: enc("1") }));
    const error = await rejection(
      client.send(
        new PutObjectCommand({ Bucket, Key: "c/once", Body: enc("2"), IfNoneMatch: "*" }),
      ),
    );
    assert.equal(error.$metadata.httpStatusCode, 412);
    assert.equal(error.name, "PreconditionFailed");
    assert.equal(fake.objects(Bucket).get("c/once")?.body[0], "1".charCodeAt(0));
  });

  it("If-Match: stale → 412; absent key → 404 NoSuchKey; current → 200", async () => {
    const first = await client.send(new PutObjectCommand({ Bucket, Key: "m/p", Body: enc("1") }));
    await client.send(new PutObjectCommand({ Bucket, Key: "m/p", Body: enc("2") }));
    const stale = await rejection(
      client.send(
        new PutObjectCommand({ Bucket, Key: "m/p", Body: enc("3"), IfMatch: first.ETag }),
      ),
    );
    assert.equal(stale.$metadata.httpStatusCode, 412);
    const absent = await rejection(
      client.send(new PutObjectCommand({ Bucket, Key: "m/none", Body: enc("x"), IfMatch: '"x"' })),
    );
    assert.equal(absent.$metadata.httpStatusCode, 404);
    assert.equal(absent.name, "NoSuchKey");
    const current = fake.objects(Bucket).get("m/p")?.etag;
    await client.send(
      new PutObjectCommand({ Bucket, Key: "m/p", Body: enc("3"), IfMatch: current }),
    );
    assert.equal(new TextDecoder().decode(fake.objects(Bucket).get("m/p")?.body), "3");
  });

  it("records the condition headers the SDK sent", async () => {
    fake.requests.length = 0;
    await client.send(
      new PutObjectCommand({ Bucket, Key: "h/1", Body: enc("x"), IfNoneMatch: "*" }),
    );
    const etag = fake.objects(Bucket).get("h/1")?.etag;
    await client.send(new PutObjectCommand({ Bucket, Key: "h/1", Body: enc("y"), IfMatch: etag }));
    assert.deepEqual(
      fake.requests.map((r) => [r.method, r.key, r.ifNoneMatch, r.ifMatch, r.status]),
      [
        ["PUT", "h/1", "*", undefined, 200],
        ["PUT", "h/1", undefined, etag, 200],
      ],
    );
  });

  it("failNext injects an error without applying the request", async () => {
    fake.failNext({ method: "PUT", key: "f/1" }, 403, "AccessDenied");
    const error = await rejection(
      client.send(new PutObjectCommand({ Bucket, Key: "f/1", Body: enc("x") })),
    );
    assert.equal(error.$metadata.httpStatusCode, 403);
    assert.equal(error.name, "AccessDenied");
    assert.equal(fake.objects(Bucket).has("f/1"), false);
  });

  it("pages ListObjectsV2 with and without a delimiter", async () => {
    for (const key of ["l/a", "l/b/1", "l/b/2", "l/c", "l/d/1"]) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: enc(key) }));
    }
    const pages = async (Delimiter?: string) => {
      const seen: { keys: string[]; prefixes: string[] }[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: "l/", Delimiter, ContinuationToken }),
        );
        seen.push({
          keys: (page.Contents ?? []).map((c) => c.Key ?? ""),
          prefixes: (page.CommonPrefixes ?? []).map((c) => c.Prefix ?? ""),
        });
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return seen;
    };
    assert.deepEqual(await pages(), [
      { keys: ["l/a", "l/b/1"], prefixes: [] },
      { keys: ["l/b/2", "l/c"], prefixes: [] },
      { keys: ["l/d/1"], prefixes: [] },
    ]);
    assert.deepEqual(await pages("/"), [
      { keys: ["l/a"], prefixes: ["l/b/"] },
      { keys: ["l/c"], prefixes: ["l/d/"] },
    ]);
  });
});

describe("fake s3 endpoint with conflictOnLoss", () => {
  it("answers a lost conditional write with 409 ConditionalRequestConflict", async () => {
    const fake = await startFakeS3({ conflictOnLoss: 1 });
    const client = fakeS3Client(fake.endpoint);
    try {
      await client.send(
        new PutObjectCommand({ Bucket, Key: "k", Body: enc("1"), IfNoneMatch: "*" }),
      );
      const error = await rejection(
        client.send(new PutObjectCommand({ Bucket, Key: "k", Body: enc("2"), IfNoneMatch: "*" })),
      );
      assert.equal(error.$metadata.httpStatusCode, 409);
      assert.equal(error.name, "ConditionalRequestConflict");
    } finally {
      client.destroy();
      await fake.close();
    }
  });
});
