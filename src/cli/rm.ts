// `artifact rm <id>` (docs/decisions/0044): asks on a TTY, naming what it deletes; scripts must
// pass --yes.
import { createInterface } from "node:readline/promises";
import type { ArtifactDetails } from "../core/artifact-service.ts";
import { parseCommand } from "./args.ts";
import { artifactPath, connect } from "./client.ts";
import { type CliContext, EXIT, printJson, UsageError } from "./output.ts";

export const USAGE = `Usage: artifact rm <id> [options]

Deletes an artifact and all its versions; its URL stops working. When stdin is a terminal it
looks the artifact up and asks for confirmation; otherwise --yes is required.

Options:
  --yes                 Delete without looking up or asking
  --json                Print {"ok": true}
  --server <url>        Server URL (default ARTIFACT_SERVER or http://localhost:4400)
  -h, --help            Show this help
`;

/** `Delete "<title>" (<id>, <n> versions)? [y/N] ` */
export function deletePrompt(meta: Pick<ArtifactDetails, "id" | "title" | "versions">): string {
  const n = meta.versions.length;
  const title = meta.title ?? "(untitled)";
  return `Delete ${JSON.stringify(title)} (${meta.id}, ${n} ${n === 1 ? "version" : "versions"})? [y/N] `;
}

/** True only on `y` or `yes` (any case). */
export function confirmed(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

async function ask(ctx: CliContext, question: string): Promise<string> {
  const rl = createInterface({ input: ctx.stdin, output: ctx.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    options: {
      yes: { type: "boolean" },
      json: { type: "boolean" },
      server: { type: "string" },
    },
    positionals: { min: 1, max: 1 },
  });
  ctx.json = values.json === true;
  const [id] = positionals;
  const client = connect(ctx, values.server);
  if (!values.yes) {
    // Checked before any request: without a TTY there is nobody to ask.
    if (ctx.stdin.isTTY !== true) {
      throw new UsageError("stdin is not a terminal; pass --yes to delete without a prompt");
    }
    // An unknown id fails here with not_found, before the prompt.
    const meta = (await client.json("GET", artifactPath(id))).body as ArtifactDetails;
    if (!confirmed(await ask(ctx, deletePrompt(meta)))) {
      ctx.stderr.write("not deleted\n");
      return EXIT.error;
    }
  }
  await client.json("DELETE", artifactPath(id));
  if (values.json) printJson(ctx, { ok: true });
  else ctx.stdout.write(`deleted ${id}\n`);
  return EXIT.ok;
}
