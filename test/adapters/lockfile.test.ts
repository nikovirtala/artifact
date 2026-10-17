import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireLock } from "../../src/adapters/lockfile.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "artifact-lock-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A pid that has just exited, so it is (almost certainly) not alive. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid);
  return child.pid;
}

describe("acquireLock", () => {
  it("writes {pid, port, startedAt} and release removes it once", () => {
    const root = tempRoot();
    const result = acquireLock(root, { port: 4400, now: new Date(0) });
    assert.ok(result.ok);
    const path = join(root, ".lock");
    assert.equal(result.lock.path, path);
    assert.equal(result.lock.tookOver, undefined);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      pid: process.pid,
      port: 4400,
      startedAt: "1970-01-01T00:00:00.000Z",
    });
    result.lock.release();
    assert.equal(existsSync(path), false);
    result.lock.release();
    assert.ok(acquireLock(root, { port: 1 }).ok, "free again");
  });

  it("refuses while the holder is alive, naming pid, port and path", () => {
    const root = tempRoot();
    const first = acquireLock(root, { port: 4400 });
    assert.ok(first.ok);
    const second = acquireLock(root, { port: 4401 });
    assert.ok(!second.ok);
    assert.equal(
      second.message,
      `artifact: ${root} is already served by PID ${process.pid} on port 4400; delete ${join(root, ".lock")} if stale`,
    );
  });

  it("takes over a lock whose pid is dead", () => {
    const root = tempRoot();
    const stale = deadPid();
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: stale, port: 1, startedAt: "x" }));
    const result = acquireLock(root, { port: 4400 });
    assert.ok(result.ok);
    assert.deepEqual(result.lock.tookOver, { pid: stale });
    assert.equal(JSON.parse(readFileSync(join(root, ".lock"), "utf8")).pid, process.pid);
  });

  it("fails on an unreadable lock file", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".lock"), "not json");
    const result = acquireLock(root, { port: 4400 });
    assert.ok(!result.ok);
    assert.match(result.message, /lock file .*\.lock is unreadable; delete it if stale/);
  });

  it("release leaves a lock that another process now holds", () => {
    const root = tempRoot();
    const result = acquireLock(root, { port: 4400 });
    assert.ok(result.ok);
    const other = JSON.stringify({ pid: process.pid + 1, port: 1, startedAt: "x" });
    writeFileSync(join(root, ".lock"), other);
    result.lock.release();
    assert.equal(readFileSync(join(root, ".lock"), "utf8"), other);
  });
});
