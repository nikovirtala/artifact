// Pack the package, install the tarball into a temp app and run the e2e suite against the
// installed bin (docs/decisions/0048). Not part of `pnpm check`: it builds and needs the registry.
// KEEP_PACK_TEST=1 keeps the temp directory for inspection.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
      e.endsWith(".d.ts"),
  );
  if (missing.length > 0) throw new Error(`pack-test: tarball lacks ${missing.join(", ")}`);
  if (forbidden.length > 0) throw new Error(`pack-test: tarball ships ${forbidden.join(", ")}`);

  // The AWS code stays out of the package: v1 runtime dependencies only, no peers yet (0059).
  const packed = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"], tmp)) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const dependencies = Object.keys(packed.dependencies ?? {}).sort();
  const v1Dependencies = ["@hono/node-server", "@modelcontextprotocol/sdk", "hono", "zod"];
  if (dependencies.join() !== v1Dependencies.join()) {
    throw new Error(`pack-test: dependencies are ${dependencies.join(", ")}`);
  }
  if (packed.peerDependencies !== undefined) {
    throw new Error("pack-test: the package declares peerDependencies");
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

  const dist = join(app, "node_modules", "@nikovirtala", "artifact", "dist");
  const tsImport = /(?:from\s*|import\s*\(\s*)["'][^"']+\.ts["']/;
  // Every file, not only .js: anything shipped that names a .ts module is a leftover.
  const offenders = readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => tsImport.test(readFileSync(file, "utf8")))
    .map((file) => relative(dist, file));
  if (offenders.length > 0) {
    throw new Error(`pack-test: .ts imports in installed dist: ${offenders.join(", ")}`);
  }
  console.log("pack-test: no file in installed dist imports .ts, and the tarball has no .d.ts");

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
