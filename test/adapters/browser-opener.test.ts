// The browser opener with a fake spawn: no real browser is ever launched.
import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { describe, it } from "node:test";
import { browserCommand, createBrowserOpener } from "../../src/adapters/browser-opener.ts";

const URL_ = "http://01hzx3k5m7n9p1q3r5s7t9v1w3.localhost:4400/";

type Call = { command: string; args: string[]; options: SpawnOptions; unref: boolean };

function fakeSpawn(behaviour: "ok" | "throw" | "error-event" = "ok") {
  const calls: Call[] = [];
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    if (behaviour === "throw") throw new Error("spawn EINVAL");
    const call: Call = { command, args, options, unref: false };
    calls.push(call);
    return {
      on(_event: "error", listener: (error: Error) => void) {
        if (behaviour === "error-event") queueMicrotask(() => listener(new Error("spawn ENOENT")));
      },
      unref() {
        call.unref = true;
      },
    };
  };
  return { calls, spawn };
}

describe("browserCommand", () => {
  it("uses open, xdg-open and cmd /c start with the URL as its own argument", () => {
    assert.deepEqual(browserCommand("darwin", URL_), ["open", [URL_]]);
    assert.deepEqual(browserCommand("linux", URL_), ["xdg-open", [URL_]]);
    assert.deepEqual(browserCommand("freebsd", URL_), ["xdg-open", [URL_]]);
    assert.deepEqual(browserCommand("win32", URL_), ["cmd", ["/c", "start", '""', URL_]]);
  });
});

describe("createBrowserOpener", () => {
  it("spawns detached, ignores stdio and unrefs, without a shell", () => {
    const { calls, spawn } = fakeSpawn();
    const open = createBrowserOpener({ platform: "linux", warn: assert.fail, spawn });
    assert.equal(open(URL_), true);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual([call.command, call.args], ["xdg-open", [URL_]]);
    assert.equal(call.options.detached, true);
    assert.equal(call.options.stdio, "ignore");
    assert.equal(call.options.shell, undefined);
    assert.equal(call.options.windowsVerbatimArguments, false);
    assert.equal(call.unref, true);
  });

  it("refuses URLs a shell or browser could reinterpret", () => {
    const { calls, spawn } = fakeSpawn();
    const open = createBrowserOpener({ platform: "win32", warn: assert.fail, spawn });
    for (const url of [
      "http://localhost:4400/a/x/&calc",
      'http://localhost:4400/"x',
      "http://localhost:4400/%USERPROFILE%",
      "http://localhost:4400/ x",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      assert.equal(open(url), false, url);
    }
    assert.equal(calls.length, 0);
    assert.equal(open("http://localhost:4400/a/01hzx3k5m7n9p1q3r5s7t9v1w3/"), true);
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
  });

  it("never throws: a spawn failure returns false and warns once", async () => {
    const warnings: string[] = [];
    const thrower = createBrowserOpener({
      platform: "darwin",
      warn: (m) => warnings.push(m),
      spawn: fakeSpawn("throw").spawn,
    });
    assert.equal(thrower(URL_), false);
    assert.equal(thrower(URL_), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cannot open the browser \(spawn EINVAL\).*--no-open/);

    const missing: string[] = [];
    const async = createBrowserOpener({
      platform: "linux",
      warn: (m) => missing.push(m),
      spawn: fakeSpawn("error-event").spawn,
    });
    assert.equal(async(URL_), true);
    assert.equal(async(URL_), true);
    await new Promise((r) => setImmediate(r));
    assert.equal(missing.length, 1);
    assert.match(missing[0], /spawn ENOENT/);
  });
});
