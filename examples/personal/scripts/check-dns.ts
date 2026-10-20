// Is the view domain's zone delegated (owner decision 3, docs/decisions/0076)? Compares the NS
// records that public resolvers return with the DNS stack's NameServers output.
//   pnpm check:dns [--stage prod]      exit 0 when both resolvers agree, 1 otherwise, 2 bad input
import { Resolver } from "node:dns/promises";
import { stages } from "../lib/stages.ts";
import { InputError, parseOptions, runScript } from "./lib/cli.ts";
import { stackOutputs } from "./lib/outputs.ts";
import { Checks, exitCode, renderTable } from "./lib/table.ts";

export const USAGE = `Usage: pnpm check:dns [--stage prod]

Resolves the view domain's NS records through 1.1.1.1 and 8.8.8.8 and compares them with the
NameServers output of artifact-<stage>-dns. Re-run until it exits 0.
`;

export const RESOLVERS = ["1.1.1.1", "8.8.8.8"] as const;

export function parseDnsArgs(argv: readonly string[]): { stage: string } {
  const { values } = parseOptions(argv, { stage: { type: "string" } });
  const stage = values.stage ?? "prod";
  if (!Object.hasOwn(stages, stage)) throw new InputError(`unknown stage ${JSON.stringify(stage)}`);
  return { stage };
}

/** Comma-separated or listed names → a sorted set: trimmed, lowercased, one trailing dot dropped. */
export function normaliseNs(names: string | readonly string[]): string[] {
  const list = typeof names === "string" ? names.split(",") : names;
  const set = new Set(
    list.map((n) => n.trim().toLowerCase().replace(/\.$/, "")).filter((n) => n !== ""),
  );
  return [...set].sort();
}

export function sameNs(a: readonly string[], b: readonly string[]): boolean {
  const [x, y] = [normaliseNs(a), normaliseNs(b)];
  return x.length === y.length && x.every((n, i) => n === y[i]);
}

/** A resolver error as a FAIL detail. */
export function dnsErrorDetail(code: string | undefined): string {
  if (code === "ENOTFOUND" || code === "ENODATA") return "not delegated yet";
  if (code === "ETIMEOUT") return "timeout";
  return `error ${code ?? "unknown"}`;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const { stage } = parseDnsArgs(argv);
  const { viewDomain, certificateRegion } = stages[stage];
  const stackName = `artifact-${stage}-dns`;
  const output = (await stackOutputs(certificateRegion, stackName)).find(
    (o) => o.OutputKey === "NameServers",
  )?.OutputValue;
  const expected = normaliseNs(output ?? "");
  if (expected.length === 0) throw new InputError(`${stackName} has no NameServers output`);
  const checks = new Checks();
  for (const ip of RESOLVERS) {
    const resolver = new Resolver({ timeout: 5000, tries: 2 });
    resolver.setServers([ip]);
    try {
      const seen = normaliseNs(await resolver.resolveNs(viewDomain));
      checks.add(
        `NS via ${ip}`,
        "delegation",
        sameNs(seen, expected) ? "PASS" : "FAIL",
        sameNs(seen, expected)
          ? seen.join(", ")
          : `resolver: ${seen.join(", ")}; stack: ${expected.join(", ")}`,
      );
    } catch (error) {
      checks.add(
        `NS via ${ip}`,
        "delegation",
        "FAIL",
        dnsErrorDetail((error as { code?: string }).code),
      );
    }
  }
  process.stdout.write(renderTable(checks.rows));
  return exitCode(checks.rows);
}

if (import.meta.main) await runScript(USAGE, () => main(process.argv.slice(2)));
