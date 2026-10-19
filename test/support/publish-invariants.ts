// Publish invariants shared by the concurrency tests (test/core/concurrency.test.ts and the S3
// two-instance test): exactly one winner per version number, and committed versions are never
// lost, duplicated or out of order.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ArtifactService, type Manifest, type Published } from "../../src/core/artifact-service.ts";
import type { Result } from "../../src/core/errors.ts";
import { injectReloadScript } from "../../src/core/inject.ts";
import type { BlobStore, PointerStore } from "../../src/core/ports.ts";
import { fakeClock, fakeIdGen, recordingNotifier, text, unwrap } from "./fakes.ts";

type Store = BlobStore & PointerStore;

export function service(store: Store, maxAttempts?: number) {
  const notifier = recordingNotifier();
  const svc = new ArtifactService({
    blobs: store,
    pointers: store,
    notifier,
    clock: fakeClock(),
    ids: fakeIdGen(),
    maxAttempts,
  });
  return { svc, notifier };
}

/** A publish by publisher `i` (whose files are `files(i)`) and its result. */
export type Outcome = { i: number; result: Result<Published> };

export const pageFor = (i: number) => `<html><body>publisher ${i}</body></html>`;

/** Check every invariant after a batch of publishes to `id` (which started at version 1). */
export async function assertConsistent(
  svc: ArtifactService,
  store: BlobStore,
  id: string,
  outcomes: Outcome[],
) {
  for (const { result } of outcomes) {
    assert.ok(result.ok || result.error.code === "version_conflict", JSON.stringify(result));
  }
  const wins = outcomes.flatMap(({ i, result }) =>
    result.ok ? [{ i, version: result.value.version }] : [],
  );
  const winVersions = wins.map((w) => w.version);
  assert.equal(new Set(winVersions).size, winVersions.length, "no version won twice");

  const details = unwrap(await svc.read(id));
  const committed = details.versions.map((v) => v.version);
  for (let k = 1; k < committed.length; k++) {
    assert.ok(committed[k - 1] < committed[k], `strictly increasing: ${committed}`);
  }
  assert.deepEqual(
    committed,
    [1, ...[...winVersions].sort((a, b) => a - b)],
    "every win committed, nothing else",
  );

  for (const { i, version } of wins) {
    const html = pageFor(i);
    assert.equal(
      text(unwrap(await svc.readFile(id, { version })).body),
      html,
      "src is the winner's",
    );
    const www = await store.get(`artifacts/${id}/v/${version}/www/index.html`);
    assert.equal(www && text(www), injectReloadScript(html, version), "www is the winner's");
    const manifest = await store.get(`artifacts/${id}/v/${version}/manifest.json`);
    assert.ok(manifest);
    const files = (JSON.parse(text(manifest)) as Manifest).files;
    assert.deepEqual(
      files.map((f) => [f.path, f.sha256]),
      [
        ["index.html", createHash("sha256").update(html).digest("hex")],
        ["style.css", createHash("sha256").update(`/* ${i} */`).digest("hex")],
      ],
    );
  }
  return { wins, committed, current: details.currentVersion };
}

export const files = (i: number) => ({ "index.html": pageFor(i), "style.css": `/* ${i} */` });
