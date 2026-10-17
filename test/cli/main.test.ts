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

  it("client commands are not implemented yet", () => {
    const result = run("publish");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /'publish' is not implemented yet/);
  });

  it("serve --help prints its options and exits 0", () => {
    const result = run("serve", "--help");
    assert.equal(result.status, 0, result.stderr);
    for (const text of ["--port", "--root", "--host", "--isolation", "--csp", "ARTIFACT_TOKEN"]) {
      assert.ok(result.stdout.includes(text), text);
    }
  });

  it("serve rejects bad flags and a non-loopback host without a token", () => {
    const env = { ...process.env, ARTIFACT_TOKEN: "", ARTIFACT_PORT: "" };
    const badPort = spawnSync(process.execPath, [main, "serve", "--port", "abc"], {
      encoding: "utf8",
      env,
    });
    assert.equal(badPort.status, 1);
    assert.match(badPort.stderr, /--port must be an integer/);
    const host = spawnSync(process.execPath, [main, "serve", "--host", "0.0.0.0"], {
      encoding: "utf8",
      env,
    });
    assert.equal(host.status, 1);
    assert.match(host.stderr, /ARTIFACT_TOKEN/);
  });

  it("no command prints usage to stderr and exits non-zero", () => {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^Usage: artifact/);
  });
});
