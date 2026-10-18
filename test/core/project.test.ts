import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { MAX_PROJECT_CHARS, normalizeProject } from "../../src/core/project.ts";

const norm = (raw: string) => {
  const r = normalizeProject(raw);
  return r.ok ? r.value : undefined;
};

describe("normalizeProject: remote URLs", () => {
  it("normalises the spellings of one GitHub repo to the same value", () => {
    for (const raw of [
      "git@github.com:nikovirtala/artifact.git",
      "https://github.com/NikoVirtala/artifact",
      "https://github.com/NikoVirtala/artifact.git/",
      "ssh://git@github.com/nikovirtala/artifact.git",
      "http://github.com/nikovirtala/artifact",
      "git://github.com/nikovirtala/artifact.git",
      "https://user:pass@github.com/nikovirtala/artifact.git",
      "ssh://git@github.com:22/nikovirtala/artifact.git",
      "HTTPS://GitHub.com/nikovirtala/artifact",
      "github.com:nikovirtala/artifact",
      "github.com/nikovirtala/artifact",
      "  https://github.com/nikovirtala/artifact.git\n",
    ]) {
      assert.equal(norm(raw), "github.com/nikovirtala/artifact", JSON.stringify(raw));
    }
  });

  it("keeps nested groups and drops ports", () => {
    assert.equal(norm("ssh://git@gitlab.com/group/sub/proj.git"), "gitlab.com/group/sub/proj");
    assert.equal(norm("git@gitlab.com:group/sub/proj.git"), "gitlab.com/group/sub/proj");
    assert.equal(norm("https://git.example.com:8443/a/b"), "git.example.com/a/b");
    assert.equal(norm("ssh://git@[::1]:2222/repo.git"), "[::1]/repo");
    assert.equal(norm("[::1]/repo"), "[::1]/repo");
  });

  it("does not merge different repositories", () => {
    assert.notEqual(norm("git@github.com:a/b.git"), norm("git@github.com:a/bc.git"));
    assert.notEqual(norm("git@github.com:a/b.git"), norm("git@gitlab.com:a/b.git"));
    assert.notEqual(norm("git@github.com:a/b.git"), norm("git@github.com:a/b/c.git"));
  });
});

describe("normalizeProject: local paths", () => {
  it("keeps case, drops trailing slashes and keeps the root", () => {
    assert.equal(norm("local:/Users/Niko/Code/x/"), "local:/Users/Niko/Code/x");
    assert.equal(norm("local:/Users/Niko/Code/x"), "local:/Users/Niko/Code/x");
    assert.notEqual(norm("local:/a/X"), norm("local:/a/x"));
    assert.equal(norm("local:/"), "local:/");
    assert.equal(norm("local://"), "local:/");
  });

  it("accepts Windows drive paths with either separator", () => {
    assert.equal(norm("local:C:\\Users\\Niko\\x\\"), "local:C:/Users/Niko/x");
    assert.equal(norm("local:c:/Users/Niko/x"), "local:C:/Users/Niko/x");
    assert.equal(norm("local:C:\\"), "local:C:/");
  });
});

describe("normalizeProject: rejects", () => {
  it("empty, control characters, relative paths and unknown forms with invalid_input", () => {
    for (const raw of [
      "",
      "   ",
      "local:",
      "local:relative/path",
      "local:C:",
      "local:\\\\server\\share",
      "local:/a\u0000b",
      "https://github.com/a\nb",
      "/Users/niko/x",
      "C:\\Users\\x",
      "./x",
      "artifact",
      "https://github.com",
      "https://github.com/",
      "https://github.com/.git",
      "ftp://example.com/x",
      "file:///Users/niko/x",
      "user@github.com/a/b",
      "https://exa mple.com/x",
      "https://host:port/x",
    ]) {
      const r = normalizeProject(raw);
      assert.ok(!r.ok, JSON.stringify(raw));
      assert.equal(r.error.code, "invalid_input");
      assert.equal(r.error.field, "project");
    }
  });

  it("rejects values over 255 characters after normalisation", () => {
    assert.ok(norm(`local:/${"a".repeat(MAX_PROJECT_CHARS - 7)}`));
    const r = normalizeProject(`local:/${"a".repeat(MAX_PROJECT_CHARS - 6)}`);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "invalid_input");
    assert.deepEqual([r.error.field, r.error.limit], ["project", MAX_PROJECT_CHARS]);
    // Measured after normalisation: the scheme and .git do not count.
    assert.ok(norm(`https://h.io/${"a".repeat(MAX_PROJECT_CHARS - 5)}.git`));
  });
});

const label = fc.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,7}[a-z0-9])?$/);
const segment = fc
  .stringMatching(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,10}$/)
  .filter((s) => !/\.git$/i.test(s));
const host = fc.array(label, { minLength: 2, maxLength: 3 }).map((l) => l.join("."));
const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => s.join("/"));

describe("normalizeProject: properties", () => {
  it("is idempotent on anything it accepts", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.constantFrom("local:", "git@")), (raw) => {
        const once = norm(raw);
        if (once !== undefined) assert.equal(norm(once), once);
      }),
      { numRuns: 2000 },
    );
  });

  it("maps every remote spelling of a repo to one value", () => {
    fc.assert(
      fc.property(
        host,
        path,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 65535 }),
        (h, p, upper, dotGit, slash, port) => {
          const repo = `${upper ? p.toUpperCase() : p}${dotGit ? ".git" : ""}${slash ? "/" : ""}`;
          const expected = `${h}/${p.toLowerCase()}`;
          for (const raw of [
            `git@${h}:${repo}`,
            `https://${h}/${repo}`,
            `ssh://git@${h}:${port}/${repo}`,
            `git://${h}/${repo}`,
            `http://user:pw@${h}:${port}/${repo}`,
            expected,
          ]) {
            assert.equal(norm(raw), expected, raw);
          }
        },
      ),
    );
  });

  it("keeps local paths case-sensitive and slash-insensitive at the end", () => {
    fc.assert(
      fc.property(path, fc.nat({ max: 3 }), (p, slashes) => {
        assert.equal(norm(`local:/${p}${"/".repeat(slashes)}`), `local:/${p}`);
      }),
    );
  });
});
