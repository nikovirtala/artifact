// Injectable limits (docs/decisions/0051): the service owns them, defaults are LIMITS, and the
// core reports the configured numbers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIMITS } from "../../src/core/artifact-service.ts";
import type { Result } from "../../src/core/errors.ts";
import { harness, unwrap } from "../support/fakes.ts";

const KIB = { maxFileBytes: 1024, maxPublishBytes: 1024 };

/** The error of a failed result, as a plain record; fails the test on success. */
function errorOf(result: Result<unknown>): Record<string, unknown> {
  if (result.ok) throw new Error("expected an error result");
  return { ...result.error };
}

describe("service limits", () => {
  it("default to LIMITS", () => {
    assert.deepEqual(harness().service.limits, LIMITS);
  });

  it("merge a partial override over the defaults", () => {
    const { service } = harness({ limits: { maxListLimit: 5 } });
    assert.deepEqual(service.limits, { ...LIMITS, maxListLimit: 5 });
  });

  it("reject values that are not positive safe integers", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => harness({ limits: { maxFileBytes: value } }), /maxFileBytes/);
    }
  });

  it("report too_large with the configured file limit", async () => {
    const { service } = harness({ limits: KIB });
    const error = errorOf(await service.publish({ files: { "index.html": "x".repeat(1025) } }));
    assert.deepEqual([error.code, error.subject, error.limit], ["too_large", "file", 1024]);
    assert.match(String(error.message), /1024/);
  });

  it("report too_large with the configured publish limit", async () => {
    const { service } = harness({ limits: KIB });
    const error = errorOf(
      await service.publish({ files: { "index.html": "x".repeat(600), "a.txt": "y".repeat(600) } }),
    );
    assert.deepEqual([error.code, error.subject, error.limit], ["too_large", "publish", 1024]);
    assert.match(String(error.message), /1024/);
  });

  it("accept a file of exactly the configured size", async () => {
    const { service } = harness({ limits: KIB });
    unwrap(await service.publish({ files: { "index.html": "x".repeat(1024) } }));
  });

  it("bound list limits by the configured maxListLimit", async () => {
    const { service } = harness({ limits: { maxListLimit: 5 } });
    const error = errorOf(await service.list({ limit: 6 }));
    assert.deepEqual([error.code, error.limit], ["invalid_input", 5]);
    assert.match(String(error.message), /1 to 5/);
    unwrap(await service.list({ limit: 5 }));
  });

  it("bound labels by the configured maxLabelChars", async () => {
    const { service } = harness({ limits: { maxLabelChars: 3 } });
    const error = errorOf(await service.publish({ label: "abcd", files: { "index.html": "x" } }));
    assert.deepEqual([error.code, error.field, error.limit], ["invalid_input", "label", 3]);
    unwrap(await service.publish({ label: "abc", files: { "index.html": "x" } }));
  });

  it("bound the file count by the configured maxFiles", async () => {
    const { service } = harness({ limits: { maxFiles: 2 } });
    const files = { "index.html": "x", "a.txt": "a", "b.txt": "b" };
    const error = errorOf(await service.publish({ files }));
    assert.deepEqual([error.code, error.field, error.limit], ["invalid_input", "files", 2]);
  });
});
