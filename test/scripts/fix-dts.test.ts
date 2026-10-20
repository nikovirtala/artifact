// scripts/fix-dts.ts (docs/decisions/0073): TypeScript keeps `.ts` in declaration specifiers, so
// the build rewrites relative ones to `.js` and fails if any `.ts` specifier is left.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fixDeclarations } from "../../scripts/fix-dts.ts";

const script = fileURLToPath(new URL("../../scripts/fix-dts.ts", import.meta.url));

function withDir(files: Record<string, string>, fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "artifact-fix-dts-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("fixDeclarations", () => {
  it("rewrites relative .ts specifiers to .js and leaves the rest", () =>
    withDir(
      {
        "index.d.ts": [
          'import { A } from "./a.ts";',
          'import type { C } from "../b/c.ts";',
          'export type D = import("./d.ts").D;',
          'export * from "./e.ts";',
          'import { App } from "aws-cdk-lib";',
          'export { F } from "./f.js";',
        ].join("\n"),
        "nested/x.d.ts": 'export { Y } from "./y.ts";\n',
        "nested/y.js": 'import "./z.ts";\n',
      },
      async (dir) => {
        assert.deepEqual(await fixDeclarations(dir), { files: 2, rewritten: 5 });
        assert.equal(
          readFileSync(join(dir, "index.d.ts"), "utf8"),
          [
            'import { A } from "./a.js";',
            'import type { C } from "../b/c.js";',
            'export type D = import("./d.js").D;',
            'export * from "./e.js";',
            'import { App } from "aws-cdk-lib";',
            'export { F } from "./f.js";',
          ].join("\n"),
        );
        assert.equal(
          readFileSync(join(dir, "nested/x.d.ts"), "utf8"),
          'export { Y } from "./y.js";\n',
        );
        assert.equal(readFileSync(join(dir, "nested/y.js"), "utf8"), 'import "./z.ts";\n');
      },
    ));

  it("fails naming the file when a .ts specifier remains", () =>
    withDir({ "bad.d.ts": 'import { X } from "pkg/x.ts";\n' }, async (dir) => {
      await assert.rejects(fixDeclarations(dir), /bad\.d\.ts/);
      const run = () =>
        execFileSync(process.execPath, [script, dir], { encoding: "utf8", stdio: "pipe" });
      assert.throws(run, (error: { status: number; stderr: string }) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /bad\.d\.ts/);
        return true;
      });
    }));
});
