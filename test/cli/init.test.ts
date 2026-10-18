import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Change, mergeDeny, upsertBlock } from "../../src/cli/init.ts";
import { END, START } from "../../src/cli/snippet.ts";

const BLOCK = `${START}\nnew text\n${END}`;

function text(change: Change): string {
  assert.ok(!("error" in change), "error" in change ? change.error : "");
  return change.text;
}

describe("upsertBlock", () => {
  it("creates a missing file with the block and a final newline", () => {
    assert.deepEqual(upsertBlock(undefined, BLOCK), { text: `${BLOCK}\n`, status: "created" });
  });

  it("appends to an empty file without a blank line", () => {
    assert.deepEqual(upsertBlock("", BLOCK), { text: `${BLOCK}\n`, status: "updated" });
  });

  it("appends after one blank line, adding the missing final newline", () => {
    assert.equal(text(upsertBlock("# Notes", BLOCK)), `# Notes\n\n${BLOCK}\n`);
    assert.equal(text(upsertBlock("# Notes\n", BLOCK)), `# Notes\n\n${BLOCK}\n`);
    assert.equal(text(upsertBlock("# Notes\n\n", BLOCK)), `# Notes\n\n${BLOCK}\n`);
  });

  it("replaces an existing block and keeps every other byte", () => {
    const prefix = "# Title\r\n\nkeep  this\n";
    const suffix = "\n\ntrailing text without newline";
    const existing = `${prefix}${START}\nold\ntext\n${END}${suffix}`;
    assert.deepEqual(upsertBlock(existing, BLOCK), {
      text: `${prefix}${BLOCK}${suffix}`,
      status: "updated",
    });
  });

  it("only the first block is replaced", () => {
    const existing = `${START}\nold\n${END}\n${START}\nsecond\n${END}\n`;
    assert.equal(text(upsertBlock(existing, BLOCK)), `${BLOCK}\n${START}\nsecond\n${END}\n`);
  });

  it("is idempotent", () => {
    const once = text(upsertBlock("# Notes\n", BLOCK));
    assert.deepEqual(upsertBlock(once, BLOCK), { text: once, status: "unchanged" });
  });

  it("refuses markers that do not pair up", () => {
    for (const existing of [
      `a\n${START}\nno end\n`,
      `a\n${END}\nno start\n`,
      `${END}\n${START}\n`,
    ]) {
      const change = upsertBlock(existing, BLOCK);
      assert.ok("error" in change, existing);
    }
  });
});

describe("mergeDeny", () => {
  it("creates settings that deny the built-in tool", () => {
    const change = mergeDeny(undefined);
    assert.equal("error" in change ? "" : change.status, "created");
    assert.deepEqual(JSON.parse(text(change)), { permissions: { deny: ["Artifact"] } });
    assert.ok(text(change).endsWith("}\n"));
  });

  it("keeps every other key and appends to an existing deny list", () => {
    const existing = JSON.stringify({
      model: "x",
      permissions: { allow: ["Bash(ls)"], deny: ["WebFetch"] },
    });
    const change = mergeDeny(existing);
    assert.equal("error" in change ? "" : change.status, "updated");
    assert.equal(
      text(change),
      `${JSON.stringify(
        { model: "x", permissions: { allow: ["Bash(ls)"], deny: ["WebFetch", "Artifact"] } },
        null,
        2,
      )}\n`,
    );
    assert.deepEqual(JSON.parse(text(mergeDeny('{"a": 1}'))), {
      a: 1,
      permissions: { deny: ["Artifact"] },
    });
  });

  it("does not add a duplicate and leaves the file as it is", () => {
    const existing = '{"permissions":{"deny":["Artifact"]}}';
    assert.deepEqual(mergeDeny(existing), { text: existing, status: "unchanged" });
  });

  it("refuses invalid JSON, non-objects and wrongly typed permissions", () => {
    for (const existing of [
      "{",
      "",
      "[]",
      "null",
      '"x"',
      '{"permissions": []}',
      '{"permissions": "x"}',
      '{"permissions": {"deny": "Artifact"}}',
      '{"permissions": {"deny": {}}}',
    ]) {
      assert.ok("error" in mergeDeny(existing), existing);
    }
  });
});
