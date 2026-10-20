// The CLI's server-version warning (docs/decisions/0064): one stderr line on a major mismatch
// with a remote server, silence on any failure, no request at all to a loopback server.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connect } from "../../src/cli/client.ts";
import type { CliContext } from "../../src/cli/output.ts";
import { checkServerVersion, isLoopbackServer } from "../../src/cli/version-check.ts";
import { PACKAGE_VERSION } from "../../src/version.ts";

const SERVER = "https://api.example.dev";
const major = Number(PACKAGE_VERSION.split(".")[0]);

type Seen = { url: string; headers: Record<string, string> };

/** A fetch that answers `GET /api` with `version` (or a custom response) and records calls. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    if (url.endsWith("/api")) return answer();
    return new Response(JSON.stringify({ artifacts: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const versionResponse = (version: unknown) =>
  new Response(JSON.stringify({ version }), { headers: { "content-type": "application/json" } });

function context(env: Record<string, string> = {}) {
  let err = "";
  const ctx = {
    env,
    cwd: "/",
    home: "/",
    stdin: process.stdin,
    stdout: { write: () => true },
    stderr: {
      write: (s: string) => {
        err += s;
        return true;
      },
    },
  } as unknown as CliContext;
  return { ctx, stderr: () => err };
}

describe("checkServerVersion", () => {
  it("warns once on a different major version", async () => {
    const { fetch, seen } = fakeFetch(() => versionResponse(`${major + 1}.0.0`));
    const warning = await checkServerVersion({ server: SERVER, token: "t", fetch });
    assert.equal(
      warning,
      `artifact: warning: the server at ${SERVER} runs artifact ${major + 1}.0.0, this CLI is ${PACKAGE_VERSION}; major versions differ, so commands may fail or behave differently`,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${SERVER}/api`);
    assert.equal(seen[0].headers.authorization, "Bearer t");
  });

  it("is silent on the same major, failures and invalid versions", async () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ["same major", () => versionResponse(`${major}.99.1-rc.1`)],
      ["404", () => new Response("{}", { status: 404 })],
      ["network error", () => Promise.reject(new TypeError("fetch failed"))],
      ["not json", () => new Response("<html>")],
      ["no version", () => new Response(JSON.stringify({ v: 1 }))],
      ["number", () => versionResponse(9)],
      ["control characters", () => versionResponse("9.0.0\u001b[2J")],
      ["overlong suffix", () => versionResponse(`9.0.0-${"a".repeat(65)}`)],
      ["not semver", () => versionResponse("9.0")],
    ];
    for (const [name, answer] of cases) {
      const { fetch } = fakeFetch(answer);
      assert.equal(await checkServerVersion({ server: SERVER, fetch }), undefined, name);
    }
  });
});

describe("isLoopbackServer", () => {
  it("knows localhost, *.localhost, 127.0.0.0/8 and [::1]", () => {
    for (const s of [
      "http://localhost:4400",
      "http://x.localhost:4400",
      "http://127.0.0.5",
      "http://[::1]:4400",
    ]) {
      assert.equal(isLoopbackServer(s), true, s);
    }
    for (const s of [
      SERVER,
      "http://10.0.0.1",
      "http://localhost.example.com",
      "http://128.0.0.1",
    ]) {
      assert.equal(isLoopbackServer(s), false, s);
    }
  });
});

describe("connect", () => {
  it("checks a remote server once, before the first request, and never fails a command", async () => {
    const { fetch, seen } = fakeFetch(() => versionResponse(`${major + 1}.0.0`));
    const { ctx, stderr } = context({ ARTIFACT_TOKEN: "t" });
    const client = connect(ctx, SERVER, { fetch });
    await client.json("GET", "/api/artifacts");
    await client.json("GET", "/api/artifacts");
    assert.deepEqual(
      seen.map((s) => s.url),
      [`${SERVER}/api`, `${SERVER}/api/artifacts`, `${SERVER}/api/artifacts`],
    );
    assert.equal(stderr().split("\n").filter(Boolean).length, 1);
    assert.match(stderr(), /major versions differ/);
  });

  it("sends no extra request to a loopback server", async () => {
    for (const server of [
      "http://localhost:4400",
      "http://x.localhost:4400",
      "http://127.0.0.5:4400",
      "http://[::1]:4400",
    ]) {
      const { fetch, seen } = fakeFetch(() => versionResponse(`${major + 1}.0.0`));
      const { ctx, stderr } = context();
      await connect(ctx, server, { fetch }).json("GET", "/api/artifacts");
      assert.deepEqual(
        seen.map((s) => s.url),
        [`${server}/api/artifacts`],
      );
      assert.equal(stderr(), "");
    }
  });

  it("proceeds silently when the check fails", async () => {
    const { fetch, seen } = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const { ctx, stderr } = context();
    const { body } = await connect(ctx, SERVER, { fetch }).json("GET", "/api/artifacts");
    assert.deepEqual(body, { artifacts: [] });
    assert.equal(seen.length, 2);
    assert.equal(stderr(), "");
  });
});
