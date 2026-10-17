#!/usr/bin/env node
// `artifact` CLI. M0: usage only; commands are implemented in later milestones.

const commands = [
  ["serve [--port] [--root] [--isolation]", "Run the server"],
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

function main(argv: readonly string[]): number {
  const [command] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(usage());
    return 0;
  }
  if (command === undefined) {
    process.stderr.write(usage());
    return 1;
  }
  if (commandNames.has(command)) {
    process.stderr.write(`artifact: '${command}' is not implemented yet\n`);
    return 1;
  }
  process.stderr.write(`artifact: unknown command '${command}'\n\n${usage()}`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
