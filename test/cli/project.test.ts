import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { UsageError } from "../../src/cli/output.ts";
import { deriveProject, type Exec, resolveProject } from "../../src/cli/project.ts";

/** A fake `git`: each subcommand answers with its output, or fails when absent. */
function fakeGit(answers: { remote?: string; toplevel?: string }): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    const answer = args[0] === "remote" ? answers.remote : answers.toplevel;
    if (answer === undefined) throw new Error("exit 128");
    return `${answer}\n`;
  };
  return Object.assign(exec, { calls });
}

const missingGit: Exec = async () => {
  throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
};

describe("deriveProject", () => {
  it("uses the normalised origin remote first", async () => {
    const git = fakeGit({ remote: "git@github.com:Acme/Demo.git", toplevel: "/w/demo" });
    assert.equal(await deriveProject("/w/demo/sub", git), "github.com/acme/demo");
    assert.deepEqual(git.calls, [["git", "remote", "get-url", "origin"]]);
  });

  it("falls through to the toplevel when there is no remote", async () => {
    const git = fakeGit({ toplevel: "/w/demo" });
    assert.equal(await deriveProject("/w/demo/sub", git), "local:/w/demo");
  });

  it("falls through when the remote is a filesystem path", async () => {
    const git = fakeGit({ remote: "/projects/sandbox/artifact", toplevel: "/w/clone" });
    assert.equal(await deriveProject("/w/clone", git), "local:/w/clone");
  });

  it("uses local: + cwd outside a repository or without git", async () => {
    assert.equal(await deriveProject("/tmp/x/", fakeGit({})), "local:/tmp/x");
    assert.equal(await deriveProject("/tmp/x", missingGit), "local:/tmp/x");
  });

  describe("with real git", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "artifact-project-")));
    // The user's git config (e.g. url.<base>.insteadOf) would rewrite the remote URL.
    const saved = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_NOSYSTEM,
    };
    before(() => {
      process.env.GIT_CONFIG_GLOBAL = devNull;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
    });
    after(() => {
      for (const [name, value] of [
        ["GIT_CONFIG_GLOBAL", saved.global],
        ["GIT_CONFIG_NOSYSTEM", saved.system],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    });

    it("derives github.com/acme/demo from an https origin", async () => {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
      assert.equal(await deriveProject(dir), `local:${dir}`);
      execFileSync("git", ["remote", "add", "origin", "https://github.com/Acme/Demo.git"], {
        cwd: dir,
      });
      assert.equal(await deriveProject(dir), "github.com/acme/demo");
    });
  });
});

describe("resolveProject", () => {
  const git = fakeGit({ remote: "https://github.com/a/b" });

  it("passes --project as given, none with --no-project, else derives", async () => {
    assert.equal(await resolveProject({ project: "Git@X.com:A/B" }, "/w", git), "Git@X.com:A/B");
    assert.equal(await resolveProject({ "no-project": true }, "/w", git), undefined);
    assert.equal(await resolveProject({}, "/w", git), "github.com/a/b");
  });

  it("rejects an empty --project and --project with --no-project", async () => {
    await assert.rejects(resolveProject({ project: "" }, "/w", git), (error) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /--no-project/);
      return true;
    });
    await assert.rejects(
      resolveProject({ project: "x", "no-project": true }, "/w", git),
      UsageError,
    );
  });
});
