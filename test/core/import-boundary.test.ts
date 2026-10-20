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

// Code change 8 of docs/01-plan-aws.md (docs/decisions/0050): the v1 code never depends on the
// AWS packages, and src/cdk/ references the built runtime assets, never src/runtime/ sources.
const awsModules = /^aws-cdk-lib(\/|$)|^@aws-sdk\//;
const awsSdk = /^@aws-sdk\//;
const tokenFile = join(src, "cli", "token.ts");
const v1Globs = [
  "src/core/**/*.ts",
  "src/http/**/*.ts",
  "src/mcp/**/*.ts",
  "src/cli/**/*.ts",
  "src/adapters/**/*.ts",
  "src/*.ts",
];

/** The top-level directory under src/ a relative specifier resolves to. */
function targetDir(file: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  return relative(src, resolve(dirname(file), spec)).split(sep)[0];
}

/** Forbidden specifiers of a v1 file or of a src/cdk/ file. */
function v2Violations(file: string, source: string): string[] {
  const [area] = relative(src, file).split(sep);
  return [...source.matchAll(specifierPattern)].flatMap((m) => {
    const spec = m[1] ?? m[2] ?? m[3];
    const target = targetDir(file, spec);
    if (area === "cdk") return target === "runtime" ? [spec] : [];
    if (target === "cdk" || target === "runtime") return [spec];
    // m[3] is the dynamic import() form: the only one allowed, and only in cli/token.ts.
    if (file === tokenFile && m[3] !== undefined && awsSdk.test(spec)) return [];
    return awsModules.test(spec) ? [spec] : [];
  });
}

function scan(patterns: string[]): string[] {
  const files = globSync(patterns, { cwd: root }).map((f) => join(root, f));
  return files.flatMap((file) =>
    v2Violations(file, readFileSync(file, "utf8")).map(
      (spec) => `${relative(root, file)}: ${spec}`,
    ),
  );
}

// docs/decisions/0059: the shipped package never depends on the dev-only aws/ workspace, and the
// Lambda sources in src/runtime/ never pull in the CDK.
const awsWorkspace = join(root, "aws");
const cdkModules = /^aws-cdk-lib(\/|$)|^constructs(\/|$)/;

/** Forbidden specifiers of any src/ file under the 0059 layout rules. */
function layoutViolations(file: string, source: string): string[] {
  const [area] = relative(src, file).split(sep);
  return specifiers(source).filter((spec) => {
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec);
      if (target === awsWorkspace || target.startsWith(awsWorkspace + sep)) return true;
      if (area === "runtime") return targetDir(file, spec) === "cdk";
      return false;
    }
    return area === "runtime" && cdkModules.test(spec);
  });
}

function scanLayout(patterns: string[]): string[] {
  const files = globSync(patterns, { cwd: root }).map((f) => join(root, f));
  return files.flatMap((file) =>
    layoutViolations(file, readFileSync(file, "utf8")).map(
      (spec) => `${relative(root, file)}: ${spec}`,
    ),
  );
}

describe("v2 import boundaries", () => {
  it("v1 code never imports src/cdk/, src/runtime/, aws-cdk-lib or @aws-sdk/*", () => {
    const files = globSync(v1Globs, { cwd: root });
    assert.ok(files.includes(join("src", "schemas.ts")));
    assert.ok(files.includes(join("src", "core", "artifact-service.ts")));
    assert.deepEqual(scan(v1Globs), []);
  });

  it("src/cdk/** never imports src/runtime/**", () => {
    assert.deepEqual(scan(["src/cdk/**/*.ts"]), []);
  });

  it("detects AWS and v2 package imports in v1 code", () => {
    const file = join(src, "http", "x.ts");
    const source = [
      'import { App } from "aws-cdk-lib";',
      'import { Bucket } from "aws-cdk-lib/aws-s3";',
      'import { S3Client } from "@aws-sdk/client-s3";',
      'import { stack } from "../cdk/x.ts";',
      'export * from "../runtime/x.ts";',
      'const s = import("@aws-sdk/client-ssm");',
      'import { z } from "zod";',
      'import { Hono } from "hono";',
      'import { ok } from "../core/x.ts";',
      'import { cdkish } from "aws-cdk-libx";',
    ].join("\n");
    assert.deepEqual(v2Violations(file, source), [
      "aws-cdk-lib",
      "aws-cdk-lib/aws-s3",
      "@aws-sdk/client-s3",
      "../cdk/x.ts",
      "../runtime/x.ts",
      "@aws-sdk/client-ssm",
    ]);
  });

  it("checks the top-level src/*.ts files too", () => {
    const file = join(src, "index.ts");
    const source = ['import "./cdk/app.ts";', 'import "./runtime/h.ts";', 'import "./config.ts";'];
    assert.deepEqual(v2Violations(file, source.join("\n")), ["./cdk/app.ts", "./runtime/h.ts"]);
  });

  it("allows only a dynamic @aws-sdk/* import, and only in src/cli/token.ts", () => {
    const source = [
      'const ssm = await import("@aws-sdk/client-ssm");',
      'import { STS } from "@aws-sdk/client-sts";',
      'const cdk = await import("aws-cdk-lib");',
    ].join("\n");
    assert.deepEqual(v2Violations(tokenFile, source), ["@aws-sdk/client-sts", "aws-cdk-lib"]);
    assert.deepEqual(v2Violations(join(src, "cli", "other.ts"), source), [
      "@aws-sdk/client-ssm",
      "@aws-sdk/client-sts",
      "aws-cdk-lib",
    ]);
  });

  it("src/cli/token.ts loads the Secrets Manager SDK only by dynamic import (0065)", () => {
    const source = readFileSync(tokenFile, "utf8");
    const forms = [...source.matchAll(specifierPattern)].filter((m) =>
      awsSdk.test(m[1] ?? m[2] ?? m[3]),
    );
    assert.deepEqual(
      forms.map((m) => [m[3] !== undefined, m[1] ?? m[2] ?? m[3]]),
      [[true, "@aws-sdk/client-secrets-manager"]],
    );
  });

  it("src/** never imports aws/; src/runtime/** never imports src/cdk/ or the CDK", () => {
    assert.deepEqual(scanLayout(["src/**/*.ts"]), []);
  });

  it("detects aws/ imports anywhere in src/ and CDK imports in src/runtime/", () => {
    const file = join(src, "runtime", "adapters", "x.ts");
    const source = [
      'import { stack } from "../../cdk/a.ts";',
      'import { App } from "aws-cdk-lib";',
      'import { Bucket } from "aws-cdk-lib/aws-s3";',
      'import { Construct } from "constructs";',
      'import "../../../aws/bin/x.ts";',
      'import { S3Client } from "@aws-sdk/client-s3";',
      'import { assertValidKey } from "../../adapters/keys.ts";',
      'import type { BlobStore } from "../../core/ports.ts";',
      'import { x } from "constructsx";',
    ].join("\n");
    assert.deepEqual(layoutViolations(file, source), [
      "../../cdk/a.ts",
      "aws-cdk-lib",
      "aws-cdk-lib/aws-s3",
      "constructs",
      "../../../aws/bin/x.ts",
    ]);
    const v1 = ['import "../../aws/lib/stack.ts";', 'import "../core/ports.ts";'].join("\n");
    assert.deepEqual(layoutViolations(join(src, "cli", "x.ts"), v1), ["../../aws/lib/stack.ts"]);
    const cdk = ['import { App } from "aws-cdk-lib";', 'import "../../aws/x.ts";'].join("\n");
    assert.deepEqual(layoutViolations(join(src, "cdk", "x.ts"), cdk), ["../../aws/x.ts"]);
  });

  it("src/cdk/ may use aws-cdk-lib but not import src/runtime/", () => {
    const file = join(src, "cdk", "a.ts");
    const source = [
      'import { App } from "aws-cdk-lib";',
      'import { handler } from "../runtime/h.ts";',
      'import { props } from "./props.ts";',
    ].join("\n");
    assert.deepEqual(v2Violations(file, source), ["../runtime/h.ts"]);
  });
});
