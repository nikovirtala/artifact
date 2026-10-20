import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  atLeast,
  bumpVersion,
  commitBump,
  compareSemver,
  distTag,
  highestBump,
  latestReleaseTag,
  nextRelease,
  parseSemver,
  parseView,
  plan,
  readHistory,
  registryState,
} from "../../scripts/release-check.ts";

describe("atLeast", () => {
  it("compares X.Y.Z numerically", () => {
    assert.equal(atLeast("11.5.1", "11.5.1"), true);
    assert.equal(atLeast("11.19.1", "11.5.1"), true);
    assert.equal(atLeast("12.0.0", "11.5.1"), true);
    assert.equal(atLeast("11.5.0", "11.5.1"), false);
    assert.equal(atLeast("10.99.99", "11.5.1"), false);
    assert.equal(atLeast("11.5.1-pre.0", "11.5.1"), true);
    assert.equal(atLeast("garbage", "11.5.1"), false);
  });
});

describe("parseSemver", () => {
  it("parses core, prerelease and build", () => {
    assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
    assert.deepEqual(parseSemver("1.1.0-beta.1+sha.5"), {
      major: 1,
      minor: 1,
      patch: 0,
      prerelease: ["beta", "1"],
    });
  });
  it("rejects anything else", () => {
    for (const v of ["1.0", "v1.0.0", "1.0.0-", "01.0.0x", ""])
      assert.equal(parseSemver(v), undefined, v);
  });
});

describe("compareSemver", () => {
  it("orders by semver precedence", () => {
    const ordered = [
      "0.0.0",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        assert.equal(
          compareSemver(ordered[i], ordered[j]),
          Math.sign(i - j),
          `${ordered[i]} vs ${ordered[j]}`,
        );
      }
    }
  });
  it("ignores build metadata and throws on invalid versions", () => {
    assert.equal(compareSemver("1.0.0+a", "1.0.0+b"), 0);
    assert.throws(() => compareSemver("1.0", "1.0.0"), /not a semver version/);
  });
});

describe("distTag", () => {
  it("uses next for prereleases and latest otherwise", () => {
    assert.equal(distTag("1.0.0"), "latest");
    assert.equal(distTag("1.1.0-beta.1"), "next");
  });
});

describe("plan", () => {
  it("publishes a new version under latest", () => {
    assert.deepEqual(plan("1.0.0", { published: false, latest: "0.0.0" }), {
      publish: true,
      version: "1.0.0",
      tag: "latest",
    });
  });
  it("skips a version that is already on npm", () => {
    assert.deepEqual(plan("1.0.0", { published: true, latest: "1.0.0" }), {
      publish: false,
      version: "1.0.0",
      tag: "latest",
      reason: "version 1.0.0 already on npm",
    });
    assert.equal(plan("0.0.0", { published: true, latest: "1.0.0" }).publish, false);
  });
  it("publishes a prerelease under next", () => {
    assert.deepEqual(plan("1.1.0-beta.1", { published: false, latest: "1.0.0" }), {
      publish: true,
      version: "1.1.0-beta.1",
      tag: "next",
    });
  });
  it("fails for a version lower than latest", () => {
    assert.throws(
      () => plan("0.9.0", { published: false, latest: "1.0.0" }),
      /0\.9\.0 is lower than 1\.0\.0/,
    );
    assert.throws(() => plan("1.0.0-rc.1", { published: false, latest: "1.0.0" }), /lower/);
  });
  it("publishes when the package is not on npm at all", () => {
    assert.equal(plan("1.0.0", { published: false }).publish, true);
  });
  it("fails for a version that is not semver", () => {
    assert.throws(() => plan("1.0", { published: false }), /not semver/);
  });
});

const e404 = JSON.stringify({ error: { code: "E404", summary: "Not Found" } });

describe("parseView", () => {
  it("returns the parsed value on success", () => {
    assert.equal(parseView({ status: 0, stdout: '"0.0.0"\n' }), "0.0.0");
  });
  it("returns undefined for E404", () => {
    assert.equal(parseView({ status: 1, stdout: e404 }), undefined);
  });
  it("throws for any other error", () => {
    const stdout = JSON.stringify({ error: { code: "ECONNRESET", summary: "socket hang up" } });
    assert.throws(() => parseView({ status: 1, stdout }), /npm view failed: socket hang up/);
    assert.throws(() => parseView({ status: 1, stdout: "" }), /npm view failed: exit 1/);
    assert.throws(() => parseView({ status: 1, stdout: "oops" }), /not JSON/);
  });
});

describe("registryState", () => {
  const view = (responses: Record<string, string>) => (args: string[]) =>
    parseView(
      args[0] in responses
        ? { status: 0, stdout: responses[args[0]] }
        : { status: 1, stdout: e404 },
    );

  it("reports an unpublished version of an existing package", () => {
    assert.deepEqual(registryState("pkg", "1.0.0", view({ pkg: '"0.0.0"' })), {
      published: false,
      latest: "0.0.0",
    });
  });
  it("reports a published version", () => {
    assert.deepEqual(
      registryState("pkg", "0.0.0", view({ "pkg@0.0.0": '"0.0.0"', pkg: '"0.0.0"' })),
      {
        published: true,
        latest: "0.0.0",
      },
    );
  });
  it("treats a package that is not on npm as not published", () => {
    const state = registryState("pkg", "1.0.0", view({}));
    assert.deepEqual(state, { published: false, latest: undefined });
    assert.equal(plan("1.0.0", state).publish, true);
  });
});

describe("commitBump", () => {
  it("releases feat as minor and fix or perf as patch", () => {
    assert.equal(commitBump("feat: add x"), "minor");
    assert.equal(commitBump("feat(cli): add x\n\nWhy."), "minor");
    assert.equal(commitBump("Feat: add x"), "minor");
    assert.equal(commitBump("fix(http): y"), "patch");
    assert.equal(commitBump("perf: z"), "patch");
  });
  it("releases breaking changes as major", () => {
    assert.equal(commitBump("feat!: drop x"), "major");
    assert.equal(commitBump("fix(cli)!: drop y"), "major");
    assert.equal(commitBump("chore!: drop node 22"), "major");
    assert.equal(commitBump("feat: x\n\nWhy.\n\nBREAKING CHANGE: x is gone"), "major");
    assert.equal(commitBump("fix: x\n\nBREAKING-CHANGE: x is gone"), "major");
  });
  it("needs an uppercase BREAKING CHANGE footer", () => {
    assert.equal(commitBump("fix: x\n\nbreaking change: x is gone"), "patch");
    assert.equal(commitBump("fix: mention BREAKING CHANGE: in the header"), "patch");
    assert.equal(commitBump("docs: x\n\nsee BREAKING CHANGE: inline"), undefined);
  });
  it("does not release anything else", () => {
    for (const message of [
      "chore: x",
      "docs: x",
      "ci: x",
      "refactor(core): x",
      "test: x",
      "revert: feat: x\n\nThis reverts commit abc.",
      "Merge branch 'main'",
      "garbage",
      "feat:missing space",
      "",
    ]) {
      assert.equal(commitBump(message), undefined, message);
    }
  });
});

describe("highestBump", () => {
  it("returns the largest bump", () => {
    assert.equal(highestBump(["docs: a", "fix: b", "feat: c", "fix: d"]), "minor");
    assert.equal(highestBump(["fix: b", "feat!: c", "feat: d"]), "major");
    assert.equal(highestBump(["chore: a", "perf: b"]), "patch");
  });
  it("returns undefined without releasing commits", () => {
    assert.equal(highestBump([]), undefined);
    assert.equal(highestBump(["docs: a", "ci: b"]), undefined);
  });
});

describe("bumpVersion", () => {
  it("bumps and resets the lower parts", () => {
    assert.equal(bumpVersion("1.0.0", "major"), "2.0.0");
    assert.equal(bumpVersion("1.0.0", "minor"), "1.1.0");
    assert.equal(bumpVersion("1.0.0", "patch"), "1.0.1");
    assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  });
  it("throws for prereleases and non-semver", () => {
    assert.throws(() => bumpVersion("1.1.0-beta.1", "patch"), /not a stable/);
    assert.throws(() => bumpVersion("1.0", "patch"), /not a stable/);
  });
});

describe("latestReleaseTag", () => {
  it("picks the highest stable vX.Y.Z tag", () => {
    assert.equal(latestReleaseTag(["v1.9.0", "v1.10.0", "v1.2.0"]), "v1.10.0");
    assert.equal(latestReleaseTag(["v1.0.0", "v1.1.0-beta.1", "vfoo", "1.2.0"]), "v1.0.0");
  });
  it("returns undefined without a release tag", () => {
    assert.equal(latestReleaseTag([]), undefined);
    assert.equal(latestReleaseTag(["v2.0.0-rc.1", "1.0.0"]), undefined);
  });
});

describe("nextRelease", () => {
  it("fails without a release tag", () => {
    assert.throws(() => nextRelease({ tag: undefined, messages: [] }), /no release tag/);
  });
  it("reports when nothing releases", () => {
    assert.deepEqual(nextRelease({ tag: "v1.0.0", messages: ["docs: a", "ci: b"] }), {
      base: "1.0.0",
      reason: "no feat, fix, perf or breaking commits since v1.0.0",
    });
    assert.deepEqual(nextRelease({ tag: "v1.0.0", messages: [] }), {
      base: "1.0.0",
      reason: "no feat, fix, perf or breaking commits since v1.0.0",
    });
  });
  it("bumps the tag version", () => {
    assert.deepEqual(nextRelease({ tag: "v1.0.0", messages: ["fix: a", "feat(cli): b"] }), {
      base: "1.0.0",
      bump: "minor",
      version: "1.1.0",
    });
  });
});

describe("readHistory", () => {
  const fakeGit = (responses: { shallow?: string; tags?: string; log?: string }) => {
    const calls: string[][] = [];
    const git = (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return responses.shallow ?? "false\n";
      if (args[0] === "tag") return responses.tags ?? "";
      if (args[0] === "log") return responses.log ?? "";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    return { calls, git };
  };

  it("fails in a shallow clone", () => {
    const { git } = fakeGit({ shallow: "true\n" });
    assert.throws(() => readHistory(git), /shallow/);
  });
  it("reads the messages since the highest release tag", () => {
    const { calls, git } = fakeGit({
      tags: "v1.0.0\nv1.10.0\nv1.9.0\nv2.0.0-rc.1\n",
      log: "feat: a\n\nWhy.\n\0\nfix: b\n\0\n",
    });
    assert.deepEqual(readHistory(git), { tag: "v1.10.0", messages: ["feat: a\n\nWhy.", "fix: b"] });
    assert.deepEqual(calls, [
      ["rev-parse", "--is-shallow-repository"],
      ["tag", "--merged", "HEAD", "--list", "v*"],
      ["log", "--format=%B%x00", "v1.10.0..HEAD"],
    ]);
  });
  it("returns no tag when none is reachable", () => {
    const { calls, git } = fakeGit({ tags: "\n" });
    assert.deepEqual(readHistory(git), { tag: undefined, messages: [] });
    assert.equal(calls.length, 2);
    assert.throws(() => nextRelease(readHistory(git)), /no release tag/);
  });
});
