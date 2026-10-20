// Shared plumbing of the smoke, retention and DNS scripts (docs/decisions/0076): strict option
// parsing, exit codes (0 ok, 1 a check failed, 2 bad input) and the repo's built CLI.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";

/** Bad input: printed with the usage, exit 2. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export function parseOptions<const O extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  options: O,
  positionals = 0,
) {
  let parsed: ReturnType<typeof parseArgs<{ options: O; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new InputError((error as Error).message);
  }
  if (parsed.positionals.length > positionals) {
    throw new InputError(`unexpected argument ${JSON.stringify(parsed.positionals[positionals])}`);
  }
  return parsed;
}

/** Run `main`, mapping an `InputError` to exit 2 with the usage. */
export async function runScript(usage: string, main: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof InputError) {
      process.stderr.write(`${error.message}\n\n${usage}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    process.exitCode = 1;
  }
}

export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
export const CLI = join(REPO, "dist", "cli", "main.js");

export type CliResult = { status: number; stdout: string; stderr: string };

/** Run the repo's built `artifact` CLI (`pnpm build` first), as the guide does. */
export function artifact(args: string[], env: Record<string, string | undefined>): CliResult {
  if (!existsSync(CLI)) throw new InputError(`${CLI} is missing; run pnpm build in the repo root`);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
