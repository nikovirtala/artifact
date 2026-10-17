#!/usr/bin/env node
// `artifact` CLI. M2: `serve`; the client commands arrive in M5.
import { runServe } from "./serve.ts";

const commands = [
  ["serve [--port] [--root] [--host] [--isolation] [--csp]", "Run the server"],
  ["publish <file or dir> [--id] [--title] [--label]", "Create or update; prints the URL"],
  ["list", "List artifacts"],
  ["read <id> [--version]", "Print an artifact's files"],
  ["open <id>", "Open an artifact in the browser"],
  ["rollback <id> <version>", "Move the current pointer to an earlier version"],
  ["rm <id>", "Delete an artifact and all its versions"],
  ["mcp", "stdio MCP bridge to the running server"],
] as const;

const commandNames: ReadonlySet<string> = new Set(commands.map(([usage]) => usage.split(" ")[0]));

function usage(): string {
  const width = Math.max(...commands.map(([u]) => u.length));
  const lines = commands.map(([u, desc]) => `  artifact ${u.padEnd(width)}  ${desc}`);
  return [
    "Usage: artifact <command> [options]",
    "",
    "Commands:",
    ...lines,
    "",
    "Options:",
    "  -h, --help  Show this help",
    "",
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(usage());
    return 0;
  }
  if (command === undefined) {
    process.stderr.write(usage());
    return 1;
  }
  if (command === "serve") return runServe(argv.slice(1), process.env);
  if (commandNames.has(command)) {
    process.stderr.write(`artifact: '${command}' is not implemented yet\n`);
    return 1;
  }
  process.stderr.write(`artifact: unknown command '${command}'\n\n${usage()}`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
