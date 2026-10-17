// Guards the spec rule: src/core/ must not import from adapters/, http/, mcp/, node:fs or hono,
// so the core stays independent of storage and transport.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const src = join(root, "src");

const forbiddenDirs = ["adapters", "http", "mcp"];
const forbiddenModules = /^(node:)?fs(\/|$)|^hono(\/|$)|^@hono\//;

const specifierPattern =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(specifierPattern)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function violations(file: string, source: string): string[] {
  return specifiers(source).filter((spec) => {
    if (forbiddenModules.test(spec)) return true;
    if (!spec.startsWith(".")) return false;
    const [top] = relative(src, resolve(dirname(file), spec)).split(sep);
    return forbiddenDirs.includes(top);
  });
}

describe("core import boundary", () => {
  it("src/core/** imports nothing from adapters/, http/, mcp/, node:fs or hono", () => {
    const files = globSync("src/core/**/*.ts", { cwd: root }).map((f) => join(root, f));
    const found = files.flatMap((file) =>
      violations(file, readFileSync(file, "utf8")).map(
        (spec) => `${relative(root, file)}: ${spec}`,
      ),
    );
    assert.deepEqual(found, []);
  });

  it("detects forbidden imports", () => {
    const file = join(src, "core", "nested", "x.ts");
    const source = [
      'import { a } from "../../adapters/fs-store.ts";',
      'import type { B } from "../../http/app.ts";',
      'export * from "../../mcp/server.ts";',
      'import "node:fs";',
      'const p = import("fs/promises");',
      'import { Hono } from "hono";',
      'import { ok } from "../paths.ts";',
      'import { z } from "zod";',
    ].join("\n");
    assert.deepEqual(violations(file, source), [
      "../../adapters/fs-store.ts",
      "../../http/app.ts",
      "../../mcp/server.ts",
      "node:fs",
      "fs/promises",
      "hono",
    ]);
  });
});
