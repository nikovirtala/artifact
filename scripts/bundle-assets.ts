// Bundle the Lambda handlers into dist/assets/<name>/index.mjs (docs/decisions/0068): ESM for
// Node 24, the runtime's @aws-sdk/* external, the package version inlined (/var/task has no
// package.json). The construct deploys these directories with Code.fromAsset, so consumers
// need no esbuild, Docker or repo checkout. Fails on any CDK or src/cdk input. The edge function
// is checked and copied as it is to dist/assets/edge/ (docs/decisions/0080).
//   node scripts/bundle-assets.ts      writes dist/assets/
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { PLACEHOLDER_LINE } from "../src/cdk/edge.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

export const ENTRIES = {
  control: "src/runtime/entries/control.ts",
  sweep: "src/runtime/entries/sweep.ts",
} as const;

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
/** The runtime-info JSON import (0076), with its attribute intact after minification. */
const JSON_IMPORT =
  /import\(\s*"@aws-sdk\/client-s3\/package\.json"\s*,\s*\{\s*with\s*:\s*\{\s*type\s*:\s*"json"\s*\}\s*\}\s*\)/;

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
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const outfile = join(options.outdir, name, "index.mjs");
    const result = await build({
      absWorkingDir: repo,
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: ["@aws-sdk/*"],
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
    const forbidden = inputs.filter((i) => FORBIDDEN_INPUT.test(i) || BUNDLED_SDK.test(i));
    if (forbidden.length > 0) {
      throw new Error(`bundle-assets: ${name} bundles ${forbidden.join(", ")}`);
    }
    if (!JSON_IMPORT.test(readFileSync(outfile, "utf8"))) {
      throw new Error(`bundle-assets: ${name} lost the JSON import attribute of the runtime line`);
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
    }
    console.log(`bundle-assets: dist/assets/${EDGE.out} (copied)`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
