// Shared plumbing for the CLI commands (docs/decisions/0041): the context a command runs in, the
// error types `main.ts` maps to exit codes, and output helpers.
import type { Env } from "../config.ts";

/** Everything a command may touch besides the network; tests pass fakes. */
export type CliContext = {
  env: Env;
  cwd: string;
  home: string;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Set by a command that was given `--json`: a failure is then printed as JSON (0041). */
  json?: boolean;
};

export const EXIT = { ok: 0, error: 1, usage: 2 } as const;

/** A failure reported as `error: <code>: <message>`, exit 1 (API codes, `no_server`, …). */
export class CliError extends Error {
  readonly code: string;
  /** The API error body's other fields (`currentVersion`, `path`, …), printed with `--json`. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

/** Bad invocation: printed with the command's usage, exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** `--help` / `-h` on a command: `main.ts` prints its usage to stdout, exit 0. */
export class HelpRequested extends Error {
  constructor() {
    super("help requested");
    this.name = "HelpRequested";
  }
}

export function formatError(code: string, message: string): string {
  return `error: ${code}: ${message}`;
}

/** The API's error shape on one line: `{"error": <code>, "message": <text>, …details}`. */
export function formatJsonError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({ error: code, message, ...details });
}

export function printJson(ctx: CliContext, value: unknown): void {
  ctx.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i])))
        .join("  ")
        .trimEnd(),
    )
    .map((line) => `${line}\n`)
    .join("");
}
