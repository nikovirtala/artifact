#!/usr/bin/env node
// `artifact` CLI: one binary for the server and the client commands (docs/decisions/0041).
// Exit codes: 0 ok, 1 error, 2 usage. Sets process.exitCode and never calls process.exit, so
// binary output on stdout is flushed.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { SERVE_USAGE } from "../config.ts";
import * as init from "./init.ts";
import * as list from "./list.ts";
import * as mcp from "./mcp.ts";
import * as open from "./open.ts";
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
import * as read from "./read.ts";
import * as rm from "./rm.ts";
import * as rollback from "./rollback.ts";
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

const commands: readonly Command[] = [
  {
    name: "serve",
    summary: "Run the server",
    usage: SERVE_USAGE,
    run: (args, ctx) => runServe(args, ctx.env),
  },
  command("publish", "Create or update; prints the URL", publish),
  command("list", "List artifacts", list),
  command("read", "Print an artifact's files", read),
  command("open", "Open an artifact in the browser", open),
  command("rollback", "Move the current pointer to an earlier version", rollback),
  command("rm", "Delete an artifact and all its versions", rm),
  command("init", "Add the agent instructions to CLAUDE.md / AGENTS.md", init),
  command("mcp", "stdio MCP bridge to the running server", mcp),
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
