import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopback, resolveServeConfig } from "../src/config.ts";

const HOME = "/home/u";
const resolveOk = (args: string[], env: Record<string, string> = {}) => {
  const result = resolveServeConfig(args, env, HOME);
  assert.ok(result.ok && !result.help, JSON.stringify(result));
  return result;
};
const resolveErr = (args: string[], env: Record<string, string> = {}) => {
  const result = resolveServeConfig(args, env, HOME);
  assert.ok(!result.ok, JSON.stringify(result));
  return result.message;
};

describe("resolveServeConfig", () => {
  it("defaults to port 4400, subdomain isolation and ~/.artifacts", () => {
    assert.deepEqual(resolveOk([]), {
      ok: true,
      config: { port: 4400, root: "/home/u/.artifacts", isolation: "subdomain" },
      warnings: [],
    });
  });

  it("prefers flags over env", () => {
    const env = { ARTIFACT_PORT: "5000", ARTIFACT_CSP: "default-src *", ARTIFACT_TOKEN: "t" };
    assert.deepEqual(resolveOk([], env).config, {
      port: 5000,
      root: "/home/u/.artifacts",
      isolation: "subdomain",
      csp: "default-src *",
      token: "t",
    });
    const flags = resolveOk(
      ["--port", "6000", "--csp", "default-src 'self'", "--isolation", "path"],
      env,
    );
    assert.equal(flags.config.port, 6000);
    assert.equal(flags.config.csp, "default-src 'self'");
    assert.equal(flags.config.isolation, "path");
  });

  it("treats empty env values as unset", () => {
    assert.deepEqual(
      resolveOk([], { ARTIFACT_PORT: "", ARTIFACT_TOKEN: "", ARTIFACT_CSP: "" }).config,
      {
        port: 4400,
        root: "/home/u/.artifacts",
        isolation: "subdomain",
      },
    );
  });

  it("rejects bad ports, isolation modes and unknown flags", () => {
    for (const port of ["abc", "0", "70000", "1.5", "-1"]) {
      assert.match(
        resolveErr([], { ARTIFACT_PORT: port }),
        /ARTIFACT_PORT must be an integer from 1 to 65535/,
      );
    }
    assert.match(resolveErr(["--port", "x"]), /--port must be an integer/);
    assert.match(resolveErr(["--isolation", "bogus"]), /--isolation must be "subdomain" or "path"/);
    assert.match(resolveErr(["--bogus"]), /artifact serve: .*bogus/);
    assert.match(resolveErr(["extra"]), /artifact serve: /);
  });

  it("expands ~ and resolves --root to an absolute path", () => {
    assert.equal(resolveOk(["--root", "~/x"]).config.root, "/home/u/x");
    assert.equal(resolveOk(["--root", "/tmp/r/../s"]).config.root, "/tmp/s");
    assert.ok(resolveOk(["--root", "rel"]).config.root.startsWith("/"));
  });

  it("refuses a non-loopback --host without a token and warns with one", () => {
    assert.equal(
      resolveErr(["--host", "0.0.0.0"]),
      "artifact: --host 0.0.0.0 is not a loopback address; set ARTIFACT_TOKEN to serve on it",
    );
    const withToken = resolveOk(["--host", "0.0.0.0"], { ARTIFACT_TOKEN: "t" });
    assert.equal(withToken.config.host, "0.0.0.0");
    assert.equal(withToken.warnings.length, 1);
    assert.match(withToken.warnings[0], /non-loopback address 0\.0\.0\.0/);
    assert.deepEqual(resolveOk(["--host", "127.0.0.2"]).warnings, []);
  });

  it("returns help for -h and --help", () => {
    assert.deepEqual(resolveServeConfig(["-h"], {}, HOME), { ok: true, help: true });
    assert.deepEqual(resolveServeConfig(["--help"], {}, HOME), { ok: true, help: true });
  });
});

describe("isLoopback", () => {
  it("accepts localhost, ::1 and 127.0.0.0/8 only", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.0.0.2",
      "127.255.255.254",
      "::1",
    ]) {
      assert.ok(isLoopback(host), host);
    }
    for (const host of [
      "0.0.0.0",
      "::",
      "192.168.1.2",
      "example.com",
      "128.0.0.1",
      "127.example",
    ]) {
      assert.ok(!isLoopback(host), host);
    }
  });
});
