// One module owns the package version, so the Lambda bundles can inline it (docs/decisions/0068).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PACKAGE_VERSION } from "../../src/version.ts";

describe("PACKAGE_VERSION", () => {
  it("equals the version in package.json", () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    assert.equal(PACKAGE_VERSION, version);
  });
});
