// The client commands against a real `artifact serve` (docs/decisions/0041–0044). The opener is
// the ARTIFACT_OPENER_LOG file, so no browser is ever launched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanup, freePort, runCli, type Served, serve, tempRoot } from "../support/e2e.ts";

after(cleanup);

// Spawned `git` must not apply the user's config (url.<base>.insteadOf would rewrite remotes).
const gitEnv = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

/** A temp git repository whose origin is `remote`. */
function gitRepo(remote: string): string {
  const dir = tempRoot();
  const env = { ...process.env, ...gitEnv };
  execFileSync("git", ["init", "-q"], { cwd: dir, env, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, env, stdio: "pipe" });
  return dir;
}

/** Write `files` into a fresh temp directory and return it. */
function siteDir(files: Record<string, string | Uint8Array>): string {
  const dir = tempRoot();
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

type Server = { served: Served; base: string; port: number };

async function startServer(extraEnv: Record<string, string> = {}): Promise<Server> {
  const port = await freePort();
  const served = await serve(port, tempRoot(), extraEnv);
  return { served, base: `http://127.0.0.1:${port}`, port };
}

/** Run the CLI against `server` from a non-git temp cwd (unless `cwd` is given). */
function cli(
  server: { base: string },
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
) {
  return runCli(args, {
    cwd: options.cwd ?? tempRoot(),
    env: { ...gitEnv, ARTIFACT_SERVER: server.base, ...options.env },
  });
}

async function ok(run: ReturnType<typeof cli>) {
  const result = await run;
  assert.equal(result.status, 0, result.stderr);
  return result;
}

async function getJson(server: Server, path: string) {
  const res = await fetch(`${server.base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("artifact publish (e2e)", () => {
  let server: Server;
  before(async () => {
    server = await startServer();
  });

  it("publishes a file as index.html and prints the URL", async () => {
    const page = join(siteDir({ "page.html": "<h1>one</h1>" }), "page.html");
    const result = await ok(cli(server, ["publish", page]));
    const url = result.stdout.toString();
    const match = /^http:\/\/([0-9a-z]{26})\.localhost:(\d+)\/\n$/.exec(url);
    assert.ok(match, url);
    const id = match[1];
    assert.equal(match[2], String(server.port));
    assert.equal(result.stderr, `created ${id} (version 1)\n`);
    const file = await fetch(`${server.base}/api/artifacts/${id}/files/index.html`);
    assert.equal(await file.text(), "<h1>one</h1>");
  });

  it("publishes a directory with binary files byte for byte", async () => {
    const png = randomBytes(4096);
    const dir = siteDir({ "index.html": "<img src=img.png>", "img.png": png, "css/a.css": "a{}" });
    const { id } = JSON.parse(
      (await ok(cli(server, ["publish", dir, "--json"]))).stdout.toString(),
    );
    const file = await fetch(`${server.base}/api/artifacts/${id}/files/img.png`);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
    const css = await fetch(`${server.base}/api/artifacts/${id}/files/css/a.css`);
    assert.equal(await css.text(), "a{}");
  });

  it("updates with --id, and --if-version refuses a stale version", async () => {
    const dir = siteDir({ "a.html": "<p>1</p>", "b.html": "<p>2</p>" });
    const created = JSON.parse(
      (await ok(cli(server, ["publish", join(dir, "a.html"), "--json"]))).stdout.toString(),
    );
    const updated = await ok(cli(server, ["publish", join(dir, "b.html"), "--id", created.id]));
    assert.equal(updated.stdout.toString(), `${created.url}\n`);
    assert.equal(updated.stderr, `updated ${created.id} to version 2\n`);
    const file = await fetch(`${server.base}/api/artifacts/${created.id}/files/index.html`);
    assert.equal(await file.text(), "<p>2</p>");

    const stale = await cli(server, [
      "publish",
      join(dir, "a.html"),
      "--id",
      created.id,
      "--if-version",
      "1",
    ]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /^error: version_conflict: /);
    assert.equal(stale.stdout.length, 0);
    const staleJson = await cli(server, [
      "publish",
      join(dir, "a.html"),
      "--id",
      created.id,
      "--if-version",
      "1",
      "--json",
    ]);
    assert.equal(staleJson.status, 1);
    assert.equal(staleJson.stdout.length, 0);
    assert.ok(staleJson.stderr.endsWith("\n") && !staleJson.stderr.slice(0, -1).includes("\n"));
    assert.deepEqual(JSON.parse(staleJson.stderr), {
      error: "version_conflict",
      message: "version conflict: current version is 2",
      currentVersion: 2,
    });
    const current = await ok(
      cli(server, ["publish", join(dir, "a.html"), "--id", created.id, "--if-version", "2"]),
    );
    assert.equal(current.stderr, `updated ${created.id} to version 3\n`);
  });

  it("--json prints the API response", async () => {
    const page = join(siteDir({ "p.html": "x" }), "p.html");
    const result = await ok(cli(server, ["publish", page, "--json", "--title", "T"]));
    const body = JSON.parse(result.stdout.toString());
    assert.equal(body.version, 1);
    assert.equal(body.opened, false);
    assert.match(body.url, new RegExp(`^http://${body.id}\\.localhost:${server.port}/$`));
    assert.equal((await getJson(server, `/api/artifacts/${body.id}`)).body.title, "T");
  });

  it("skips files of types the server rejects, and lists them with --json", async () => {
    const dir = siteDir({
      "index.html": "<p>i</p>",
      README: "read me",
      "src/app.ts": "let x = 1;",
      "a.css": "a{}",
    });
    const human = await ok(cli(server, ["publish", dir]));
    assert.match(
      human.stderr,
      /^skipped 2 file\(s\) with unsupported types: README, src\/app\.ts\ncreated [0-9a-z]{26} \(version 1\)\n$/,
    );
    const result = await ok(cli(server, ["publish", dir, "--json"]));
    const body = JSON.parse(result.stdout.toString());
    assert.deepEqual(body.skipped, ["README", "src/app.ts"]);
    for (const [path, status] of [
      ["a.css", 200],
      ["README", 404],
      ["src/app.ts", 404],
    ] as const) {
      const file = await fetch(`${server.base}/api/artifacts/${body.id}/files/${path}`);
      assert.equal(file.status, status, path);
    }
    const plain = JSON.parse(
      (
        await ok(cli(server, ["publish", siteDir({ "index.html": "x" }), "--json"]))
      ).stdout.toString(),
    );
    assert.equal(plain.skipped, undefined);

    const noIndex = await cli(server, ["publish", siteDir({ "page.html": "x", "x.ts": "" })]);
    assert.equal(noIndex.status, 1);
    assert.match(
      noIndex.stderr,
      /^skipped 1 file\(s\) with unsupported types: x\.ts\nerror: invalid_input: .* has no index\.html at its top level\n$/,
    );
    const empty = await cli(server, ["publish", siteDir({ "notes.ts": "" })]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /error: invalid_input: .* has no files to publish\n$/);
  });

  it("stores the project derived from the git repo, and none with --no-project", async () => {
    const repo = gitRepo("https://github.com/Acme/Derived.git");
    writeFileSync(join(repo, "index.html"), "<p>p</p>");
    const derived = JSON.parse(
      (await ok(cli(server, ["publish", "index.html", "--json"], { cwd: repo }))).stdout.toString(),
    );
    assert.equal(derived.project, "github.com/acme/derived");
    const meta = await getJson(server, `/api/artifacts/${derived.id}`);
    assert.equal(meta.body.project, "github.com/acme/derived");

    const none = JSON.parse(
      (
        await ok(cli(server, ["publish", "index.html", "--json", "--no-project"], { cwd: repo }))
      ).stdout.toString(),
    );
    assert.equal(none.project, undefined);
    assert.equal((await getJson(server, `/api/artifacts/${none.id}`)).body.project, undefined);

    const empty = await cli(server, ["publish", "index.html", "--project", ""], { cwd: repo });
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /^artifact publish: --project must not be empty; use --no-project/);
  });

  it("usage errors exit 2 with the command's usage", async () => {
    const page = join(siteDir({ "p.html": "x" }), "p.html");
    const result = await cli(server, ["publish", page, "--if-version", "1"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^artifact publish: --if-version requires --id\n\nUsage: /);
    const withJson = await cli(server, ["publish", page, "--if-version", "1", "--json"]);
    assert.equal(withJson.status, 2);
    assert.match(withJson.stderr, /^artifact publish: --if-version requires --id\n\nUsage: /);
    assert.equal((await cli(server, ["publish"])).status, 2);
    assert.equal((await cli(server, ["publish", page, "--bogus"])).status, 2);
    const help = await ok(cli(server, ["publish", "--help"]));
    assert.match(help.stdout.toString(), /^Usage: artifact publish/);
  });
});

describe("artifact publish opens new artifacts through serve's opener (e2e)", () => {
  it("opens on create unless --no-open", async () => {
    const log = join(tempRoot(), "opened.log");
    const server = await startServer({
      DISPLAY: ":99",
      ARTIFACT_OPEN: "",
      BROWSER: "",
      ARTIFACT_OPENER_LOG: log,
    });
    const page = join(siteDir({ "p.html": "x" }), "p.html");
    const opened = await ok(cli(server, ["publish", page, "--json"]));
    const body = JSON.parse(opened.stdout.toString());
    assert.equal(body.opened, true);
    assert.equal(readFileSync(log, "utf8"), `${body.url}\n`);

    const human = await ok(cli(server, ["publish", page]));
    assert.match(human.stderr, /^created [0-9a-z]{26} \(version 1, opened in the browser\)\n$/);

    const quiet = await ok(cli(server, ["publish", page, "--json", "--no-open"]));
    const quietBody = JSON.parse(quiet.stdout.toString());
    assert.equal(quietBody.opened, false);
    assert.ok(!readFileSync(log, "utf8").includes(quietBody.url));
  });
});

describe("artifact client errors (e2e)", () => {
  it("forwards ARTIFACT_TOKEN; without it the server's unauthorized is printed", async () => {
    const server = await startServer({ ARTIFACT_TOKEN: "s3cret" });
    const page = join(siteDir({ "p.html": "x" }), "p.html");
    await ok(cli(server, ["publish", page], { env: { ARTIFACT_TOKEN: "s3cret" } }));
    const denied = await cli(server, ["publish", page]);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /^error: unauthorized: /);
  });

  it("explains how to start a server when none answers", async () => {
    const nothing = { base: `http://127.0.0.1:${await freePort()}` };
    const page = join(siteDir({ "p.html": "x" }), "p.html");
    const result = await cli(nothing, ["publish", page]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^error: no_server: no artifact server answered at http:\/\/127/);
    assert.ok(result.stderr.includes("start one with `artifact serve`"), result.stderr);
    assert.equal(result.stdout.length, 0);
    const json = await cli(nothing, ["publish", page, "--json"]);
    assert.equal(json.status, 1);
    assert.equal(json.stdout.length, 0);
    const error = JSON.parse(json.stderr);
    assert.deepEqual(Object.keys(error), ["error", "message"]);
    assert.equal(error.error, "no_server");
    assert.match(error.message, /^no artifact server answered at http:\/\/127/);
    const missing = await cli(nothing, ["publish", join(tempRoot(), "nope.html"), "--json"]);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stderr).error, "io_error");
  });
});
