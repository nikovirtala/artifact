// `artifact rollback <id> <version>` (docs/decisions/0044): move the current pointer.
import { parseCommand, positiveInteger } from "./args.ts";
import { artifactPath, connect } from "./client.ts";
import { type CliContext, EXIT, printJson } from "./output.ts";

export const USAGE = `Usage: artifact rollback <id> <version> [options]

Makes an earlier committed version current again (nothing is copied or lost) and prints the URL.

Options:
  --json                Print the API response
  --server <url>        Server URL (default ARTIFACT_SERVER or http://localhost:4400)
  -h, --help            Show this help
`;

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    options: { json: { type: "boolean" }, server: { type: "string" } },
    positionals: { min: 2, max: 2 },
  });
  ctx.json = values.json === true;
  const [id, rawVersion] = positionals;
  const version = positiveInteger("version", rawVersion);
  const client = connect(ctx, values.server);
  const { body } = await client.json("POST", artifactPath(id, "rollback"), { body: { version } });
  if (values.json) {
    printJson(ctx, body);
    return EXIT.ok;
  }
  const result = body as { id: string; version: number; url: string };
  ctx.stdout.write(`${result.url}\n`);
  ctx.stderr.write(`rolled back ${result.id} to version ${result.version}\n`);
  return EXIT.ok;
}
