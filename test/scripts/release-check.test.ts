import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  atLeast,
  compareSemver,
  distTag,
  parseSemver,
  parseView,
  plan,
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
