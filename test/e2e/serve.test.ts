// `artifact serve` over real sockets: spawn the CLI on a free port and a temp root.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cleanup, env, freePort, main, serve, tempRoot } from "../support/e2e.ts";

after(cleanup);

/** A request with an exact target and Host header (fetch normalises paths and ignores Host). */
function raw(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function runSync(port: number, root: string) {
  return spawnSync(process.execPath, [main, "serve", "--port", String(port), "--root", root], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
}

describe("artifact serve (e2e)", () => {
  it("serves, guards, locks the root and shuts down cleanly", async () => {
    const port = await freePort();
    const root = tempRoot();
    const server = await serve(port, root);
    const base = `http://127.0.0.1:${port}`;

    const created = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "index.html": "<body>one</body>" } }),
    });
    assert.equal(created.status, 201);
    const { id, url } = await created.json();
    assert.equal(url, `http://${id}.localhost:${port}/`);
    const updated = await fetch(`${base}/api/artifacts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ files: { "index.html": "<body>two</body>" } }),
    });
    assert.equal(updated.status, 200);

    const sub = `${id}.localhost:${port}`;
    const current = await raw(port, "/", sub);
    assert.equal(current.status, 200);
    assert.match(current.body, /^<body>two<script/);
    assert.match((await raw(port, "/v/1/", sub)).body, /^<body>one<script/);
    assert.match(await (await fetch(`${base}/a/${id}/`)).text(), /^<body>two<script/);
    assert.match(await (await fetch(`${base}/a/${id}/v/1/`)).text(), /^<body>one<script/);

    assert.equal((await raw(port, "/../x", sub)).status, 400);
    assert.equal((await raw(port, "/%2e%2e/x", sub)).status, 400);
    assert.equal((await raw(port, `/a/${id}/../../x`, `localhost:${port}`)).status, 400);
    assert.equal((await raw(port, "/", "evil.example")).status, 403);

    const lock = JSON.parse(readFileSync(join(root, ".lock"), "utf8"));
    assert.equal(lock.pid, server.child.pid);
    assert.equal(lock.port, port);

    const second = runSync(await freePort(), root);
    assert.equal(second.status, 1);
    assert.match(
      second.stderr,
      new RegExp(`already served by PID ${server.child.pid} on port ${port}`),
    );

    const busy = runSync(port, tempRoot());
    assert.equal(busy.status, 1);
    assert.match(
      busy.stderr,
      new RegExp(
        `port ${port} is already in use; pick another with --port <n> or ARTIFACT_PORT=<n>`,
      ),
    );

    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
    assert.equal(existsSync(join(root, ".lock")), false);
  });

  it("takes over a stale lock left by a dead process", async () => {
    const root = tempRoot();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: dead, port: 1, startedAt: "x" }));
    const server = await serve(await freePort(), root);
    assert.match(server.stderr(), new RegExp(`took over stale lock from PID ${dead}`));
    server.child.kill("SIGTERM");
    assert.equal(await server.exited, 0);
  });
});
