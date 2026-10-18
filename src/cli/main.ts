#!/usr/bin/env node
// `artifact` CLI: one binary for the server and the client commands (docs/decisions/0041).
// Exit codes: 0 ok, 1 error, 2 usage. Sets process.exitCode and never calls process.exit, so
// binary output on stdout is flushed.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { SERVE_USAGE } from "../config.ts";
import {
  type CliContext,
  CliError,
  EXIT,
  formatError,
  formatJsonError,
  HelpRequested,
  UsageError,
} from "./output.ts";
import * as publish from "./publish.ts";
import { runServe } from "./serve.ts";

type Command = {
  name: string;
  summary: string;
  /** Starts with `Usage: artifact <name> …`; that line's rest is the synopsis in the global help. */
  usage: string;
  run: (args: string[], ctx: CliContext) => Promise<number>;
};

const { version: PACKAGE_VERSION } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

/** A client command module: `USAGE` and `run`. */
const command = (
  name: string,
  summary: string,
  module: { USAGE: string; run: Command["run"] },
): Command => ({ name, summary, usage: module.USAGE, run: module.run });

const notImplemented = (name: string, synopsis: string, summary: string): Command => ({
  name,
  summary,
  usage: `Usage: artifact ${name} ${synopsis}\n`,
  run: async (_args, ctx) => {
    ctx.stderr.write(`artifact: '${name}' is not implemented yet\n`);
    return EXIT.error;
  },
});

const commands: readonly Command[] = [
  {
    name: "serve",
    summary: "Run the server",
    usage: SERVE_USAGE,
    run: (args, ctx) => runServe(args, ctx.env),
  },
  command("publish", "Create or update; prints the URL", publish),
  notImplemented("list", "[options]", "List artifacts"),
  notImplemented("read", "<id> [options]", "Print an artifact's files"),
  notImplemented("open", "<id> [options]", "Open an artifact in the browser"),
  notImplemented(
    "rollback",
    "<id> <version> [options]",
    "Move the current pointer to an earlier version",
  ),
  notImplemented("rm", "<id> [options]", "Delete an artifact and all its versions"),
  notImplemented("init", "[options]", "Add the agent instructions to CLAUDE.md / AGENTS.md"),
  notImplemented("mcp", "[options]", "stdio MCP bridge to the running server"),
];

function synopsis(command: Command): string {
  const first = command.usage.split("\n", 1)[0];
  return first.replace(/^Usage: artifact /, "");
}

function usage(): string {
  const width = Math.max(...commands.map((c) => synopsis(c).length));
  const lines = commands.map((c) => `  artifact ${synopsis(c).padEnd(width)}  ${c.summary}`);
  return [
    "Usage: artifact <command> [options]",
    "",
    "Commands:",
    ...lines,
    "",
    "Options:",
    "  -h, --help  Show this help (artifact <command> --help for a command's options)",
    "  --version   Print the version",
    "",
    "Client commands talk to the server at --server, ARTIFACT_SERVER or http://localhost:4400,",
    "sending ARTIFACT_TOKEN as a bearer token when it is set.",
    "",
    "Exit codes: 0 ok, 1 error, 2 usage error.",
    "",
  ].join("\n");
}

async function main(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [name, ...args] = argv;
  if (name === "--help" || name === "-h" || name === "help") {
    ctx.stdout.write(usage());
    return EXIT.ok;
  }
  if (name === "--version") {
    ctx.stdout.write(`${PACKAGE_VERSION}\n`);
    return EXIT.ok;
  }
  if (name === undefined) {
    ctx.stderr.write(usage());
    return EXIT.usage;
  }
  const selected = commands.find((c) => c.name === name);
  if (!selected) {
    ctx.stderr.write(`artifact: unknown command '${name}'\n\n${usage()}`);
    return EXIT.usage;
  }
  try {
    return await selected.run(args, ctx);
  } catch (error) {
    if (error instanceof HelpRequested) {
      ctx.stdout.write(selected.usage);
      return EXIT.ok;
    }
    if (error instanceof UsageError) {
      ctx.stderr.write(`artifact ${selected.name}: ${error.message}\n\n${selected.usage}`);
      return EXIT.usage;
    }
    const [code, message, details] =
      error instanceof CliError
        ? [error.code, error.message, error.details]
        : ["internal", (error as Error).message, {}];
    ctx.stderr.write(
      `${ctx.json ? formatJsonError(code, message, details) : formatError(code, message)}\n`,
    );
    return EXIT.error;
  }
}

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
