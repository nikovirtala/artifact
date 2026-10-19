// Two "processes" publishing to one bucket: two S3 clients, two stores and two services on the
// same bucket and prefix, with no lock between them. Conditional writes alone must keep every
// version unique and none lost (docs/decisions/0060). Runs over the fake endpoint, the fake with
// 409 ConditionalRequestConflict on lost races, and the real bucket when ARTIFACT_TEST_BUCKET
// is set.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import { createS3Store, type S3Store } from "../../src/runtime/adapters/s3-store.ts";
import { type FakeS3, fakeS3Client, startFakeS3 } from "../support/fake-s3-server.ts";
import { unwrap } from "../support/fakes.ts";
import { assertConsistent, files, service } from "../support/publish-invariants.ts";
import { emptyPrefix, runPrefix, skipWithoutBucket, testBucket } from "../support/s3-bucket.ts";

type Target = {
  /** Two independent clients on one bucket, and the prefix both use. */
  open(): Promise<{ clients: [S3Client, S3Client]; bucket: string; prefix: string }>;
};

function fakeTarget(
  options: Parameters<typeof startFakeS3>[0],
): Target & { fake: Promise<FakeS3> } {
  const fake = startFakeS3(options);
  after(async () => (await fake).close());
  return {
    fake,
    async open() {
      const { endpoint } = await fake;
      return {
        clients: [fakeS3Client(endpoint), fakeS3Client(endpoint)],
        bucket: "concurrency",
        prefix: runPrefix(),
      };
    },
  };
}

const bucketTarget: Target = {
  async open() {
    const [a, b] = [testBucket(), testBucket()];
    if (!a || !b) throw new Error("ARTIFACT_TEST_BUCKET is not set");
    return { clients: [a.client, b.client], bucket: a.bucket, prefix: a.prefix };
  },
};

/** Two stores (processes) on one key space; `cleanup` empties it and closes both clients. */
async function twoProcesses(target: Target) {
  const { clients, bucket, prefix } = await target.open();
  const stores = clients.map((client) => createS3Store({ client, bucket, prefix })) as [
    S3Store,
    S3Store,
  ];
  return {
    stores,
    cleanup: async () => {
      await emptyPrefix(stores[0]);
      for (const client of clients) client.destroy();
    },
  };
}

function concurrencySuite(target: Target) {
  it("without ifVersion: every publish lands; none lost or duplicated", async () => {
    const { stores, cleanup } = await twoProcesses(target);
    try {
      const [a, b] = [service(stores[0], 100), service(stores[1], 100)];
      const { id } = unwrap(await a.svc.publish({ files: { "index.html": "base" } }));
      const n = 24;
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => (i % 2 ? b : a).svc.publish({ id, files: files(i) })),
      );
      const { wins, committed, current } = await assertConsistent(
        a.svc,
        stores[1],
        id,
        results.map((result, i) => ({ i, result })),
      );
      assert.equal(wins.length, n, "with enough attempts every publish lands");
      assert.equal(current, Math.max(...committed));
      assert.equal(a.notifier.events.length + b.notifier.events.length, n + 1);
    } finally {
      await cleanup();
    }
  });

  it("with ifVersion: exactly one wins; the rest get version_conflict", async () => {
    const { stores, cleanup } = await twoProcesses(target);
    try {
      const [a, b] = [service(stores[0]), service(stores[1])];
      const { id } = unwrap(await a.svc.publish({ files: { "index.html": "base" } }));
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          (i % 2 ? b : a).svc.publish({ id, ifVersion: 1, files: files(i) }),
        ),
      );
      const { wins, current } = await assertConsistent(
        b.svc,
        stores[0],
        id,
        results.map((result, i) => ({ i, result })),
      );
      assert.equal(wins.length, 1);
      for (const r of results) {
        if (!r.ok) {
          assert.deepEqual(r.error.code === "version_conflict" && r.error.currentVersion, current);
        }
      }
    } finally {
      await cleanup();
    }
  });
}

describe("two s3 store instances (fake endpoint)", () => {
  concurrencySuite(fakeTarget({}));
});

describe("two s3 store instances (fake endpoint, 409 on lost races)", () => {
  const target = fakeTarget({ conflictOnLoss: 0.3, seed: 7 });
  concurrencySuite(target);
  it("the races did produce 409 ConditionalRequestConflict responses", async () => {
    const { requests } = await target.fake;
    assert.ok(requests.some((r) => r.status === 409));
    assert.ok(requests.some((r) => r.status === 412));
  });
});

describe("two s3 store instances (ARTIFACT_TEST_BUCKET)", { skip: skipWithoutBucket() }, () => {
  concurrencySuite(bucketTarget);
});
