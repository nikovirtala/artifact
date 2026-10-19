// The v1 store contract against the S3 stores: over the fake endpoint (through the real SDK),
// over the fake with 409 ConditionalRequestConflict on lost races, and against the real test
// bucket when ARTIFACT_TEST_BUCKET is set (docs/decisions/0060).
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createS3Store } from "../../src/runtime/adapters/s3-store.ts";
import { fakeS3Client, startFakeS3 } from "../support/fake-s3-server.ts";
import { emptyPrefix, runPrefix, skipWithoutBucket, testBucket } from "../support/s3-bucket.ts";
import { storeContract } from "./blob-store.contract.ts";

const fakes = [
  { name: "s3 (fake endpoint)", fake: startFakeS3() },
  {
    name: "s3 (fake endpoint, 409 on lost races)",
    fake: startFakeS3({ conflictOnLoss: 0.5, seed: 1 }),
  },
];

for (const { name, fake } of fakes) {
  after(async () => (await fake).close());
  storeContract(name, async () => {
    const { endpoint } = await fake;
    const client = fakeS3Client(endpoint);
    const store = createS3Store({ client, bucket: "contract", prefix: runPrefix() });
    return {
      blobs: store,
      pointers: store,
      cleanup: async () => client.destroy(),
    };
  });
}

// Declared after the contracts, so it runs after them.
describe("s3 (fake endpoint, 409 on lost races) conflicts", () => {
  it("the contract races did produce 409 ConditionalRequestConflict responses", async () => {
    const { requests } = await fakes[1].fake;
    assert.ok(requests.some((r) => r.status === 409));
  });
});

describe("s3 (ARTIFACT_TEST_BUCKET)", { skip: skipWithoutBucket() }, () => {
  storeContract("s3 bucket", async () => {
    const target = testBucket();
    if (!target) throw new Error("ARTIFACT_TEST_BUCKET is not set");
    const store = createS3Store(target);
    return {
      blobs: store,
      pointers: store,
      cleanup: async () => {
        await emptyPrefix(store);
        target.client.destroy();
      },
    };
  });
});
