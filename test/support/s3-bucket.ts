// The real test bucket, when the owner provides one: ARTIFACT_TEST_BUCKET names it, and
// ARTIFACT_TEST_PREFIX (default "artifact-test/") scopes every run to its own key space.
// Without ARTIFACT_TEST_BUCKET the real-bucket suites are skipped.
import { randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import type { BlobStore } from "../../src/core/ports.ts";

export type TestBucket = { client: S3Client; bucket: string; prefix: string };

/** A fresh prefix per call: `<ARTIFACT_TEST_PREFIX><timestamp>-<random>/`. */
export function runPrefix(): string {
  const base = process.env.ARTIFACT_TEST_PREFIX ?? "artifact-test/";
  return `${base}${Date.now()}-${randomBytes(4).toString("hex")}/`;
}

/** The configured bucket with default SDK credentials, or `undefined` when none is set. */
export function testBucket(): TestBucket | undefined {
  const bucket = process.env.ARTIFACT_TEST_BUCKET;
  if (!bucket) return undefined;
  return { client: new S3Client({}), bucket, prefix: runPrefix() };
}

/** Reason to skip a real-bucket suite, or `false` when the bucket is configured. */
export const skipWithoutBucket = (): string | false =>
  process.env.ARTIFACT_TEST_BUCKET ? false : "ARTIFACT_TEST_BUCKET is not set";

/** Delete every key a (prefixed) store holds. */
export async function emptyPrefix(store: BlobStore): Promise<void> {
  const { keys } = await store.list("");
  await Promise.all(keys.map((key) => store.delete(key)));
}
