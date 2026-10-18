// `artifact serve` sweeps orphans left in the root before it starts listening (0047).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { createUlidIdGen } from "../../src/adapters/ulid.ts";
import { cleanup, freePort, serve, tempRoot } from "../support/e2e.ts";

after(cleanup);

/** Write a file under the root, optionally backdating its mtime. */
function plant(root: string, key: string, ageMs = 0): string {
  const file = join(root, ...key.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "<body>orphan</body>");
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(file, t, t);
  }
  return file;
}

describe("orphan sweep on serve startup (e2e)", () => {
  it("removes old orphans, keeps recent ones and every committed version", async () => {
    const root = tempRoot();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const first = await serve(port, root);
    const created = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "index.html": "<body>one</body>" } }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    assert.doesNotMatch(first.stdout(), /orphan sweep/);
    first.child.kill("SIGTERM");
    assert.equal(await first.exited, 0);

    const hour = 60 * 60 * 1000;
    const fresh = createUlidIdGen().next();
    plant(root, `artifacts/${fresh}/v/1/src/index.html`, hour);
    const oldVersion = plant(root, `artifacts/${id}/v/9/src/index.html`, hour);
    const recentVersion = plant(root, `artifacts/${id}/v/8/src/index.html`);

    const second = await serve(port, root);
    assert.match(
      second.stdout(),
      /artifact: orphan sweep removed 1 uncommitted version\(s\) and 1 folder\(s\) without meta\.json/,
    );
    assert.equal(existsSync(join(root, "artifacts", fresh)), false);
    assert.equal(existsSync(oldVersion), false);
    assert.equal(existsSync(join(root, "artifacts", id, "v", "9")), false);
    assert.equal(existsSync(recentVersion), true);
    assert.match(await (await fetch(`${base}/a/${id}/`)).text(), /^<body>one<script/);
    second.child.kill("SIGTERM");
    assert.equal(await second.exited, 0);
  });
});
