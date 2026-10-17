import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [main, ...args], { encoding: "utf8" });
}

describe("artifact cli", () => {
  it("--help prints usage with every planned command and exits 0", () => {
    const result = run("--help");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: artifact <command>/);
    for (const command of ["serve", "publish", "list", "read", "open", "rollback", "rm", "mcp"]) {
      assert.match(result.stdout, new RegExp(`^ {2}artifact ${command}\\b`, "m"));
    }
  });

  it("unknown command exits non-zero with an error", () => {
    const result = run("bogus");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command 'bogus'/);
  });

  it("no command prints usage to stderr and exits non-zero", () => {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^Usage: artifact/);
  });
});
