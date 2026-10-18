import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoOpen, isLoopback, resolveServeConfig } from "../src/config.ts";

const HOME = "/home/u";
const resolveOk = (
  args: string[],
  env: Record<string, string> = {},
  platform: NodeJS.Platform = "darwin",
) => {
  const result = resolveServeConfig(args, env, HOME, platform);
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
      config: { port: 4400, root: "/home/u/.artifacts", isolation: "subdomain", open: true },
      warnings: [],
    });
  });

  it("prefers flags over env", () => {
    const env = { ARTIFACT_PORT: "5000", ARTIFACT_CSP: "default-src *", ARTIFACT_TOKEN: "t" };
    assert.deepEqual(resolveOk([], env).config, {
      port: 5000,
      root: "/home/u/.artifacts",
      isolation: "subdomain",
      open: true,
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
        open: true,
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

describe("auto-open", () => {
  const open = (
    env: Record<string, string> = {},
    platform: NodeJS.Platform = "darwin",
    noOpen = false,
    host?: string,
  ) => autoOpen({ noOpen, host, env, platform });

  it("is on by default on desktops and on Linux with a display", () => {
    assert.equal(open({}, "darwin"), true);
    assert.equal(open({}, "win32"), true);
    assert.equal(open({ DISPLAY: ":0" }, "linux"), true);
    assert.equal(open({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
    assert.equal(open({}, "darwin", false, "127.0.0.1"), true);
    assert.equal(open({ ARTIFACT_OPEN: "1", BROWSER: "firefox" }), true);
  });

  it("is off with --no-open, ARTIFACT_OPEN=0 or BROWSER=none", () => {
    assert.equal(open({}, "darwin", true), false);
    for (const value of ["0", "false", "no", "off", "OFF"]) {
      assert.equal(open({ ARTIFACT_OPEN: value }), false, value);
    }
    assert.equal(open({ BROWSER: "none" }), false);
  });

  it("is skipped over SSH, on Linux without a display and off loopback", () => {
    assert.equal(open({ SSH_CONNECTION: "10.0.0.1 5000 10.0.0.2 22" }), false);
    assert.equal(open({ SSH_CONNECTION: "1 2 3 4", DISPLAY: ":0" }, "linux"), false);
    assert.equal(open({}, "linux"), false);
    assert.equal(open({ DISPLAY: "" }, "freebsd"), false);
    assert.equal(open({}, "darwin", false, "0.0.0.0"), false);
  });

  it("is resolved into the serve config", () => {
    assert.equal(resolveOk(["--no-open"]).config.open, false);
    assert.equal(resolveOk([], { ARTIFACT_OPEN: "0" }).config.open, false);
    assert.equal(resolveOk([], {}, "linux").config.open, false);
    assert.equal(resolveOk([], { DISPLAY: ":0" }, "linux").config.open, true);
    assert.equal(resolveOk(["--host", "0.0.0.0"], { ARTIFACT_TOKEN: "t" }).config.open, false);
    assert.match(resolveErr(["--open"]), /artifact serve: .*--open/);
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
