// The README documents what `artifact init` writes; both come from src/cli/snippet.ts (0046).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AGENT_SNIPPET,
  END,
  mcpAddCommand,
  projectPin,
  START,
  snippetBlock,
} from "../../src/cli/snippet.ts";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("agent snippet", () => {
  it("the README contains the snippet, the pin example and both mcp add lines", () => {
    assert.ok(readme.includes(AGENT_SNIPPET), "snippet");
    assert.ok(readme.includes(projectPin("github.com/you/repo")), "pin");
    assert.ok(readme.includes(`${mcpAddCommand("http://localhost:4400", false)}\n`), "mcp add");
    assert.ok(readme.includes(mcpAddCommand("http://localhost:4400", true)), "mcp add --header");
  });

  it("the block is the markers around the snippet, with the pin only when given", () => {
    assert.equal(snippetBlock(), `${START}\n${AGENT_SNIPPET}\n${END}`);
    assert.equal(
      snippetBlock("local:/tmp/x"),
      `${START}\n${AGENT_SNIPPET}\n\n${projectPin("local:/tmp/x")}\n${END}`,
    );
    assert.equal(
      projectPin('a"b'),
      'For this codebase, pass exactly `project: "a\\"b"` on every artifacts tool call.',
    );
  });

  it("the mcp add line names the literal variable, never a token", () => {
    assert.equal(
      mcpAddCommand("https://h:1", true),
      'claude mcp add --scope user --transport http artifacts https://h:1/mcp --header "Authorization: Bearer $ARTIFACT_TOKEN"',
    );
  });
});
