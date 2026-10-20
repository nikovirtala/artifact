// Steps of .github/workflows/publish.yml (docs/decisions/0049, 0077). Uses only node builtins,
// so it runs before `pnpm install`.
//   node scripts/release-check.ts npm    npm is new enough for trusted publishing
//   node scripts/release-check.ts next   the next version from v* tags and Conventional Commits
//                                        (git only, no npm)
//   node scripts/release-check.ts plan   whether that version needs publishing;
//                                        writes publish, version and tag to $GITHUB_OUTPUT
//   node scripts/release-check.ts guard  fails if package.json holds the placeholder version
//                                        (prepublishOnly, so a manual publish cannot ship it)
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

/** The version package.json holds on main; CI stamps the real one into its checkout. */
export const PLACEHOLDER_VERSION = "0.0.0-development";

/** Whether `version` is the placeholder rather than a release. */
export function isPlaceholder(version: string): boolean {
  return version === PLACEHOLDER_VERSION;
}

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

export type Bump = "major" | "minor" | "patch";

const BUMPS: Bump[] = ["patch", "minor", "major"];

/** A Conventional Commits header: `type(scope)!: description`. */
export const HEADER =
  /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()\r\n]*)\))?(?<bang>!)?: (?<description>.*)$/;

/** The release `message` asks for: breaking → major, feat → minor, fix or perf → patch, else none. */
export function commitBump(message: string): Bump | undefined {
  const [header = "", ...rest] = message.split(/\r?\n/);
  const match = HEADER.exec(header);
  if (!match?.groups) return undefined;
  if (match.groups.bang || rest.some((line) => /^BREAKING[ -]CHANGE: /.test(line))) {
    return "major";
  }
  const type = match.groups.type.toLowerCase();
  if (type === "feat") return "minor";
  if (type === "fix" || type === "perf") return "patch";
  return undefined;
}

/** The largest bump any of `messages` asks for, or undefined if none releases. */
export function highestBump(messages: string[]): Bump | undefined {
  let highest: Bump | undefined;
  for (const message of messages) {
    const bump = commitBump(message);
    if (bump && (!highest || BUMPS.indexOf(bump) > BUMPS.indexOf(highest))) highest = bump;
  }
  return highest;
}

/** `version` bumped by `bump`; throws for a version that is not a stable `X.Y.Z`. */
export function bumpVersion(version: string, bump: Bump): string {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease.length > 0 || version.includes("+")) {
    throw new Error(`${version} is not a stable X.Y.Z version`);
  }
  const { major, minor, patch } = parsed;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The highest stable release tag `vX.Y.Z` among `tags`, or undefined. Prereleases never count. */
export function latestReleaseTag(tags: string[]): string | undefined {
  let latest: string | undefined;
  for (const tag of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag) || !parseSemver(tag.slice(1))) continue;
    if (!latest || compareSemver(tag.slice(1), latest.slice(1)) > 0) latest = tag;
  }
  return latest;
}

/** The release tag reachable from HEAD and the commit messages since it. */
export interface History {
  tag: string | undefined;
  messages: string[];
}

export type NextRelease =
  | { base: string; bump: Bump; version: string }
  | { base: string; reason: string };

/** The next version from the latest release tag and the commits since; throws without a tag. */
export function nextRelease({ tag, messages }: History): NextRelease {
  if (tag === undefined) {
    throw new Error(
      "no release tag vX.Y.Z reachable from HEAD; tags are the source of truth, see RELEASING.md",
    );
  }
  const base = tag.slice(1);
  const bump = highestBump(messages);
  if (!bump) {
    return { base, reason: `no feat, fix, perf or breaking commits since ${tag}` };
  }
  return { base, bump, version: bumpVersion(base, bump) };
}

/** Reads the release tag reachable from HEAD and the commit messages since it through `git`. */
export function readHistory(git: (args: string[]) => string = runGit): History {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error("shallow clone: release tags and history need fetch-depth: 0");
  }
  const tag = latestReleaseTag(git(["tag", "--merged", "HEAD", "--list", "v*"]).split(/\s+/));
  if (tag === undefined) return { tag, messages: [] };
  const messages = git(["log", "--format=%B%x00", `${tag}..HEAD`])
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");
  return { tag, messages };
}

function runGit(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
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
  if (command === "next") {
    const next = nextRelease(readHistory());
    console.log(
      "version" in next
        ? `release-check: next version ${next.version} (${next.bump} since v${next.base})`
        : `release-check: ${next.reason}; nothing to release`,
    );
    return 0;
  }
  if (command === "plan") {
    const { name } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const next = nextRelease(readHistory());
    let result: Plan | undefined;
    let summary: string;
    if (!("version" in next)) {
      summary = `${next.reason}; nothing to release`;
    } else {
      result = plan(next.version, registryState(name, next.version));
      if (result.publish) {
        summary = `publishing ${name}@${result.version} (${next.bump} since v${next.base}) with dist-tag ${result.tag}`;
      } else {
        const v = result.version;
        summary =
          `v${v} is on npm but no tag v${v} is reachable: create it on the published commit ` +
          `(npm view ${name}@${v} gitHead) with gh release create v${v} --target <sha>`;
        console.log(`::warning::${summary}`);
      }
    }
    const outputs = result?.publish
      ? `publish=true\nversion=${result.version}\ntag=${result.tag}\n`
      : "publish=false\nversion=\ntag=\n";
    process.stdout.write(outputs);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
    console.log(`release-check: ${summary}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    }
    return 0;
  }
  if (command === "guard") {
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (isPlaceholder(version)) {
      console.error(
        "release-check: package.json version is the placeholder; releases publish from CI (RELEASING.md)",
      );
      return 1;
    }
    return 0;
  }
  console.error("usage: node scripts/release-check.ts npm | next | plan | guard");
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
