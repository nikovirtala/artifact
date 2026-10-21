// Bundle the Lambda handlers into dist/assets/<name>/index.mjs (docs/decisions/0068): ESM for
// Node 24, the package version inlined (/var/task has no package.json). The runtime's @aws-sdk/*
// stays external, except in session-keys, which bundles only the KeyValueStore client and the
// SigV4A signer the runtime lacks (docs/decisions/0079). Each entry has its own checks, and files
// an entry reads at run time are copied next to it (the viewing reload client, 0082). The
// construct deploys these directories with Code.fromAsset, so consumers need no esbuild, Docker
// or repo checkout. The edge function is checked and copied as it is to dist/assets/edge/
// (docs/decisions/0080).
//   node scripts/bundle-assets.ts      writes dist/assets/
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { PLACEHOLDER_LINE } from "../src/cdk/edge.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

type EntrySpec = {
  source: string;
  /** Logs the runtime line (0076), so the JSON import attribute must survive. */
  runtimeLine: boolean;
  /** `external`: no @aws-sdk input at all; `kvs-only`: the session-keys allowlist below. */
  sdk: "external" | "kvs-only";
  /** Files copied byte for byte next to index.mjs. */
  copy: readonly string[];
};

export const ENTRIES = {
  control: {
    source: "src/runtime/entries/control.ts",
    runtimeLine: true,
    sdk: "external",
    copy: [],
  },
  sweep: { source: "src/runtime/entries/sweep.ts", runtimeLine: true, sdk: "external", copy: [] },
  viewing: {
    source: "src/runtime/entries/viewing.ts",
    runtimeLine: true,
    sdk: "external",
    copy: ["src/http/reload-client.js"],
  },
  "session-keys": {
    source: "src/runtime/entries/session-keys.ts",
    runtimeLine: false,
    sdk: "kvs-only",
    copy: [],
  },
} as const satisfies Record<string, EntrySpec>;

export type EntryName = keyof typeof ENTRIES;

/** The CloudFront Function (docs/decisions/0080): copied, not bundled; the construct inlines it. */
export const EDGE = {
  source: "src/runtime/edge/viewer-request.js",
  out: "edge/viewer-request.js",
} as const;
const EDGE_IMPORTS = ['import cf from "cloudfront";', 'import crypto from "crypto";'];

export type BundleReport = {
  entries: { name: string; outfile: string; inputs: string[] }[];
  /** The copied edge function. */
  edge: string;
};

const FORBIDDEN_INPUT = /(^|\/)src\/cdk\/|node_modules\/(aws-cdk-lib|constructs|esbuild)\//;
const BUNDLED_SDK = /node_modules\/@aws-sdk\//;
const SDK_PACKAGE = /node_modules\/@aws-sdk\/([^/]+)\//;
/** The @aws-sdk packages session-keys may bundle; a new one is reviewed before it is added. */
const KVS_ALLOWED =
  /^(client-cloudfront-keyvaluestore|signature-v4a|signature-v4-multi-region|core|types|nested-clients|token-providers|region-config-resolver|xml-builder|middleware-.+|util-.+|credential-provider-.+)$/;
const KVS_REQUIRED = ["client-cloudfront-keyvaluestore", "signature-v4a"];
const SECRETS_EXTERNAL = "@aws-sdk/client-secrets-manager";
const SECRETS_IMPORT = /from\s*"@aws-sdk\/client-secrets-manager"/;
const VIEWING_EXCLUDED =
  /node_modules\/(@modelcontextprotocol|zod|@hono\/node-server)\/|(^|\/)src\/mcp\/|(^|\/)src\/http\/(api|control-app)\.ts$/;
const MAX_VIEWING_BYTES = 200 * 1024;
/** The runtime-info JSON import (0076), with its attribute intact after minification. */
const JSON_IMPORT =
  /import\(\s*"@aws-sdk\/client-s3\/package\.json"\s*,\s*\{\s*with\s*:\s*\{\s*type\s*:\s*"json"\s*\}\s*\}\s*\)/;

/** What is wrong with entry `name`'s bundle, given its metafile inputs and output text. */
export function entryProblems(
  name: EntryName,
  inputs: readonly string[],
  output: string,
): string[] {
  const spec: EntrySpec = ENTRIES[name];
  const problems: string[] = [];
  const forbidden = inputs.filter(
    (i) => FORBIDDEN_INPUT.test(i) || (spec.sdk === "external" && BUNDLED_SDK.test(i)),
  );
  if (forbidden.length > 0) problems.push(`bundle-assets: ${name} bundles ${forbidden.join(", ")}`);
  if (spec.sdk === "kvs-only") {
    const packages = new Set(inputs.flatMap((i) => SDK_PACKAGE.exec(i)?.[1] ?? []));
    for (const pkg of [...packages].sort()) {
      if (!KVS_ALLOWED.test(pkg)) problems.push(`bundle-assets: ${name} bundles @aws-sdk/${pkg}`);
    }
    for (const pkg of KVS_REQUIRED) {
      if (!packages.has(pkg)) problems.push(`bundle-assets: ${name} lacks @aws-sdk/${pkg}`);
    }
    if (!SECRETS_IMPORT.test(output)) {
      problems.push(`bundle-assets: ${name} lacks the external "${SECRETS_EXTERNAL}" import`);
    }
  }
  if (spec.runtimeLine && !JSON_IMPORT.test(output)) {
    problems.push(`bundle-assets: ${name} lost the JSON import attribute of the runtime line`);
  }
  if (name === "viewing") {
    const excluded = inputs.filter((i) => VIEWING_EXCLUDED.test(i));
    if (excluded.length > 0) problems.push(`bundle-assets: ${name} bundles ${excluded.join(", ")}`);
    const bytes = Buffer.byteLength(output);
    if (bytes >= MAX_VIEWING_BYTES) {
      problems.push(`bundle-assets: ${name} is ${bytes} bytes; the limit is ${MAX_VIEWING_BYTES}`);
    }
  }
  return problems;
}

/** Replaces src/version.ts, which reads package.json at run time, with the version inlined. */
function versionPlugin(version: string): Plugin {
  const file = join(repo, "src", "version.ts");
  return {
    name: "artifact-version",
    setup(b) {
      b.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, (args) =>
        args.path === file
          ? { contents: `export const PACKAGE_VERSION = ${JSON.stringify(version)};`, loader: "ts" }
          : undefined,
      );
    },
  };
}

/**
 * Copies the edge function byte for byte after checking what cloudfront-js-2.0 and the construct
 * rely on: the two imports exactly (a formatter must not have rewritten "crypto"), an empty line 3
 * and the view-domain placeholder line exactly once.
 */
export function copyEdge(outdir: string, source = join(repo, EDGE.source)): string {
  const text = readFileSync(source, "utf8");
  const lines = text.split("\n");
  if (lines[0] !== EDGE_IMPORTS[0] || lines[1] !== EDGE_IMPORTS[1] || lines[2] !== "") {
    throw new Error("bundle-assets: edge lines 1-3 must be the cloudfront and crypto imports");
  }
  if (lines.filter((l) => l === PLACEHOLDER_LINE).length !== 1) {
    throw new Error("bundle-assets: edge needs the view-domain placeholder line exactly once");
  }
  const outfile = join(outdir, EDGE.out);
  mkdirSync(dirname(outfile), { recursive: true });
  copyFileSync(source, outfile);
  return outfile;
}

export async function bundleAssets(options: {
  outdir: string;
  version: string;
}): Promise<BundleReport> {
  const report: BundleReport = { entries: [], edge: "" };
  for (const [name, spec] of Object.entries(ENTRIES) as [EntryName, EntrySpec][]) {
    const outfile = join(options.outdir, name, "index.mjs");
    const result = await build({
      absWorkingDir: repo,
      entryPoints: [spec.source],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: spec.sdk === "external" ? ["@aws-sdk/*"] : [SECRETS_EXTERNAL],
      minifyWhitespace: true,
      minifySyntax: true,
      legalComments: "eof",
      metafile: true,
      logLevel: "warning",
      banner: {
        js: 'import { createRequire as __artifactCreateRequire } from "node:module"; const require = __artifactCreateRequire(import.meta.url);',
      },
      plugins: [versionPlugin(options.version)],
    });
    const inputs = Object.keys(result.metafile.inputs).sort();
    const [problem] = entryProblems(name, inputs, readFileSync(outfile, "utf8"));
    if (problem !== undefined) throw new Error(problem);
    for (const file of spec.copy) {
      copyFileSync(join(repo, file), join(options.outdir, name, basename(file)));
    }
    report.entries.push({ name, outfile, inputs });
  }
  report.edge = copyEdge(options.outdir);
  return report;
}

if (import.meta.main) {
  const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    version: string;
  };
  try {
    const report = await bundleAssets({ outdir: join(repo, "dist", "assets"), version });
    for (const { name, inputs } of report.entries) {
      console.log(`bundle-assets: dist/assets/${name}/index.mjs (${inputs.length} inputs)`);
      for (const file of (ENTRIES[name as EntryName] as EntrySpec).copy) {
        console.log(`bundle-assets: dist/assets/${name}/${basename(file)} (copied)`);
      }
    }
    console.log(`bundle-assets: dist/assets/${EDGE.out} (copied)`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
