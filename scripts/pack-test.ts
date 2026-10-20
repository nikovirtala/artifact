// Pack the package, install the tarball into a temp app and run the e2e suite against the
// installed bin (docs/decisions/0048). Not part of `pnpm check`: it builds and needs the registry.
// KEEP_PACK_TEST=1 keeps the temp directory for inspection.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TS_SPECIFIER } from "./lib/ts-specifier.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const run = (command: string, args: string[], cwd: string): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const tmp = mkdtempSync(join(tmpdir(), "artifact-pack-test-"));
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
  status = tests.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (process.env.KEEP_PACK_TEST === "1") console.log(`pack-test: kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = status;
