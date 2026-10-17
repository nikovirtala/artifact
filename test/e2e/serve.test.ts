// `artifact serve` over real sockets: spawn the CLI on a free port and a temp root.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const env = { ...process.env, ARTIFACT_TOKEN: "", ARTIFACT_PORT: "", ARTIFACT_CSP: "" };
const children: ChildProcess[] = [];
const roots: string[] = [];

after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "artifact-e2e-"));
  roots.push(root);
  return root;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

type Served = { child: ChildProcess; stderr: () => string; exited: Promise<number | null> };

/** Start `serve` and wait for its "serving" line. */
async function serve(port: number, root: string): Promise<Served> {
  const child = spawn(process.execPath, [main, "serve", "--port", String(port), "--root", root], {
    env,
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${stderr}`)), 10_000);
    child.stdout?.on("data", (d) => {
      stdout += d;
      if (stdout.includes("serving")) {
        clearTimeout(timer);
        resolve();
      }
    });
    exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`serve exited early: ${stderr}`));
    });
  });
  return { child, stderr: () => stderr, exited };
}

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
