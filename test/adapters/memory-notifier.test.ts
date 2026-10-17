import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryNotifier } from "../../src/adapters/memory-notifier.ts";
import type { ArtifactEvent } from "../../src/core/ports.ts";

describe("memory notifier", () => {
  it("delivers events to subscribers of that artifact only, until they unsubscribe", async () => {
    const notifier = createMemoryNotifier();
    const a: ArtifactEvent[] = [];
    const b: ArtifactEvent[] = [];
    const offA = notifier.subscribe("a", (e) => a.push(e));
    notifier.subscribe("b", (e) => b.push(e));
    await notifier.notify({ type: "published", id: "a", version: 1 });
    offA();
    await notifier.notify({ type: "published", id: "a", version: 2 });
    assert.deepEqual(a, [{ type: "published", id: "a", version: 1 }]);
    assert.deepEqual(b, []);
    assert.equal(notifier.listenerCount("a"), 0);
  });

  it("supports many listeners per artifact without leaking", () => {
    const notifier = createMemoryNotifier();
    const offs = Array.from({ length: 1000 }, () => notifier.subscribe("a", () => {}));
    assert.equal(notifier.listenerCount("a"), 1000);
    for (const off of offs) off();
    assert.equal(notifier.listenerCount("a"), 0);
  });
});
