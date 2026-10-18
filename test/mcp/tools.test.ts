// The MCP tools through the SDK client and the Streamable HTTP handler, in-process.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIMITS } from "../../src/core/artifact-service.ts";
import { createMcpHandler, type McpConfig } from "../../src/mcp/server.ts";
import { harness } from "../support/fakes.ts";
import { connectMcp } from "../support/mcp.ts";

const PORT = 4400;
const URL_ = `http://localhost:${PORT}/mcp`;
const page = (s: string) => ({ "index.html": `<body>${s}</body>` });

async function setup(config: Partial<McpConfig> = {}) {
  const h = harness();
  const handler = createMcpHandler({
    service: h.service,
    config: { port: PORT, isolation: "subdomain", ...config },
  });
  const mcp = await connectMcp(URL_, { handler });
  const publish = async (args: Record<string, unknown> = { files: page("1") }) => {
    const r = await mcp.call("artifact_publish", args);
    assert.equal(r.isError, false, JSON.stringify(r.value));
    return r.value as { id: string; version: number; url: string };
  };
  return { ...h, handler, mcp, publish };
}

describe("tools/list", () => {
  it("lists exactly the five tools with object input schemas and descriptions", async () => {
    const { mcp } = await setup();
    const { tools } = await mcp.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "artifact_delete",
      "artifact_list",
      "artifact_publish",
      "artifact_read",
      "artifact_rollback",
    ]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
      assert.ok(t.description && t.description.length > 40, t.name);
    }
    const props = (name: string) => Object.keys(by[name].inputSchema.properties ?? {}).sort();
    assert.deepEqual(props("artifact_publish"), [
      "file_path",
      "files",
      "id",
      "if_version",
      "label",
      "project",
      "title",
    ]);
    assert.deepEqual(props("artifact_list"), ["all", "limit", "project"]);
    assert.deepEqual(props("artifact_read"), ["id", "path", "version"]);
    assert.deepEqual(props("artifact_rollback"), ["id", "version"]);
    assert.deepEqual(props("artifact_delete"), ["confirm", "id"]);
    assert.deepEqual(by.artifact_delete.inputSchema.required, ["id", "confirm"]);
    assert.deepEqual(by.artifact_rollback.inputSchema.required?.sort(), ["id", "version"]);
    const limit = by.artifact_list.inputSchema.properties?.limit as Record<string, unknown>;
    assert.equal(limit.minimum, 1);
    assert.equal(limit.maximum, LIMITS.maxListLimit);
    assert.equal(by.artifact_list.annotations?.readOnlyHint, true);
    assert.equal(by.artifact_delete.annotations?.destructiveHint, true);
  });

  it("encodes the agent rules in the descriptions", async () => {
    const { mcp } = await setup();
    const { tools } = await mcp.client.listTools();
    const d = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    const useThis =
      /^Use this whenever the user asks for an HTML page, mock-up, visualization, report, dashboard, or an "artifact": publish it here and give the user the URL\. Do not use the client's built-in artifact features for these\./;
    assert.match(d.artifact_publish, useThis);
    const instructions = mcp.client.getInstructions() ?? "";
    assert.match(instructions, useThis);
    assert.match(instructions, /publish to its existing id instead of creating a new artifact/);
    assert.match(instructions, /use artifact_list to find the id/);
    assert.match(d.artifact_publish, /Omit id to create/);
    assert.match(d.artifact_publish, /Pass id to update/);
    assert.match(d.artifact_publish, /keeps its URL/);
    assert.match(d.artifact_publish, /artifact_list/);
    assert.match(
      d.artifact_publish,
      /version_conflict.*retry the same call, and do not add if_version/,
    );
    assert.match(
      d.artifact_publish,
      /if opened is true, tell the user the page is open in their browser; otherwise show them the url\. Never open it yourself\./,
    );
    assert.match(d.artifact_list, /recover the id .* instead of creating a duplicate/);
    assert.match(d.artifact_read, /Read before editing an artifact this session did not publish/);
    assert.match(d.artifact_read, /not the page served/);
    assert.match(d.artifact_read, /reload script/);
    assert.match(d.artifact_rollback, /back to an earlier/);
    assert.match(d.artifact_delete, /Only call this when the user explicitly asks/);
    assert.match(d.artifact_delete, /confirm: true/);
  });

  it("tells the agent to pass project on every call and how to derive it", async () => {
    const { mcp } = await setup();
    const { tools } = await mcp.client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["artifact_publish", "artifact_list"]) {
      const d = by[name].description ?? "";
      assert.match(d, /Pass project on every call/, name);
      assert.match(
        d,
        /Never ask the user about, or act on, artifacts outside the current project unless they refer to them/,
        name,
      );
      const project = by[name].inputSchema.properties?.project as { description?: string };
      const field = project?.description;
      assert.match(field ?? "", /Derive it exactly; do not invent or shorten it\./, name);
      assert.match(
        field ?? "",
        /1\. Run `git remote get-url origin`; if it succeeds, pass that URL as-is/,
      );
      assert.match(
        field ?? "",
        /2\. Otherwise, if `git rev-parse --show-toplevel` succeeds, pass `local:` \+ that path/,
      );
      assert.match(
        field ?? "",
        /3\. Otherwise pass `local:` \+ the absolute current working directory/,
      );
      assert.match(
        field ?? "",
        /If your instructions \(e\.g\. CLAUDE\.md\) state a project value, use that instead/,
      );
      assert.match(field ?? "", /Use the same value for every call in the session/);
    }
    assert.match(by.artifact_list.description ?? "", /you get only that project's artifacts/);
    assert.match(
      by.artifact_list.description ?? "",
      /Use all: true only when the user asks about artifacts from other projects/,
    );
  });
});

describe("artifact_publish", () => {
  it("creates without id, then updates in place by id (version + 1, same url)", async () => {
    const { mcp, publish, notifier } = await setup();
    const created = await publish({ title: "T", files: page("1") });
    assert.equal(created.version, 1);
    assert.equal(created.url, `http://${created.id}.localhost:${PORT}/`);
    const updated = await publish({ id: created.id.toUpperCase(), files: page("2") });
    assert.deepEqual(updated, { ...created, version: 2 });
    assert.deepEqual(
      notifier.events.map((e) => e.type),
      ["published", "published"],
    );
    const r = await mcp.call("artifact_publish", { id: created.id, files: page("3") });
    assert.deepEqual(r.result.content, [{ type: "text", text: JSON.stringify(r.value) }]);
  });

  it("accepts base64 files and returns path-mode urls with isolation path", async () => {
    const { publish } = await setup({ isolation: "path" });
    const { id, url } = await publish({
      files: { ...page("1"), "a.png": { base64: "iVBORw0KGgo=" } },
    });
    assert.equal(url, `http://localhost:${PORT}/a/${id}/`);
  });

  it("maps core errors to tool errors carrying the API error object", async () => {
    const { mcp, publish } = await setup();
    const { id } = await publish();

    const badPath = await mcp.call("artifact_publish", { files: { ...page(""), "../x.css": "" } });
    assert.equal(badPath.isError, true);
    assert.equal(badPath.value.error, "invalid_path");
    assert.equal(badPath.value.path, "../x.css");
    assert.equal(typeof badPath.value.message, "string");
    assert.deepEqual(badPath.result.content, [
      { type: "text", text: JSON.stringify(badPath.value) },
    ]);

    const noEntry = await mcp.call("artifact_publish", { files: { "a.css": "" } });
    assert.equal(noEntry.value.error, "invalid_path");

    const badId = await mcp.call("artifact_publish", { id: "nope", files: page("") });
    assert.equal(badId.isError, true);
    assert.equal(badId.value.error, "invalid_input");
    assert.equal(badId.value.field, "id");

    const label = await mcp.call("artifact_publish", { files: page(""), label: "x".repeat(61) });
    assert.deepEqual(
      [label.value.error, label.value.field, label.value.limit],
      ["invalid_input", "label", LIMITS.maxLabelChars],
    );

    const missing = await mcp.call("artifact_publish", {
      id: "0000000000000000000000000z",
      files: page(""),
    });
    assert.equal(missing.value.error, "not_found");

    const stale = await mcp.call("artifact_publish", { id, if_version: 7, files: page("") });
    assert.equal(stale.isError, true);
    assert.equal(stale.value.error, "version_conflict");
    assert.equal(stale.value.currentVersion, 1);
  });

  it("returns too_large for a file over the per-file limit", async () => {
    const { mcp } = await setup();
    const big = "x".repeat(LIMITS.maxFileBytes + 1);
    const r = await mcp.call("artifact_publish", { files: { ...page(""), "big.txt": big } });
    assert.equal(r.isError, true);
    assert.deepEqual(
      [r.value.error, r.value.subject, r.value.limit, r.value.path],
      ["too_large", "file", LIMITS.maxFileBytes, "big.txt"],
    );
  });

  it("answers schema failures with invalid_request and the Zod issues", async () => {
    const { mcp } = await setup();
    for (const args of [
      {},
      { files: page(""), if_verison: 1 },
      { files: { "a.png": { base64: "%%%" } } },
      { files: page(""), if_version: 0 },
    ]) {
      const r = await mcp.call("artifact_publish", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.equal(r.value.error, "invalid_request");
      assert.ok(Array.isArray(r.value.issues) && r.value.issues.length > 0);
    }
  });
});

describe("artifact_list", () => {
  it("lists newest first with urls, honouring limit (default 50)", async () => {
    const { mcp, publish, clock } = await setup();
    const a = await publish({ title: "a", files: page("a") });
    clock.advance(1000);
    const b = await publish();
    const all = await mcp.call("artifact_list");
    assert.deepEqual(all.value, {
      artifacts: [
        { id: b.id, currentVersion: 1, updatedAt: "2026-10-17T12:00:01.000Z", url: b.url },
        {
          id: a.id,
          title: "a",
          currentVersion: 1,
          updatedAt: "2026-10-17T12:00:00.000Z",
          url: a.url,
        },
      ],
    });
    const one = await mcp.call("artifact_list", { limit: 1 });
    assert.deepEqual(
      (one.value.artifacts as { id: string }[]).map((x) => x.id),
      [b.id],
    );
    for (let i = 0; i < 52; i++) await publish();
    const page50 = await mcp.call("artifact_list");
    assert.equal((page50.value.artifacts as unknown[]).length, 50);
  });

  it("rejects a limit outside 1..500", async () => {
    const { mcp } = await setup();
    for (const limit of [0, 501, 1.5]) {
      const r = await mcp.call("artifact_list", { limit });
      assert.equal(r.value.error, "invalid_request", String(limit));
    }
  });
});

describe("projects", () => {
  it("publish stores the normalised project; list filters by it; all lists everything", async () => {
    const { mcp, publish, clock } = await setup();
    const a = await publish({ project: "git@github.com:acme/a.git", files: page("a") });
    assert.equal((a as { project?: string }).project, "github.com/acme/a");
    clock.advance(1000);
    const b = await publish({ project: "local:/Users/me/b/", files: page("b") });
    assert.equal((b as { project?: string }).project, "local:/Users/me/b");
    clock.advance(1000);
    const none = await publish();
    const ids = async (args: Record<string, unknown>) =>
      ((await mcp.call("artifact_list", args)).value.artifacts as { id: string }[]).map(
        (x) => x.id,
      );
    assert.deepEqual(await ids({ project: "https://github.com/Acme/A" }), [a.id]);
    assert.deepEqual(await ids({ project: "local:/Users/me/b" }), [b.id]);
    assert.deepEqual(await ids({ project: "local:/Users/me/B" }), []);
    assert.deepEqual(await ids({ project: "github.com/acme/a", all: true }), [none.id, b.id, a.id]);
    assert.deepEqual(await ids({}), [none.id, b.id, a.id]);
    const listed = await mcp.call("artifact_list", { project: "github.com/acme/a" });
    assert.deepEqual(listed.value.artifacts, [
      {
        id: a.id,
        project: "github.com/acme/a",
        currentVersion: 1,
        updatedAt: "2026-10-17T12:00:00.000Z",
        url: a.url,
      },
    ]);
  });

  it("an update with a different project keeps the stored one", async () => {
    const { publish } = await setup();
    const a = await publish({ project: "github.com/acme/a", files: page("a") });
    const updated = await publish({ id: a.id, project: "github.com/acme/b", files: page("a2") });
    assert.deepEqual(updated, { ...a, version: 2 });
  });

  it("rejects an invalid project with invalid_input", async () => {
    const { mcp } = await setup();
    for (const [tool, args] of [
      ["artifact_publish", { project: "", files: page("") }],
      ["artifact_list", { project: "not a project" }],
    ] as const) {
      const r = await mcp.call(tool, args);
      assert.equal(r.isError, true, tool);
      assert.deepEqual([r.value.error, r.value.field], ["invalid_input", "project"]);
    }
  });
});

describe("artifact_read", () => {
  it("returns the published (not injected) html, other files, and older versions", async () => {
    const { mcp, publish } = await setup();
    const { id } = await publish({
      files: { ...page("1"), "a.png": { base64: "iVBORw0KGgo=" }, "d.json": "{}" },
    });
    await publish({ id, files: page("2") });

    const current = await mcp.call("artifact_read", { id: id.toUpperCase() });
    assert.deepEqual(current.value, {
      id,
      version: 2,
      path: "index.html",
      contentType: "text/html; charset=utf-8",
      content: "<body>2</body>",
    });
    const old = await mcp.call("artifact_read", { id, version: 1, path: "a.png" });
    assert.deepEqual(old.value.content, { base64: "iVBORw0KGgo=" });
    const json = await mcp.call("artifact_read", { id, version: 1, path: "d.json" });
    assert.equal(json.value.content, "{}");
  });

  it("maps unknown ids, versions and files to not_found, bad ids to invalid_input", async () => {
    const { mcp, publish } = await setup();
    const { id } = await publish();
    for (const args of [
      { id: "0000000000000000000000000z" },
      { id, version: 9 },
      { id, path: "nope.css" },
    ]) {
      const r = await mcp.call("artifact_read", args);
      assert.equal(r.isError, true);
      assert.equal(r.value.error, "not_found", JSON.stringify(args));
    }
    const bad = await mcp.call("artifact_read", { id: "x" });
    assert.deepEqual([bad.value.error, bad.value.field], ["invalid_input", "id"]);
    const traversal = await mcp.call("artifact_read", { id, path: "../meta.json" });
    assert.equal(traversal.value.error, "invalid_path");
  });
});

describe("artifact_rollback", () => {
  it("moves the pointer back and returns the new pointer", async () => {
    const { mcp, publish, notifier } = await setup();
    const { id, url } = await publish();
    await publish({ id, files: page("2") });
    const r = await mcp.call("artifact_rollback", { id, version: 1 });
    assert.deepEqual(r.value, { id, version: 1, url });
    assert.deepEqual(notifier.events.at(-1), { type: "published", id, version: 1 });
    const read = await mcp.call("artifact_read", { id });
    assert.equal(read.value.version, 1);
    const missing = await mcp.call("artifact_rollback", { id, version: 5 });
    assert.equal(missing.value.error, "not_found");
    const schema = await mcp.call("artifact_rollback", { id });
    assert.equal(schema.value.error, "invalid_request");
  });
});

describe("artifact_delete", () => {
  it("requires confirm: true, then deletes", async () => {
    const { mcp, publish } = await setup();
    const { id } = await publish();
    for (const args of [{ id }, { id, confirm: false }, { id, confirm: "true" }]) {
      const r = await mcp.call("artifact_delete", args);
      assert.equal(r.value.error, "invalid_request", JSON.stringify(args));
    }
    assert.equal((await mcp.call("artifact_read", { id })).isError, false);
    const r = await mcp.call("artifact_delete", { id, confirm: true });
    assert.deepEqual(r, { isError: false, value: { ok: true }, result: r.result });
    assert.equal((await mcp.call("artifact_read", { id })).value.error, "not_found");
    assert.equal(
      (await mcp.call("artifact_delete", { id, confirm: true })).value.error,
      "not_found",
    );
  });
});

describe("transport", () => {
  it("is stateless: no session id, and any POST works without initialize", async () => {
    const { handler } = await setup();
    const res = await handler(
      new Request(URL_, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("mcp-session-id"), null);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = await res.json();
    assert.equal(body.result.tools.length, 5);
  });

  it("answers GET and DELETE with 405", async () => {
    const { handler } = await setup();
    for (const method of ["GET", "DELETE"]) {
      const res = await handler(
        new Request(URL_, { method, headers: { accept: "text/event-stream" } }),
      );
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get("allow"), "POST");
    }
  });

  it("reports an unknown tool as a protocol error", async () => {
    const { mcp } = await setup();
    await assert.rejects(
      mcp.client.callTool({ name: "artifact_nope", arguments: {} }),
      /unknown tool/,
    );
  });
});
