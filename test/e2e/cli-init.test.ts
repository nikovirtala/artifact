// `artifact init` against temp directories (docs/decisions/0046). HOME is a temp dir, so the
// user's ~/.claude is never touched; no server is needed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { mcpAddCommand, projectPin, snippetBlock } from "../../src/cli/snippet.ts";
import { cleanup, runCli, tempRoot } from "../support/e2e.ts";

after(cleanup);

/** A fresh working directory and HOME. */
function dirs() {
  return { cwd: realpathSync(tempRoot()), home: realpathSync(tempRoot()) };
}

function init(
  where: { cwd: string; home: string },
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return runCli(["init", ...args], {
    cwd: where.cwd,
    env: { HOME: where.home, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
}

async function ok(run: ReturnType<typeof init>) {
  const result = await run;
  assert.equal(result.status, 0, result.stderr);
  return { ...result, out: result.stdout.toString() };
}

const read = (path: string) => readFileSync(path, "utf8");

describe("artifact init (e2e)", () => {
  it("creates CLAUDE.md with the pinned project in a fresh directory", async () => {
    const where = dirs();
    const result = await ok(init(where));
    const path = join(where.cwd, "CLAUDE.md");
    assert.equal(read(path), `${snippetBlock(`local:${where.cwd}`)}\n`);
    assert.ok(read(path).includes(projectPin(`local:${where.cwd}`)));
    assert.ok(result.out.includes(`${path}: created\n`), result.out);
    assert.ok(!existsSync(join(where.cwd, "AGENTS.md")));
    assert.ok(!existsSync(join(where.home, ".claude")));
  });

  it("updates CLAUDE.md and AGENTS.md in place and is byte-identical on re-run", async () => {
    const where = dirs();
    const claude = join(where.cwd, "CLAUDE.md");
    const agents = join(where.cwd, "AGENTS.md");
    writeFileSync(claude, "# Claude\n\nOwn rules.\n");
    writeFileSync(agents, "# Agents\r\nno final newline");
    const first = await ok(init(where, ["--project", "https://github.com/You/Repo.git"]));
    const block = snippetBlock("github.com/you/repo");
    assert.equal(read(claude), `# Claude\n\nOwn rules.\n\n${block}\n`);
    assert.equal(read(agents), `# Agents\r\nno final newline\n\n${block}\n`);
    assert.ok(first.out.includes(`${claude}: updated\n`), first.out);
    assert.ok(first.out.includes(`${agents}: updated\n`), first.out);

    // Text the user adds after the block survives a re-run too.
    writeFileSync(claude, `${read(claude)}\nMore rules.\n`);
    const before = [read(claude), read(agents)];
    const again = await ok(init(where, ["--project", "github.com/you/repo"]));
    assert.deepEqual([read(claude), read(agents)], before);
    assert.ok(again.out.includes(`${claude}: unchanged\n`), again.out);
    assert.ok(again.out.includes(`${agents}: unchanged\n`), again.out);
  });

  it("--dry-run reports and prints but writes nothing", async () => {
    const where = dirs();
    const result = await ok(init(where, ["--dry-run", "--deny-builtin"]));
    assert.ok(result.out.includes(`${join(where.cwd, "CLAUDE.md")}: would be created\n`));
    assert.ok(result.out.includes(snippetBlock(`local:${where.cwd}`)));
    assert.ok(result.out.includes('"Artifact"'));
    assert.ok(!existsSync(join(where.cwd, "CLAUDE.md")));
    assert.ok(!existsSync(join(where.cwd, ".claude")));
  });

  it("--deny-builtin merges into .claude/settings.json and keeps other keys", async () => {
    const where = dirs();
    const settings = join(where.cwd, ".claude", "settings.json");
    mkdirSync(join(where.cwd, ".claude"));
    writeFileSync(settings, '{"model": "x", "permissions": {"deny": ["WebFetch"]}}');
    const result = await ok(init(where, ["--deny-builtin"]));
    assert.deepEqual(JSON.parse(read(settings)), {
      model: "x",
      permissions: { deny: ["WebFetch", "Artifact"] },
    });
    assert.ok(result.out.includes(`${settings}: updated\n`), result.out);
    const again = await ok(init(where, ["--deny-builtin"]));
    assert.ok(again.out.includes(`${settings}: unchanged\n`), again.out);
  });

  it("refuses unparseable settings and writes nothing at all", async () => {
    const where = dirs();
    const settings = join(where.cwd, ".claude", "settings.json");
    mkdirSync(join(where.cwd, ".claude"));
    writeFileSync(settings, "{ not json");
    const result = await init(where, ["--deny-builtin"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^error: invalid_input: .*settings\.json: not valid JSON/);
    assert.equal(read(settings), "{ not json");
    assert.ok(!existsSync(join(where.cwd, "CLAUDE.md")));
  });

  it("--global writes ~/.claude without a pin; --deny-builtin goes to ~/.claude", async () => {
    const where = dirs();
    const result = await ok(init(where, ["--global", "--deny-builtin"]));
    const claude = join(where.home, ".claude", "CLAUDE.md");
    const settings = join(where.home, ".claude", "settings.json");
    assert.equal(read(claude), `${snippetBlock()}\n`);
    assert.deepEqual(JSON.parse(read(settings)), { permissions: { deny: ["Artifact"] } });
    assert.ok(result.out.includes(`${claude}: created\n`), result.out);
    assert.ok(result.out.includes(`${settings}: created\n`), result.out);
    assert.ok(!existsSync(join(where.cwd, "CLAUDE.md")));
    assert.ok(!existsSync(join(where.cwd, ".claude")));
  });

  it("--global --project is a usage error", async () => {
    const where = dirs();
    const result = await init(where, ["--global", "--project", "x"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: artifact init/);
    assert.ok(!existsSync(join(where.home, ".claude")));
  });

  it("prints the claude mcp add line, with the token header when ARTIFACT_TOKEN is set", async () => {
    const plain = await ok(init(dirs(), ["--dry-run"]));
    assert.ok(plain.out.includes(`${mcpAddCommand("http://localhost:4400", false)}\n`));
    const token = await ok(
      init(dirs(), ["--dry-run"], {
        ARTIFACT_TOKEN: "s3cret",
        ARTIFACT_SERVER: "http://127.0.0.1:9/",
      }),
    );
    assert.ok(token.out.includes(`${mcpAddCommand("http://127.0.0.1:9", true)}\n`), token.out);
    assert.ok(!token.out.includes("s3cret"));
  });
});
