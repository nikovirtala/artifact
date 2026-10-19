// Pins the request counts of service.list() on S3 that docs/decisions/0061 prices: one
// ListObjectsV2 page per 1,000 artifacts plus one GET of meta.json per artifact.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createS3Store } from "../../src/runtime/adapters/s3-store.ts";
import { fakeS3Client, startFakeS3 } from "../support/fake-s3-server.ts";
import { unwrap } from "../support/fakes.ts";
import { service } from "../support/publish-invariants.ts";

async function listRequests(maxKeys?: number) {
  const fake = await startFakeS3({ maxKeys });
  const client = fakeS3Client(fake.endpoint);
  try {
    const { svc } = service(createS3Store({ client, bucket: "cost", prefix: "p/" }));
    for (let i = 0; i < 5; i++) unwrap(await svc.publish({ files: { "index.html": `${i}` } }));
    fake.requests.length = 0;
    assert.equal(unwrap(await svc.list()).length, 5);
    return {
      lists: fake.requests.filter((r) => r.method === "GET" && r.query["list-type"] === "2"),
      metaGets: fake.requests.filter((r) => r.method === "GET" && r.key?.endsWith("/meta.json")),
      total: fake.requests.length,
    };
  } finally {
    client.destroy();
    await fake.close();
  }
}

describe("service.list() on S3", () => {
  it("costs one ListObjectsV2 page and one GET meta.json per artifact", async () => {
    const { lists, metaGets, total } = await listRequests();
    assert.equal(lists.length, 1);
    assert.deepEqual(lists[0].query.delimiter, "/");
    assert.equal(metaGets.length, 5);
    assert.equal(total, 6);
  });

  it("needs another LIST page per page size of artifacts", async () => {
    const { lists, metaGets, total } = await listRequests(2);
    assert.equal(lists.length, 3);
    assert.equal(metaGets.length, 5);
    assert.equal(total, 8);
  });
});
