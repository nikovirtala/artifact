import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cliCommand } from "../support/e2e.ts";

function run(...args: string[]) {
  const [command, argv] = cliCommand(...args);
  return spawnSync(command, argv, { encoding: "utf8" });
}

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("artifact cli", () => {
  it("--help prints usage with every command and exits 0", () => {
    const result = run("--help");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: artifact <command>/);
    for (const command of [
      "serve",
      "publish",
      "list",
      "read",
      "open",
      "rollback",
      "rm",
      "init",
      "mcp",
    ]) {
      assert.match(result.stdout, new RegExp(`^ {2}artifact ${command}\\b`, "m"));
    }
  });

  it("--version prints the package version", () => {
    const result = run("--version");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
  });

  it("unknown command is a usage error (exit 2)", () => {
    const result = run("bogus");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command 'bogus'/);
  });

  it("commands not built yet say so", () => {
    const result = run("mcp");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /'mcp' is not implemented yet/);
  });

  it("serve --help prints its options and exits 0", () => {
    const result = run("serve", "--help");
    assert.equal(result.status, 0, result.stderr);
    for (const text of ["--port", "--root", "--host", "--isolation", "--csp", "ARTIFACT_TOKEN"]) {
      assert.ok(result.stdout.includes(text), text);
    }
  });

  it("serve flag errors exit 2; a non-loopback host without a token exits 1", () => {
    const env = { ...process.env, ARTIFACT_TOKEN: "", ARTIFACT_PORT: "" };
    const badPort = spawnSync(...cliCommand("serve", "--port", "abc"), { encoding: "utf8", env });
    assert.equal(badPort.status, 2);
    assert.match(badPort.stderr, /--port must be an integer/);
    assert.match(badPort.stderr, /Usage: artifact serve/);
    const host = spawnSync(...cliCommand("serve", "--host", "0.0.0.0"), { encoding: "utf8", env });
    assert.equal(host.status, 1);
    assert.match(host.stderr, /ARTIFACT_TOKEN/);
  });

  it("no command prints usage to stderr and exits 2", () => {
    const result = run();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Usage: artifact/);
  });
});
