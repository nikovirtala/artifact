// `artifact_publish` with `file_path`: a local HTML file read by the MCP adapter.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LIMITS } from "../../src/core/artifact-service.ts";
import { createMcpHandler } from "../../src/mcp/server.ts";
import { harness } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const dir = mkdtempSync(join(tmpdir(), "artifact-file-path-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, contents: string) {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

async function setup(allowFilePath?: boolean) {
  const handler = createMcpHandler({
    service: harness().service,
    config: { port: 4400, isolation: "subdomain", allowFilePath },
  });
  return connectMcp("http://localhost:4400/mcp", { handler });
}

describe("artifact_publish file_path", () => {
  it("publishes the file as index.html, with supporting files from files", async () => {
    const mcp = await setup();
    const path = file("page.html", '<link rel="stylesheet" href="s.css"><h1>from disk</h1>');
    const r = await mcp.call("artifact_publish", { file_path: path, files: { "s.css": "h1{}" } });
    assert.equal(r.isError, false, JSON.stringify(r.value));
    const { id } = r.value as { id: string };
    const index = await mcp.call("artifact_read", { id });
    assert.equal(index.value.path, "index.html");
    assert.equal(index.value.content, '<link rel="stylesheet" href="s.css"><h1>from disk</h1>');
    assert.equal((await mcp.call("artifact_read", { id, path: "s.css" })).value.content, "h1{}");

    file("page.html", "<h1>v2</h1>");
    const v2 = await mcp.call("artifact_publish", { id, file_path: path });
    assert.equal(v2.value.version, 2);
    assert.equal((await mcp.call("artifact_read", { id })).value.content, "<h1>v2</h1>");
  });

  it("rejects relative, non-html, missing and non-regular paths with invalid_input", async () => {
    const mcp = await setup();
    mkdirSync(join(dir, "folder.html"), { recursive: true });
    for (const [file_path, pattern] of [
      ["page.html", /absolute path/],
      ["./page.html", /absolute path/],
      [file("notes.txt", "x"), /\.html or \.htm/],
      [join(dir, "missing.html"), /ENOENT/],
      [join(dir, "folder.html"), /not a regular file|EISDIR/],
    ] as const) {
      const r = await mcp.call("artifact_publish", { file_path });
      assert.equal(r.isError, true, file_path);
      assert.equal(r.value.error, "invalid_input", file_path);
      assert.equal(r.value.field, "file_path");
      assert.match(String(r.value.message), pattern);
    }
  });

  it("rejects a file over the per-file limit as too_large before reading it", async () => {
    const mcp = await setup();
    const path = file("big.html", "");
    truncateSync(path, LIMITS.maxFileBytes + 1);
    const r = await mcp.call("artifact_publish", { file_path: path });
    assert.deepEqual(
      [r.value.error, r.value.subject, r.value.limit, r.value.path],
      ["too_large", "file", LIMITS.maxFileBytes, "index.html"],
    );
  });

  it("still applies the core path and size rules to files", async () => {
    const mcp = await setup();
    const path = file("ok.html", "<p>ok</p>");
    const traversal = await mcp.call("artifact_publish", {
      file_path: path,
      files: { "../x.css": "" },
    });
    assert.deepEqual([traversal.value.error, traversal.value.path], ["invalid_path", "../x.css"]);
    const big = await mcp.call("artifact_publish", {
      file_path: path,
      files: { "big.txt": "x".repeat(LIMITS.maxFileBytes + 1) },
    });
    assert.equal(big.value.error, "too_large");
    const both = await mcp.call("artifact_publish", {
      file_path: path,
      files: { "index.html": "x" },
    });
    assert.deepEqual([both.value.error, both.value.field], ["invalid_input", "file_path"]);
    const neither = await mcp.call("artifact_publish", { title: "t" });
    assert.equal(neither.value.error, "invalid_request");
  });

  it("is rejected with a clear error when disabled; inline files still work", async () => {
    const mcp = await setup(false);
    const r = await mcp.call("artifact_publish", { file_path: file("off.html", "<p>off</p>") });
    assert.equal(r.isError, true);
    assert.deepEqual([r.value.error, r.value.field], ["invalid_input", "file_path"]);
    assert.match(String(r.value.message), /not supported by this server.*inline/);
    const { tools } = await mcp.client.listTools();
    const publish = tools.find((t) => t.name === "artifact_publish");
    assert.match(publish?.description ?? "", /file_path is not supported by this server/);
    const inline = await mcp.call("artifact_publish", { files: { "index.html": "<p>on</p>" } });
    assert.equal(inline.isError, false);
  });
});
