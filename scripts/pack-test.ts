// Pack the package, install the tarball into a temp app and run the e2e suite against the
// installed bin (docs/decisions/0048). Not part of `pnpm check`: it builds and needs the registry.
// Then CDK apps outside the repo synthesize the construct from the tarball, with no AWS access
// (docs/decisions/0074). KEEP_PACK_TEST=1 keeps the temp directory for inspection.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderEdgeFunction } from "../src/cdk/edge.ts";
import { tarballAppFiles } from "./lib/tarball-app.ts";
import { TS_SPECIFIER } from "./lib/ts-specifier.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const run = (command: string, args: string[], cwd: string): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const tmp = mkdtempSync(join(tmpdir(), "artifact-pack-test-"));

const CDK_LIB = "aws-cdk-lib@2.273.0";
const CONSTRUCTS = "constructs@10.8.1";
const CDK_CLI = "aws-cdk@2.1145.0";

/** The environment without AWS credentials or configuration: synth must never reach AWS. */
function offlineEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AWS_")),
  );
  const none = join(tmp, "no-aws-config");
  return {
    ...env,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: none,
    AWS_SHARED_CREDENTIALS_FILE: none,
    CDK_DISABLE_CLI_TELEMETRY: "true",
    ...extra,
  };
}

const npm = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
  execFileSync("npm", [...args, "--no-audit", "--no-fund"], { cwd, stdio: "inherit", env });

const nonEmptyLines = (text: string) => text.split("\n").filter((l) => l.trim() !== "").length;

type CfnResource = { Type: string; Properties: Record<string, unknown> };

/** The four prebuilt bundles (docs/decisions/0068, 0079, 0082). */
const BUNDLES = ["control", "sweep", "viewing", "session-keys"];

/**
 * Exactly four `index.handler` functions (control, sweep, viewing, session-keys) on
 * nodejs24.x/arm64 whose code is a cdk.out asset directory holding index.mjs (other functions,
 * CDK's auto-delete and cross-Region providers, are ignored). Returns the asset directories.
 */
function assetFunctions(outdir: string, stack: string): string[] {
  const template = JSON.parse(readFileSync(join(outdir, `${stack}.template.json`), "utf8")) as {
    Resources: Record<string, CfnResource>;
  };
  const dirs: string[] = [];
  for (const f of Object.values(template.Resources)) {
    if (f.Type !== "AWS::Lambda::Function" || f.Properties.Handler !== "index.handler") continue;
    const { Runtime, Architectures, Code } = f.Properties as {
      Runtime: string;
      Architectures?: string[];
      Code: { S3Key?: string };
    };
    const hash = /^([0-9a-f]{64})\.zip$/.exec(Code.S3Key ?? "")?.[1];
    const dir = join(outdir, `asset.${hash}`);
    if (hash === undefined || !existsSync(join(dir, "index.mjs"))) continue;
    if (Runtime !== "nodejs24.x" || Architectures?.join() !== "arm64") {
      throw new Error(`pack-test: ${stack} has a ${Runtime}/${Architectures} function`);
    }
    dirs.push(dir);
  }
  if (dirs.length !== BUNDLES.length) {
    throw new Error(`pack-test: ${stack} has ${dirs.length} asset functions`);
  }
  return dirs;
}

const appSource = (body: string[]) =>
  [
    "const app = new App();",
    'const stack = new Stack(app, "TarballApp", { env: { account: "123456789012", region: "eu-north-1" } });',
    'const hostedZone = HostedZone.fromHostedZoneAttributes(stack, "Zone", { hostedZoneId: "Z0000000000000000000", zoneName: "example.dev" });',
    'const certificate = Certificate.fromCertificateArn(stack, "Cert", "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000");',
    'new ArtifactHosting(stack, "Artifacts", {',
    '  viewDomain: { name: "tarball.example.dev", hostedZone, certificate },',
    '  apiDomain: { name: "api.tarball.example.dev" },',
    '  identity: ArtifactIdentity.cognito({ owners: ["owner@example.com"] }),',
    "  dataRetention: { onDestroy: RemovalPolicy.DESTROY, versions: { keepLast: 2 } },",
    "});",
    ...body,
  ].join("\n");

/** (b) A plain ESM CDK app outside the repo: the tarball, the CDK and nothing to build with. */
function cdkApp(tarball: string): void {
  const dir = join(tmp, "cdk-app");
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), '{"name":"cdk-app","private":true,"type":"module"}\n');
  npm(["install", tarball, CDK_LIB, CONSTRUCTS], dir);
  if (existsSync(join(dir, "node_modules", "esbuild"))) {
    throw new Error("pack-test: the CDK app installed esbuild");
  }
  const source = [
    'import { App, RemovalPolicy, Stack } from "aws-cdk-lib";',
    'import { Certificate } from "aws-cdk-lib/aws-certificatemanager";',
    'import { HostedZone } from "aws-cdk-lib/aws-route53";',
    'import { ArtifactHosting, ArtifactIdentity } from "@nikovirtala/artifact/cdk";',
    appSource(["app.synth();", ""]),
  ].join("\n");
  if (nonEmptyLines(source) >= 20) throw new Error("pack-test: app.mjs has 20 lines or more");
  writeFileSync(join(dir, "app.mjs"), source);
  execFileSync(process.execPath, ["app.mjs"], {
    cwd: dir,
    stdio: "inherit",
    env: offlineEnv({ CDK_OUTDIR: "cdk.out" }),
  });
  assetFunctions(join(dir, "cdk.out"), "TarballApp");
  console.log("pack-test: (b) an ESM CDK app synthesizes four prebuilt functions, no esbuild");
}

/** (b2) TypeScript 5.9.3 consumers (node10 and nodenext, no skipLibCheck) and plain require. */
function typescriptConsumers(dir: string): void {
  npm(["install", "typescript@5.9.3"], dir);
  const imports = [
    'import { App, RemovalPolicy, Stack } from "aws-cdk-lib";',
    'import { Certificate } from "aws-cdk-lib/aws-certificatemanager";',
    'import { HostedZone } from "aws-cdk-lib/aws-route53";',
    'import { ArtifactHosting, ArtifactIdentity } from "@nikovirtala/artifact/cdk";',
  ];
  writeFileSync(join(dir, "app.ts"), [...imports, appSource([""])].join("\n"));
  const configs = {
    "tsconfig.node10.json":
      '{"compilerOptions":{"module":"commonjs","moduleResolution":"node10","target":"esnext","strict":true,"noEmit":true},"files":["app.ts"]}',
    "tsconfig.nodenext.json":
      '{"compilerOptions":{"module":"nodenext","strict":true,"noEmit":true},"files":["app.ts"]}',
  };
  for (const [name, config] of Object.entries(configs)) {
    writeFileSync(join(dir, name), `${config}\n`);
    execFileSync(join(dir, "node_modules", ".bin", "tsc"), ["-p", name], {
      cwd: dir,
      stdio: "inherit",
    });
  }
  const required = [
    'const { App, RemovalPolicy, Stack } = require("aws-cdk-lib");',
    'const { Certificate } = require("aws-cdk-lib/aws-certificatemanager");',
    'const { HostedZone } = require("aws-cdk-lib/aws-route53");',
    'const { ArtifactHosting, ArtifactIdentity } = require("@nikovirtala/artifact/cdk");',
    appSource(["app.synth();", ""]),
  ].join("\n");
  writeFileSync(join(dir, "app.cjs"), required);
  execFileSync(process.execPath, ["app.cjs"], {
    cwd: dir,
    stdio: "inherit",
    env: offlineEnv({ CDK_OUTDIR: "cdk.out.cjs" }),
  });
  assetFunctions(join(dir, "cdk.out.cjs"), "TarballApp");
  console.log(
    "pack-test: (b2) TypeScript 5.9.3 node10 + nodenext type-check; require() synthesizes",
  );
}

type NpmTree = { dependencies?: Record<string, NpmTree> };

/** Every dependency path (names from the root) that ends in `name`. */
function pathsTo(tree: NpmTree, name: string, trail: string[] = []): string[][] {
  return Object.entries(tree.dependencies ?? {}).flatMap(([dep, sub]) => [
    ...(dep === name ? [[...trail, dep]] : []),
    ...pathsTo(sub, name, [...trail, dep]),
  ]);
}

/** (b3) The real `cdk init` app (TypeScript 7, NodeNext, CommonJS via tsx) from the tarball. */
function initApp(tarball: string, dist: string): void {
  const dir = join(tmp, "init-app");
  mkdirSync(dir);
  execFileSync(
    "npx",
    ["--yes", CDK_CLI, "init", "app", "--language", "typescript", "--generate-only"],
    { cwd: dir, stdio: "inherit", env: offlineEnv() },
  );
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { type?: string };
  const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")) as {
    compilerOptions: { module: string; moduleResolution: string; noEmit: boolean };
  };
  const cdkJson = JSON.parse(readFileSync(join(dir, "cdk.json"), "utf8")) as { app: string };
  const { module, moduleResolution, noEmit } = tsconfig.compilerOptions;
  if (
    pkg.type !== undefined ||
    module !== "NodeNext" ||
    moduleResolution !== "NodeNext" ||
    noEmit !== true ||
    cdkJson.app !== "npx tsc && npx tsx bin/init-app.ts"
  ) {
    throw new Error(
      `pack-test: the cdk init template changed: type ${pkg.type}, ${module}/${moduleResolution}, noEmit ${noEmit}, app ${cdkJson.app}`,
    );
  }
  // One install of the template's dependencies with the tarball and the pinned CDK: a second
  // install that downgrades the template's aws-cdk-lib range leaves npm's tree broken (0074).
  npm(["install", tarball, CDK_LIB, CONSTRUCTS], dir);
  const files = tarballAppFiles("init-app");
  writeFileSync(join(dir, files.bin.path), files.bin.text);
  writeFileSync(join(dir, files.stack.path), files.stack.text);
  execFileSync("npx", ["tsc"], { cwd: dir, stdio: "inherit" });
  execFileSync(
    "npx",
    [
      "cdk",
      "synth",
      "-c",
      "zoneId=Z0000000000000000000",
      "-c",
      "zoneName=example.dev",
      "--quiet",
      "--no-notices",
    ],
    { cwd: dir, stdio: "inherit", env: offlineEnv({ ARTIFACT_OWNERS: "owner@example.com" }) },
  );
  const outdir = join(dir, "cdk.out");
  if (!existsSync(join(outdir, `${files.stackId}.template.json`))) {
    throw new Error(`pack-test: cdk init synth wrote no ${files.stackId}.template.json`);
  }
  const functionDirs = assetFunctions(outdir, files.stackId);

  // The recommended feature flags of the template change nothing in the bucket policy.
  const template = JSON.parse(
    readFileSync(join(outdir, `${files.stackId}.template.json`), "utf8"),
  ) as { Resources: Record<string, CfnResource> };
  const policies = Object.values(template.Resources).filter(
    (r) => r.Type === "AWS::S3::BucketPolicy",
  );
  const statements = policies.flatMap(
    (p) =>
      (
        p.Properties.PolicyDocument as {
          Statement: { Effect: string; Principal: unknown; Condition?: unknown }[];
        }
      ).Statement,
  );
  const allows = statements.filter((s) => s.Effect === "Allow");
  const denies = statements
    .filter((s) => s.Effect === "Deny")
    .map((s) => JSON.stringify(s.Condition));
  if (
    allows.length !== 1 ||
    !JSON.stringify(allows[0].Principal).includes(
      "CustomS3AutoDeleteObjectsCustomResourceProviderRole",
    ) ||
    denies.sort().join() !==
      [
        JSON.stringify({ Bool: { "aws:SecureTransport": "false" } }),
        JSON.stringify({ NumericLessThan: { "s3:TlsVersion": 1.2 } }),
      ]
        .sort()
        .join()
  ) {
    throw new Error(`pack-test: unexpected bucket policy ${JSON.stringify(statements)}`);
  }

  // Every deployed handler is byte-identical to a bundle in the tarball, one per bundle.
  const bundles = BUNDLES.map((name) => readFileSync(join(dist, "assets", name, "index.mjs")));
  const assets = readdirSync(outdir)
    .filter((name) => name.startsWith("asset.") && existsSync(join(outdir, name, "index.mjs")))
    .map((name) => readFileSync(join(outdir, name, "index.mjs")));
  if (
    assets.length !== BUNDLES.length ||
    !assets.every((a) => bundles.some((b) => b.equals(a))) ||
    !bundles.every((b) => assets.some((a) => a.equals(b)))
  ) {
    throw new Error("pack-test: the synthesized assets differ from the tarball's bundles");
  }
  // The viewing asset ships reload-client.js next to index.mjs, which reload.ts reads at init.
  const viewingBundle = readFileSync(join(dist, "assets", "viewing", "index.mjs"));
  const viewingDir = functionDirs.find((dir) =>
    readFileSync(join(dir, "index.mjs")).equals(viewingBundle),
  );
  const viewingFiles = viewingDir === undefined ? [] : readdirSync(viewingDir).sort();
  if (
    viewingDir === undefined ||
    viewingFiles.join() !== "index.mjs,reload-client.js" ||
    !readFileSync(join(viewingDir, "reload-client.js")).equals(
      readFileSync(join(dist, "assets", "viewing", "reload-client.js")),
    )
  ) {
    throw new Error(`pack-test: the viewing asset holds ${viewingFiles.join(", ")}`);
  }
  // The edge function is the tarball's file with the view domain substituted (0080).
  const edge = Object.values(template.Resources).filter(
    (r) => r.Type === "AWS::CloudFront::Function",
  );
  const expectedEdge = renderEdgeFunction(
    readFileSync(join(dist, "assets", "edge", "viewer-request.js"), "utf8"),
    "tarball.example.dev",
  );
  if (edge.length !== 1 || edge[0].Properties.FunctionCode !== expectedEdge) {
    throw new Error("pack-test: the edge FunctionCode differs from the tarball's edge file");
  }

  // CloudFormation Validate ran on the synth and found nothing, warnings included (A20).
  const report = JSON.parse(readFileSync(join(outdir, "validation-report.json"), "utf8")) as {
    pluginReports?: unknown[];
  };
  if (JSON.stringify(report.pluginReports) !== "[]") {
    throw new Error(`pack-test: validation report ${JSON.stringify(report.pluginReports)}`);
  }

  // esbuild comes only with tsx, the template's TypeScript runner, never with the construct.
  const tree = JSON.parse(
    spawnSync("npm", ["ls", "esbuild", "--all", "--json"], { cwd: dir, encoding: "utf8" }).stdout,
  ) as NpmTree;
  const paths = pathsTo(tree, "esbuild");
  const bad = paths.filter((p) => !p.includes("tsx") || p.includes("@nikovirtala/artifact"));
  if (paths.length === 0 || bad.length > 0) {
    throw new Error(`pack-test: esbuild paths ${JSON.stringify(paths)}`);
  }
  console.log(
    "pack-test: (b3) the cdk init app type-checks and synthesizes from the tarball; four assets and the edge code match, validation clean, esbuild only under tsx",
  );
}
let status = 1;
try {
  execFileSync("pnpm", ["build"], { cwd: repo, stdio: "inherit" });
  run("pnpm", ["pack", "--pack-destination", tmp], repo);
  const tgz = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
  if (!tgz) throw new Error(`pack-test: no tarball in ${tmp}`);
  const tarball = join(tmp, tgz);

  const entries = run("tar", ["-tzf", tarball], tmp).split("\n").filter(Boolean).sort();
  console.log(`pack-test: ${tgz} contains ${entries.length} files:`);
  for (const entry of entries) console.log(`  ${entry}`);
  const required = [
    "package/dist/cli/main.js",
    "package/dist/http/reload-client.js",
    "package/dist/cdk/index.js",
    "package/dist/cdk/index.d.ts",
    "package/dist/assets/control/index.mjs",
    "package/dist/assets/sweep/index.mjs",
    "package/dist/assets/viewing/index.mjs",
    "package/dist/assets/viewing/reload-client.js",
    "package/dist/assets/session-keys/index.mjs",
    "package/dist/assets/edge/viewer-request.js",
    "package/README.md",
    "package/LICENSE",
    "package/package.json",
  ];
  const missing = required.filter((path) => !entries.includes(path));
  const forbidden = entries.filter(
    (e) =>
      e.startsWith("package/src/") ||
      e.startsWith("package/test/") ||
      e.startsWith("package/dist/runtime/") ||
      (e.endsWith(".d.ts") && !e.startsWith("package/dist/cdk/")),
  );
  if (missing.length > 0) throw new Error(`pack-test: tarball lacks ${missing.join(", ")}`);
  if (forbidden.length > 0) throw new Error(`pack-test: tarball ships ${forbidden.join(", ")}`);

  // The AWS code stays out of the runtime dependencies: the v1 four only (0059). The construct's
  // packages and the token command's SDK are optional peers (0073; M8 asserted no peers).
  const packed = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"], tmp)) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const dependencies = Object.keys(packed.dependencies ?? {}).sort();
  const v1Dependencies = ["@hono/node-server", "@modelcontextprotocol/sdk", "hono", "zod"];
  if (dependencies.join() !== v1Dependencies.join()) {
    throw new Error(`pack-test: dependencies are ${dependencies.join(", ")}`);
  }
  const peers = Object.keys(packed.peerDependencies ?? {}).sort();
  const optionalPeers = ["@aws-sdk/client-secrets-manager", "aws-cdk-lib", "constructs"];
  if (peers.join() !== optionalPeers.join()) {
    throw new Error(`pack-test: peerDependencies are ${peers.join(", ")}`);
  }
  const requiredPeers = peers.filter(
    (name) => packed.peerDependenciesMeta?.[name]?.optional !== true,
  );
  if (requiredPeers.length > 0) {
    throw new Error(`pack-test: peers not optional: ${requiredPeers.join(", ")}`);
  }

  const app = join(tmp, "app");
  mkdirSync(app);
  run("npm", ["init", "-y"], app);
  execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund"], {
    cwd: app,
    stdio: "inherit",
  });

  const awsPackages = ["@aws-sdk", "aws-cdk-lib", "constructs"].filter((name) =>
    existsSync(join(app, "node_modules", name)),
  );
  if (awsPackages.length > 0) {
    throw new Error(`pack-test: installing the tarball pulls in ${awsPackages.join(", ")}`);
  }
  console.log("pack-test: v1 dependencies only; no dist/runtime, @aws-sdk or aws-cdk-lib");

  // (a) Without the optional peer, `artifact token` names the install command (0065).
  const token = spawnSync(
    join(app, "node_modules", ".bin", "artifact"),
    ["token", "list", "--secret", "arn:aws:secretsmanager:eu-north-1:000000000000:secret:x-AbCdEf"],
    { cwd: app, encoding: "utf8" },
  );
  if (token.status !== 1 || !token.stderr.includes("npm install @aws-sdk/client-secrets-manager")) {
    throw new Error(`pack-test: artifact token without the SDK: ${token.status} ${token.stderr}`);
  }
  console.log("pack-test: artifact token without the SDK peer names the install command");

  const dist = join(app, "node_modules", "@nikovirtala", "artifact", "dist");
  // Every file, not only .js: anything shipped that names a .ts module is a leftover.
  const offenders = readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => TS_SPECIFIER.test(readFileSync(file, "utf8")))
    .map((file) => relative(dist, file));
  if (offenders.length > 0) {
    throw new Error(`pack-test: .ts imports in installed dist: ${offenders.join(", ")}`);
  }
  console.log("pack-test: no file in installed dist imports .ts; .d.ts only under dist/cdk");

  const bin = join(app, "node_modules", ".bin", "artifact");
  console.log(`pack-test: running the e2e suite with ARTIFACT_CLI=${bin}`);
  const tests = spawnSync(
    process.execPath,
    ["--test", "test/e2e/**/*.test.ts", "test/cli/main.test.ts"],
    { cwd: repo, stdio: "inherit", env: { ...process.env, ARTIFACT_CLI: bin } },
  );
  if (tests.status !== 0) throw new Error("pack-test: the e2e suite failed");

  cdkApp(tarball);
  typescriptConsumers(join(tmp, "cdk-app"));
  initApp(tarball, dist);
  status = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (process.env.KEEP_PACK_TEST === "1") console.log(`pack-test: kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = status;
