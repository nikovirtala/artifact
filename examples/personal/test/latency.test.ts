// The pure parts of the latency script (design §15); no AWS calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { InputError } from "../scripts/lib/cli.ts";
import {
  IDLE_MS,
  idleWaitMs,
  initDurations,
  type LatencyState,
  parseLatencyArgs,
  percentile,
  readState,
  renderLatencyTable,
  statePath,
  writeState,
} from "../scripts/lib/latency-stats.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const T = 1_790_000_000_000;

function state(overrides: Partial<LatencyState> = {}): LatencyState {
  return {
    version: 1,
    stage: "prod",
    apiUrl: "https://api.view.example.dev",
    sessionSecretArn: "arn:aws:secretsmanager:eu-north-1:123456789012:secret:s",
    viewLogGroupName: "/aws/lambda/view",
    h: "01arz3ndektsv4rrffq69g5fav",
    t: "01arz3ndektsv4rrffq69g5fbw",
    lastRequestAt: T,
    pop: "ARN56-P1",
    firstConnect: { dns: 12.4, tcp: 8.6, tls: 20.2 },
    warm: {
      html: Array.from({ length: 20 }, (_, i) => i + 1),
      page: { html: [10, 20], slowest: [30, 40], complete: [50, 60] },
      pinned: [5, 6, 7, 8],
      pinnedHits: 3,
    },
    edge: { utilization: 14 },
    idle: { html: [400], page: { html: [410], slowest: [420], complete: [430] }, init: [350.5] },
    ...overrides,
  };
}

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--conditions=artifact-source", "scripts/latency.ts", ...args], {
    cwd: here,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", AWS_EC2_METADATA_DISABLED: "true", ...env },
  });

describe("percentiles", () => {
  it("use nearest rank", () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);
    assert.equal(percentile(values, 50), 10);
    assert.equal(percentile(values, 95), 19);
    assert.equal(percentile([3, 1, 2], 50), 2);
    assert.equal(percentile([3, 1, 2], 95), 3);
    assert.equal(percentile([], 50), undefined);
  });

  it("with k = 1 give the single value for both", () => {
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([42], 95), 42);
  });
});

describe("table", () => {
  it("renders the six rows of design §15", () => {
    const table = renderLatencyTable(state());
    const lines = table.trimEnd().split("\n");
    assert.equal(lines[0], "| case | n | p50 TTFB ms | p95 TTFB ms | notes |");
    assert.equal(lines.length, 8);
    assert.match(
      lines[2],
      /^\| HTML, current, warm \| 20 \| 10 \| 19 \| POP ARN56-P1, first request DNS 12 \/ TCP 9 \/ TLS 20 ms \|$/,
    );
    assert.match(lines[3], /\| 2 \| 10 \/ 30 \/ 50 \| 20 \/ 40 \/ 60 \|/);
    assert.match(lines[4], /after ≥ 30 min idle \| 1 \| 400 \| 400 \| Init Duration 351 ms \|$/);
    assert.match(lines[6], /x-cache hits 3\/4 \|$/);
    assert.match(lines[7], /\| 1 \| — \| — \| 14 % \|$/);
  });

  it("shows the edge error name and pending idle rows", () => {
    const table = renderLatencyTable(
      state({
        edge: { error: "AccessDenied" },
        idle: { html: [], page: { html: [], slowest: [], complete: [] }, init: [] },
      }),
    );
    assert.match(table, /\| — AccessDenied \|/);
    assert.match(table, /after ≥ 30 min idle \| 0 \| … \| … \| Init Duration … \|/);
  });
});

describe("arguments", () => {
  it("parse the three phases", () => {
    assert.deepEqual(parseLatencyArgs(["warm"]), {
      phase: "warm",
      samples: 20,
      keep: false,
      stage: "prod",
      constructId: "Artifacts",
      help: false,
    });
    assert.equal(parseLatencyArgs(["warm", "--samples", "5"]).samples, 5);
    assert.equal(parseLatencyArgs(["report", "--keep"]).keep, true);
    assert.equal(parseLatencyArgs(["idle"]).phase, "idle");
    assert.equal(parseLatencyArgs(["--help"]).help, true);
  });

  it("reject bad input", () => {
    for (const argv of [
      [],
      ["cold"],
      ["warm", "extra"],
      ["warm", "--samples", "0"],
      ["warm", "--samples", "x"],
      ["idle", "--samples", "5"],
      ["warm", "--keep"],
      ["warm", "--stage", "nope"],
      ["report", "--bogus"],
    ]) {
      assert.throws(() => parseLatencyArgs(argv), InputError, argv.join(" "));
    }
  });

  it("exit 2 with the usage before any AWS call; --help exits 0", () => {
    for (const argv of [[], ["warm", "--samples", "0"], ["idle", "--keep"]]) {
      const r = run(argv);
      assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /Usage:/);
    }
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: .*pnpm latency/);
  });
});

describe("idle", () => {
  it("waits 30 minutes after the last request", () => {
    assert.equal(idleWaitMs(T, T + 60_000), IDLE_MS - 60_000);
    assert.equal(idleWaitMs(T, T + IDLE_MS), 0);
    assert.equal(idleWaitMs(T, T + IDLE_MS + 1), 0);
  });

  it("refuses before 30 minutes, without any AWS call", () => {
    const home = mkdtempSync(join(tmpdir(), "latency-"));
    try {
      writeState(statePath(home), state({ lastRequestAt: Date.now() - 60_000 }));
      const r = run(["idle"], { HOME: home, ARTIFACT_TOKEN: "x" });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /wait 29 more minutes/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads Init Duration from REPORT lines", () => {
    assert.deepEqual(
      initDurations([
        { message: "START RequestId: a Version: $LATEST", timestamp: T },
        {
          message:
            "REPORT RequestId: a\tDuration: 12.00 ms\tBilled Duration: 13 ms\tMemory Size: 512 MB\tMax Memory Used: 90 MB\tInit Duration: 312.45 ms\t",
          timestamp: T,
        },
        { message: "REPORT RequestId: b\tDuration: 3.00 ms\t", timestamp: T },
      ]),
      [312.45, null],
    );
  });
});

describe("state file", () => {
  it("round-trips and names a missing file as bad input", () => {
    const home = mkdtempSync(join(tmpdir(), "latency-"));
    try {
      assert.throws(() => readState(statePath(home)), InputError);
      writeState(statePath(home), state());
      assert.deepEqual(readState(statePath(home)), state());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
