// Flag parsing for the client commands: node:util parseArgs in strict mode (docs/decisions/0007,
// 0041). Every failure is a UsageError; `-h`/`--help` raises HelpRequested.
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { HelpRequested, UsageError } from "./output.ts";

export type Values<O extends ParseArgsOptionsConfig> = {
  [K in keyof O]?: O[K]["type"] extends "boolean" ? boolean : string;
};

export type Parsed<O extends ParseArgsOptionsConfig> = { values: Values<O>; positionals: string[] };

export function parseCommand<const O extends ParseArgsOptionsConfig>(
  args: readonly string[],
  spec: { options: O; positionals?: { min: number; max: number } },
): Parsed<O> {
  const { min, max } = spec.positionals ?? { min: 0, max: 0 };
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: { ...spec.options, help: { type: "boolean", short: "h" } },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (parsed.values.help) throw new HelpRequested();
  const { positionals } = parsed;
  if (positionals.length < min) throw new UsageError("missing argument");
  if (positionals.length > max) {
    throw new UsageError(`unexpected argument ${JSON.stringify(positionals[max])}`);
  }
  return { values: parsed.values as Values<O>, positionals };
}

/** A flag value that must be a positive integer (a version number). */
export function positiveInteger(name: string, value: string): number {
  const n = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n)) {
    throw new UsageError(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}
