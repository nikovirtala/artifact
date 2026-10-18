// The client commands against a real `artifact serve` (docs/decisions/0041–0044). The opener is
// the ARTIFACT_OPENER_LOG file, so no browser is ever launched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { devNull } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  cleanup,
  freePort,
  openerLog,
  runCli,
  type Served,
  serve,
  tempRoot,
} from "../support/e2e.ts";

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

describe("artifact list, read, open (e2e)", () => {
  let server: Server;
  let repoA: string;
  let repoB: string;
  const inA: string[] = [];
  let inB: string;
  const html = "<!doctype html><h1>site</h1><img src=img.png>";
  const png = randomBytes(2048);
  let site: { id: string; url: string };

  before(async () => {
    server = await startServer();
    repoA = gitRepo("https://github.com/Acme/A.git");
    repoB = gitRepo("git@github.com:acme/b.git");
    writeFileSync(join(repoA, "index.html"), "<p>a</p>");
    writeFileSync(join(repoB, "index.html"), "<p>b</p>");
    const dir = siteDir({ "index.html": html, "img.png": png, "css/a.css": "a{}" });
    site = JSON.parse(
      (
        await ok(cli(server, ["publish", dir, "--json", "--title", "Site"], { cwd: repoA }))
      ).stdout.toString(),
    );
    inA.push(site.id);
    const second = await ok(cli(server, ["publish", "index.html", "--json"], { cwd: repoA }));
    inA.push(JSON.parse(second.stdout.toString()).id);
    const b = await ok(cli(server, ["publish", "index.html", "--json"], { cwd: repoB }));
    inB = JSON.parse(b.stdout.toString()).id;
  });

  it("lists the derived project by default, every project with --all", async () => {
    const listedA = await ok(cli(server, ["list"], { cwd: repoA }));
    assert.equal(listedA.stderr, "1 more in other projects (or without a project); use --all\n");
    const listA = listedA.stdout.toString();
    const lines = listA.trimEnd().split("\n");
    assert.equal(lines[0], "project: github.com/acme/a");
    assert.match(lines[1], /^ID +VERSION +UPDATED +TITLE$/);
    assert.equal(lines.length, 4);
    for (const id of inA) assert.ok(listA.includes(id), id);
    assert.ok(!listA.includes(inB));
    assert.match(listA, new RegExp(`^${site.id} +1 +\\S+ +Site$`, "m"));

    const listedAll = await ok(cli(server, ["list", "--all"], { cwd: repoA }));
    assert.equal(listedAll.stderr, "");
    const all = listedAll.stdout.toString();
    const allLines = all.trimEnd().split("\n");
    assert.equal(allLines[0], "all projects");
    assert.match(allLines[1], /^ID +VERSION +UPDATED +PROJECT +TITLE$/);
    assert.equal(allLines.length, 5);
    for (const id of [...inA, inB]) assert.ok(all.includes(id), id);
    assert.match(all, /github\.com\/acme\/b/);
  });

  it("lists as JSON, by --project, and refuses --all with --project", async () => {
    const listedJson = await ok(cli(server, ["list", "--json"], { cwd: repoA }));
    assert.equal(listedJson.stderr, "");
    const json = JSON.parse(listedJson.stdout.toString());
    assert.deepEqual(json.artifacts.map((a: { id: string }) => a.id).sort(), [...inA].sort());
    const listedB = await ok(
      cli(server, ["list", "--project", "https://github.com/Acme/B.git"], { cwd: repoA }),
    );
    assert.equal(listedB.stderr, "2 more in other projects (or without a project); use --all\n");
    const byFlag = listedB.stdout.toString();
    assert.match(byFlag, /^project: github\.com\/acme\/b\n/);
    assert.ok(byFlag.includes(inB));
    assert.ok(!byFlag.includes(inA[0]));
    const limited = JSON.parse(
      (await ok(cli(server, ["list", "--all", "--limit", "1", "--json"]))).stdout.toString(),
    );
    assert.equal(limited.artifacts.length, 1);
    const limitedA = await ok(cli(server, ["list", "--limit", "1"], { cwd: repoA }));
    assert.equal(limitedA.stdout.toString().trimEnd().split("\n").length, 3);
    assert.equal(limitedA.stderr, "1 more in other projects (or without a project); use --all\n");
    const listedElsewhere = await ok(cli(server, ["list"]));
    assert.match(listedElsewhere.stdout.toString(), /^project: local:\/.*\nno artifacts\n$/);
    assert.equal(
      listedElsewhere.stderr,
      "3 more in other projects (or without a project); use --all\n",
    );
    const both = await cli(server, ["list", "--all", "--project", "x"]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /^artifact list: --all and --project cannot be combined/);
  });

  it("prints no hint when nothing is hidden or the unfiltered request fails", async () => {
    let unfiltered: "same" | "fail" = "same";
    const artifact = { id: inB, project: "github.com/acme/b", currentVersion: 1, updatedAt: "t" };
    const fake = createServer((req, res) => {
      const filtered = new URL(req.url ?? "/", "http://x").searchParams.has("project");
      if (!filtered && unfiltered === "fail") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ artifacts: [artifact] }));
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
      for (const mode of ["same", "fail"] as const) {
        unfiltered = mode;
        const result = await ok(cli({ base }, ["list"], { cwd: repoB }));
        assert.match(result.stdout.toString(), /^project: github\.com\/acme\/b\n/);
        assert.equal(result.stderr, "", mode);
      }
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });

  it("reads files byte for byte, and the meta with --json", async () => {
    const page = await ok(cli(server, ["read", site.id]));
    assert.deepEqual(page.stdout, Buffer.from(html));
    const image = await ok(cli(server, ["read", site.id, "--path", "img.png"]));
    assert.deepEqual(image.stdout, png);
    const meta = JSON.parse((await ok(cli(server, ["read", site.id, "--json"]))).stdout.toString());
    assert.equal(meta.id, site.id);
    assert.deepEqual(
      meta.versions.map((v: { version: number }) => v.version),
      [1],
    );
    const missing = await cli(server, ["read", site.id, "--path", "nope.css"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^error: not_found: /);
    const combined = await cli(server, ["read", site.id, "--json", "--out", tempRoot()]);
    assert.equal(combined.status, 2);
  });

  it("round-trips --out: edit the written files and publish them back", async () => {
    const page = join(siteDir({ "p.html": "<p>v1</p>" }), "p.html");
    const { id } = JSON.parse(
      (await ok(cli(server, ["publish", page, "--json"]))).stdout.toString(),
    );
    const fromSite = tempRoot();
    const wrote = await ok(cli(server, ["read", site.id, "--out", fromSite]));
    assert.equal(wrote.stdout.toString(), `wrote 3 files of ${site.id} version 1 to ${fromSite}\n`);
    assert.equal(readFileSync(join(fromSite, "index.html"), "utf8"), html);
    assert.deepEqual(readFileSync(join(fromSite, "img.png")), png);
    assert.equal(readFileSync(join(fromSite, "css", "a.css"), "utf8"), "a{}");

    writeFileSync(join(fromSite, "index.html"), "<p>edited</p>");
    const republished = await ok(cli(server, ["publish", fromSite, "--id", id]));
    assert.equal(republished.stderr, `updated ${id} to version 2\n`);
    assert.deepEqual((await ok(cli(server, ["read", id]))).stdout, Buffer.from("<p>edited</p>"));
    assert.deepEqual((await ok(cli(server, ["read", id, "--path", "img.png"]))).stdout, png);
    assert.deepEqual(
      (await ok(cli(server, ["read", id, "--version", "1"]))).stdout,
      Buffer.from("<p>v1</p>"),
    );
    const old = tempRoot();
    await ok(cli(server, ["read", id, "--version", "1", "--out", old]));
    assert.equal(readFileSync(join(old, "index.html"), "utf8"), "<p>v1</p>");
  });

  it("opens the URL through the test opener, pinned with --version", async () => {
    const opened = await ok(cli(server, ["open", site.id]));
    assert.equal(opened.stdout.toString(), `${site.url}\n`);
    assert.ok(readFileSync(openerLog, "utf8").split("\n").includes(site.url));

    const pinned = await ok(cli(server, ["open", site.id, "--version", "1", "--json"]));
    const body = JSON.parse(pinned.stdout.toString());
    assert.deepEqual(body, { id: site.id, url: `${site.url}v/1/`, opened: true });
    assert.ok(readFileSync(openerLog, "utf8").split("\n").includes(`${site.url}v/1/`));

    const none = await ok(cli(server, ["open", site.id, "--json"], { env: { BROWSER: "none" } }));
    assert.equal(JSON.parse(none.stdout.toString()).opened, false);

    const missing = await cli(server, ["open", site.id, "--version", "99"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^error: not_found: version 99 /);
    assert.equal(missing.stdout.length, 0);
    const missingJson = await cli(server, ["open", site.id, "--version", "99", "--json"]);
    assert.equal(missingJson.status, 1);
    assert.equal(missingJson.stdout.length, 0);
    assert.deepEqual(JSON.parse(missingJson.stderr), {
      error: "not_found",
      message: `version 99 of artifact ${site.id} not found`,
    });
  });
});

describe("artifact rollback and rm (e2e)", () => {
  let server: Server;
  before(async () => {
    server = await startServer();
  });

  async function twoVersions(): Promise<{ id: string; url: string }> {
    const dir = siteDir({ "one.html": "<p>one</p>", "two.html": "<p>two</p>" });
    const created = JSON.parse(
      (await ok(cli(server, ["publish", join(dir, "one.html"), "--json"]))).stdout.toString(),
    );
    await ok(cli(server, ["publish", join(dir, "two.html"), "--id", created.id]));
    return created;
  }

  it("rolls back to an earlier version", async () => {
    const { id, url } = await twoVersions();
    const result = await ok(cli(server, ["rollback", id, "1"]));
    assert.equal(result.stdout.toString(), `${url}\n`);
    assert.equal(result.stderr, `rolled back ${id} to version 1\n`);
    assert.equal((await getJson(server, `/api/artifacts/${id}`)).body.currentVersion, 1);
    assert.match(await (await fetch(`${server.base}/a/${id}/`)).text(), /^<p>one<\/p><script/);

    const json = JSON.parse(
      (await ok(cli(server, ["rollback", id, "2", "--json"]))).stdout.toString(),
    );
    assert.deepEqual(json, { id, version: 2, url });
    const missing = await cli(server, ["rollback", id, "9"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^error: not_found: /);
    for (const args of [
      ["rollback", id, "x"],
      ["rollback", id, "0"],
      ["rollback", id],
    ]) {
      assert.equal((await cli(server, args)).status, 2, args.join(" "));
    }
  });

  it("rm needs --yes without a TTY, then deletes; a second rm is not_found", async () => {
    const { id } = await twoVersions();
    const refused = await cli(server, ["rm", id]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /^artifact rm: stdin is not a terminal; pass --yes/);
    assert.equal((await getJson(server, `/api/artifacts/${id}`)).status, 200);

    const deleted = await ok(cli(server, ["rm", id, "--yes"]));
    assert.equal(deleted.stdout.toString(), `deleted ${id}\n`);
    assert.equal((await getJson(server, `/api/artifacts/${id}`)).status, 404);
    const again = await cli(server, ["rm", id, "--yes"]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /^error: not_found: /);
    const againJson = await cli(server, ["rm", id, "--yes", "--json"]);
    assert.equal(againJson.status, 1);
    assert.equal(againJson.stdout.length, 0);
    assert.equal(JSON.parse(againJson.stderr).error, "not_found");
    const refusedJson = await cli(server, ["rm", id, "--json"]);
    assert.equal(refusedJson.status, 2);
    assert.match(refusedJson.stderr, /^artifact rm: stdin is not a terminal; pass --yes/);

    const other = await twoVersions();
    const json = await ok(cli(server, ["rm", other.id, "--yes", "--json"]));
    assert.deepEqual(JSON.parse(json.stdout.toString()), { ok: true });
  });
});
