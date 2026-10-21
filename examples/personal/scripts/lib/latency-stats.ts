// The pure parts of the latency script (design §15, docs/decisions/0086): arguments, nearest-rank
// percentiles, the state file, the idle-wait rule, REPORT parsing and the pasteable table.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stages } from "../../lib/stages.ts";
import { InputError, parseOptions } from "./cli.ts";
import type { LogEvent } from "./logs.ts";

export const PHASES = ["warm", "idle", "report"] as const;
export type Phase = (typeof PHASES)[number];

export type LatencyArgs = {
  phase: Phase | undefined;
  samples: number;
  keep: boolean;
  stage: string;
  constructId: string;
  help: boolean;
};

export const DEFAULT_SAMPLES = 20;

export function parseLatencyArgs(argv: readonly string[]): LatencyArgs {
  const { values, positionals } = parseOptions(
    argv,
    {
      samples: { type: "string" },
      keep: { type: "boolean" },
      stage: { type: "string" },
      "construct-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    1,
  );
  const help = values.help === true;
  const [phase] = positionals;
  if (!help && !PHASES.includes(phase as Phase)) {
    throw new InputError(`give a phase: ${PHASES.join(", ")}`);
  }
  if (values.samples !== undefined && phase !== "warm") {
    throw new InputError("--samples applies to warm only");
  }
  if (values.keep !== undefined && phase !== "report") {
    throw new InputError("--keep applies to report only");
  }
  const samples = values.samples === undefined ? DEFAULT_SAMPLES : Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > 200) {
    throw new InputError("--samples must be an integer from 1 to 200");
  }
  const stage = values.stage ?? "prod";
  if (!help && !Object.hasOwn(stages, stage)) {
    throw new InputError(`unknown stage ${JSON.stringify(stage)}`);
  }
  return {
    phase: phase as Phase | undefined,
    samples,
    keep: values.keep === true,
    stage,
    constructId: values["construct-id"] ?? "Artifacts",
    help,
  };
}

/** Nearest-rank percentile: the smallest value with at least `p`% of the values at or below it. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** At least this long without a request before `idle` measures (design §15). */
export const IDLE_MS = 30 * 60_000;

/** How much longer `idle` must wait; 0 when it may run. */
export function idleWaitMs(lastRequestAt: number, now: number): number {
  return Math.max(0, lastRequestAt + IDLE_MS - now);
}

export type PageTimes = { html: number[]; slowest: number[]; complete: number[] };
export type Connect = { dns: number; tcp: number; tls: number };

/** `$HOME/.artifact-latency.json`: ids, timestamps and results only, never a secret. */
export type LatencyState = {
  version: 1;
  stage: string;
  apiUrl: string;
  sessionSecretArn: string;
  viewLogGroupName: string;
  /** H (one HTML page) and T (index.html + 10 assets). */
  h: string;
  t: string;
  lastRequestAt: number;
  pop: string;
  firstConnect?: Connect;
  warm: { html: number[]; page: PageTimes; pinned: number[]; pinnedHits: number };
  edge: { utilization?: number; error?: string };
  idle: { html: number[]; page: PageTimes; init: (number | null)[] };
};

export const statePath = (home = homedir()) => join(home, ".artifact-latency.json");

export function readState(path: string): LatencyState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new InputError(`no ${path}; run pnpm latency warm first`);
  }
  const state = JSON.parse(text) as LatencyState;
  if (state?.version !== 1) throw new InputError(`${path} is not a latency state file`);
  return state;
}

export function writeState(path: string, state: LatencyState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** The `Init Duration` of each Lambda `REPORT` line, `null` for a warm invocation. */
export function initDurations(events: readonly LogEvent[]): (number | null)[] {
  return events
    .filter((e) => /\bREPORT RequestId:/.test(e.message))
    .map((e) => {
      const m = /Init Duration: ([\d.]+) ms/.exec(e.message);
      return m ? Number(m[1]) : null;
    });
}

const ms = (value: number | undefined) => (value === undefined ? "…" : String(Math.round(value)));
const both = (values: readonly number[]) => [
  ms(percentile(values, 50)),
  ms(percentile(values, 95)),
];
const page = (times: PageTimes, p: number) =>
  [times.html, times.slowest, times.complete].map((v) => ms(percentile(v, p))).join(" / ");

/** The pasteable Markdown table of design §15. */
export function renderLatencyTable(state: LatencyState): string {
  const { warm, idle, edge, firstConnect } = state;
  const connect = firstConnect
    ? `first request DNS ${ms(firstConnect.dns)} / TCP ${ms(firstConnect.tcp)} / TLS ${ms(firstConnect.tls)} ms`
    : "first request DNS/TCP/TLS …";
  const init =
    idle.init.length === 0
      ? "…"
      : idle.init.map((d) => (d === null ? "warm" : `${ms(d)} ms`)).join(", ");
  const rows = [
    [
      "HTML, current, warm",
      String(warm.html.length),
      ...both(warm.html),
      `POP ${state.pop}, ${connect}`,
    ],
    [
      "10-asset page, warm (HTML / slowest asset / complete)",
      String(warm.page.html.length),
      page(warm.page, 50),
      page(warm.page, 95),
      "",
    ],
    [
      "HTML, current, after ≥ 30 min idle",
      String(idle.html.length),
      ...both(idle.html),
      `Init Duration ${init}`,
    ],
    [
      "10-asset page, after ≥ 30 min idle",
      String(idle.page.html.length),
      page(idle.page, 50),
      page(idle.page, 95),
      "",
    ],
    [
      "Pinned `/v/1/`",
      String(warm.pinned.length),
      ...both(warm.pinned),
      `x-cache hits ${warm.pinnedHits}/${warm.pinned.length}`,
    ],
    [
      "Edge function compute utilization",
      "1",
      "—",
      "—",
      edge.utilization === undefined
        ? `— ${edge.error ?? "not measured"}`
        : `${edge.utilization} %`,
    ],
  ];
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return `${[
    line(["case", "n", "p50 TTFB ms", "p95 TTFB ms", "notes"]),
    line(["---", "---", "---", "---", "---"]),
    ...rows.map(line),
  ].join("\n")}\n`;
}
