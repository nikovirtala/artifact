// Steps of .github/workflows/publish.yml (docs/decisions/0049). Uses only node builtins,
// so it runs before `pnpm install`.
//   node scripts/release-check.ts npm    npm is new enough for trusted publishing
//   node scripts/release-check.ts plan   whether the package.json version still needs publishing;
//                                        writes publish, version and tag to $GITHUB_OUTPUT
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

/** Trusted publishing needs npm 11.5.1. */
export const MIN_NPM = "11.5.1";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** Parses `X.Y.Z[-pre][+build]`, or returns undefined. */
export function parseSemver(version: string): Semver | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return undefined;
  const [, major, minor, patch, pre] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split(".") : [],
  };
}

/** Semver precedence of `a` and `b`: negative, zero or positive. Throws on an invalid version. */
export function compareSemver(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => {
    const parsed = parseSemver(v);
    if (!parsed) throw new Error(`${v} is not a semver version`);
    return parsed;
  });
  const core = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (core !== 0) return Math.sign(core);
  // A version without a prerelease ranks above the same version with one.
  if (x.prerelease.length === 0 && y.prerelease.length === 0) return 0;
  if (x.prerelease.length === 0) return 1;
  if (y.prerelease.length === 0) return -1;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const [p, q] = [x.prerelease[i], y.prerelease[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** True if the `X.Y.Z` part of `version` is at least `min`; a prerelease suffix is ignored. */
export function atLeast(version: string, min: string): boolean {
  const [a, b] = [parseSemver(version.replace(/-.*$/, "")), parseSemver(min)];
  if (!a || !b) return false;
  return compareSemver(`${a.major}.${a.minor}.${a.patch}`, min) >= 0;
}

/** The npm dist-tag for `version`: `next` for a prerelease, else `latest`. */
export function distTag(version: string): "latest" | "next" {
  return version.includes("-") ? "next" : "latest";
}

export interface RegistryState {
  /** Whether this exact version is on npm. */
  published: boolean;
  /** The `latest` dist-tag, or undefined if the package is not on npm. */
  latest?: string;
}

export type Plan =
  | { publish: false; version: string; tag: string; reason: string }
  | { publish: true; version: string; tag: string };

/** What the publish workflow does with `version` given the registry state; throws if it must fail. */
export function plan(version: string, registry: RegistryState): Plan {
  if (!parseSemver(version)) throw new Error(`package.json version ${version} is not semver`);
  const tag = distTag(version);
  if (registry.published) {
    return { publish: false, version, tag, reason: `version ${version} already on npm` };
  }
  if (registry.latest !== undefined && compareSemver(version, registry.latest) < 0) {
    throw new Error(`version ${version} is lower than ${registry.latest}, the latest on npm`);
  }
  return { publish: true, version, tag };
}

/** Parses an `npm view --json` result; undefined for E404 (no such package or version). */
export function parseView(result: { status: number | null; stdout: string }): unknown {
  const output = result.stdout.trim();
  let json: unknown;
  try {
    json = output === "" ? undefined : JSON.parse(output);
  } catch {
    throw new Error(`npm view printed something that is not JSON: ${output}`);
  }
  const error = (json as { error?: { code?: string; summary?: string } } | undefined)?.error;
  if (result.status === 0 && !error) return json;
  if (error?.code === "E404") return undefined;
  throw new Error(`npm view failed: ${error?.summary ?? error?.code ?? `exit ${result.status}`}`);
}

/** Asks the registry about `name@version` through `npm view`. */
export function registryState(
  name: string,
  version: string,
  view: (args: string[]) => unknown = npmView,
): RegistryState {
  const found = view([`${name}@${version}`, "version"]);
  const latest = view([name, "dist-tags.latest"]);
  return {
    published: found !== undefined,
    latest: typeof latest === "string" ? latest : undefined,
  };
}

function npmView(args: string[]): unknown {
  const result = spawnSync("npm", ["view", ...args, "--json"], { encoding: "utf8" });
  if (result.error) throw result.error;
  return parseView(result);
}

function main([command]: string[]): number {
  if (command === "npm") {
    const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    if (!atLeast(version, MIN_NPM)) {
      console.error(`release-check: npm ${version} is older than ${MIN_NPM} (trusted publishing)`);
      return 1;
    }
    console.log(`release-check: npm ${version} >= ${MIN_NPM}`);
    return 0;
  }
  if (command === "plan") {
    const { name, version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const result = plan(version, registryState(name, version));
    const outputs = `publish=${result.publish}\nversion=${result.version}\ntag=${result.tag}\n`;
    process.stdout.write(outputs);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
    const summary = result.publish
      ? `publishing ${name}@${version} with dist-tag ${result.tag}`
      : `${result.reason}; nothing to publish`;
    console.log(`release-check: ${summary}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    }
    return 0;
  }
  console.error("usage: node scripts/release-check.ts npm | plan");
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`release-check: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
