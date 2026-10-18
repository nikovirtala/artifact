// `artifact init` (docs/decisions/0046): write the agent snippet block (and the project pin) into
// CLAUDE.md / AGENTS.md, optionally deny Claude Code's built-in Artifact tool, and print the
// `claude mcp add` line. Every target is computed before anything is written.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { envValue } from "../config.ts";
import { normalizeProject } from "../core/project.ts";
import { parseCommand } from "./args.ts";
import { resolveServer } from "./client.ts";
import { type CliContext, CliError, EXIT, UsageError } from "./output.ts";
import { deriveProject } from "./project.ts";
import { END, mcpAddCommand, START, snippetBlock } from "./snippet.ts";

export const USAGE = `Usage: artifact init [options]

Adds the instructions that make agents publish here to CLAUDE.md and AGENTS.md in the working
directory (whichever exist, else a new CLAUDE.md), pinning the project derived from git as
agents derive it. Re-running refreshes the block in place; other text is left as it is.

Options:
  --global              Write ~/.claude/CLAUDE.md instead (every project; no pin)
  --project <project>   Pin this project instead of the derived one
  --deny-builtin        Also add "Artifact" to permissions.deny in .claude/settings.json
                        (~/.claude/settings.json with --global)
  --dry-run             Print what would change and write nothing
  --server <url>        Server URL in the printed \`claude mcp add\` line (default
                        ARTIFACT_SERVER or http://localhost:4400)
  -h, --help            Show this help
`;

export type Status = "created" | "updated" | "unchanged";
export type Change = { text: string; status: Status } | { error: string };

/**
 * `existing` with `block` in place of its first marked block, or appended after one blank line.
 * Markers that do not pair up are an error.
 */
export function upsertBlock(existing: string | undefined, block: string): Change {
  if (existing === undefined) return { text: `${block}\n`, status: "created" };
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (end !== -1 && (start === -1 || end < start)) {
    return { error: `${END} without a ${START} before it` };
  }
  if (start !== -1) {
    const close = existing.indexOf(END, start + START.length);
    if (close === -1) return { error: `${START} without a ${END} after it` };
    const text = existing.slice(0, start) + block + existing.slice(close + END.length);
    return { text, status: text === existing ? "unchanged" : "updated" };
  }
  let prefix = existing;
  if (prefix !== "" && !prefix.endsWith("\n")) prefix += "\n";
  if (prefix !== "" && !prefix.endsWith("\n\n")) prefix += "\n";
  return { text: `${prefix}${block}\n`, status: "updated" };
}

const DENIED = "Artifact";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Claude Code settings with `"Artifact"` in `permissions.deny`; other keys are kept. */
export function mergeDeny(existing: string | undefined): Change {
  const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  if (existing === undefined) {
    return { text: serialize({ permissions: { deny: [DENIED] } }), status: "created" };
  }
  let settings: unknown;
  try {
    settings = JSON.parse(existing);
  } catch (error) {
    return { error: `not valid JSON (${(error as Error).message})` };
  }
  if (!isObject(settings)) return { error: "not a JSON object" };
  const permissions = settings.permissions ?? {};
  if (!isObject(permissions)) return { error: "permissions is not an object" };
  const deny = permissions.deny ?? [];
  if (!Array.isArray(deny)) return { error: "permissions.deny is not an array" };
  if (deny.includes(DENIED)) return { text: existing, status: "unchanged" };
  const merged = { ...settings, permissions: { ...permissions, deny: [...deny, DENIED] } };
  return { text: serialize(merged), status: "updated" };
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError("io_error", `cannot read ${path}: ${(error as Error).message}`);
  }
}

type Target = { path: string; change: Change };

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const { values } = parseCommand(args, {
    options: {
      global: { type: "boolean" },
      project: { type: "string" },
      "deny-builtin": { type: "boolean" },
      "dry-run": { type: "boolean" },
      server: { type: "string" },
    },
  });
  if (values.global && values.project !== undefined) {
    throw new UsageError("--global pins no project; run init in the repository to pin one");
  }
  if (values.project === "") throw new UsageError("--project must not be empty");
  const server = resolveServer(values.server, ctx.env);

  let project: string | undefined;
  if (values.project !== undefined) {
    const normalized = normalizeProject(values.project);
    if (!normalized.ok) throw new UsageError(normalized.error.message);
    project = normalized.value;
  } else if (!values.global) {
    project = await deriveProject(ctx.cwd);
  }

  const claudeDir = values.global ? join(ctx.home, ".claude") : join(ctx.cwd, ".claude");
  const docs: string[] = [];
  if (values.global) {
    docs.push(join(claudeDir, "CLAUDE.md"));
  } else {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const path = join(ctx.cwd, name);
      if ((await readIfExists(path)) !== undefined) docs.push(path);
    }
    if (docs.length === 0) docs.push(join(ctx.cwd, "CLAUDE.md"));
  }

  const block = snippetBlock(project);
  const targets: Target[] = [];
  for (const path of docs) {
    targets.push({ path, change: upsertBlock(await readIfExists(path), block) });
  }
  if (values["deny-builtin"]) {
    const path = join(claudeDir, "settings.json");
    targets.push({ path, change: mergeDeny(await readIfExists(path)) });
  }

  const errors = targets.flatMap(({ path, change }) =>
    "error" in change ? [`${path}: ${change.error}`] : [],
  );
  if (errors.length) {
    throw new CliError("invalid_input", `${errors.join("; ")}; nothing was written`);
  }

  for (const { path, change } of targets) {
    if ("error" in change) continue;
    if (values["dry-run"]) {
      ctx.stdout.write(`${path}: would be ${change.status}\n`);
      const shown = path.endsWith(".json") ? change.text : `${block}\n`;
      ctx.stdout.write(`${shown}\n`);
      continue;
    }
    if (change.status !== "unchanged") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, change.text);
    }
    ctx.stdout.write(`${path}: ${change.status}\n`);
  }

  const withToken = envValue(ctx.env, "ARTIFACT_TOKEN") !== undefined;
  // A dry run already ends each target with a blank line.
  ctx.stdout.write(
    `${values["dry-run"] ? "" : "\n"}Connect Claude Code to the server (once per machine):\n  ${mcpAddCommand(server, withToken)}\n`,
  );
  return EXIT.ok;
}
