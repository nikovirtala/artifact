// Serving latency of the viewing plane (design §15, docs/decisions/0086), recorded for ADR 0087,
// not gated. Three phases, because CloudShell may end an idle session:
//   ARTIFACT_TOKEN=<token> pnpm latency warm [--samples 20]   publish H and T, measure warm
//   pnpm latency idle                                          ≥ 30 min later: one cold round
//   ARTIFACT_TOKEN=<token> pnpm latency report [--keep]        print the table, delete H and T
// The state file holds ids, timestamps and results only; the minted cookie is never printed.
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import {
  CloudFrontClient,
  DescribeFunctionCommand,
  TestFunctionCommand,
} from "@aws-sdk/client-cloudfront";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { stages } from "../lib/stages.ts";
import { InputError, runScript } from "./lib/cli.ts";
import {
  type Connect,
  idleWaitMs,
  initDurations,
  type LatencyState,
  type PageTimes,
  parseLatencyArgs,
  readState,
  renderLatencyTable,
  statePath,
  writeState,
} from "./lib/latency-stats.ts";
import { fetchEvents } from "./lib/logs.ts";
import { matchOutputs, stackOutputs } from "./lib/outputs.ts";
import { mintSession, parseSessionSecret, SESSION_COOKIE } from "./lib/session-cookie.ts";
import { Checks, exitCode, renderTable } from "./lib/table.ts";

export const USAGE = `Usage: pnpm latency <warm|idle|report> [options]

Measures the viewing plane's time to first byte from this machine (run it in eu-north-1):
  warm     publish H (one HTML page) and T (index.html + 10 assets), then measure warm HTML,
           the 10-asset page, pinned /v/1/ and the edge function's compute utilization
  idle     at least 30 minutes after warm (or the last idle): one cold round on fresh
           connections, with the viewing function's Init Duration
  report   print the Markdown table to paste back, then delete H and T

Needs ARTIFACT_TOKEN for warm and report. The state is $HOME/.artifact-latency.json.

Options:
  --samples <n>         warm: requests per case (default 20)
  --keep                report: keep H, T and the state file
  --stage <name>        Stage of lib/stages.ts (default prod)
  --construct-id <id>   Construct id of ArtifactHosting (default Artifacts)
  -h, --help            Show this help
`;

const ASSET_CONCURRENCY = 6;
const KIB = 1024;

type Timed = {
  status: number;
  ttfb: number;
  total: number;
  headers: Record<string, string | string[] | undefined>;
  connect?: Connect;
};

/** One GET; TTFB = request written → first response byte, so DNS/TCP/TLS are excluded. */
function timedGet(agent: Agent, host: string, path: string, cookie: string): Promise<Timed> {
  return new Promise((resolve, reject) => {
    const created = performance.now();
    const marks: Record<string, number> = {};
    let written = created;
    const req = httpsRequest(
      { host, path, agent, headers: { cookie: `${SESSION_COOKIE}=${cookie}`, accept: "*/*" } },
      (res) => {
        const first = performance.now();
        res.resume();
        res.on("error", reject);
        res.on("end", () => {
          const connect =
            marks.secure === undefined
              ? undefined
              : {
                  dns: (marks.lookup ?? created) - created,
                  tcp: marks.connect - (marks.lookup ?? created),
                  tls: marks.secure - marks.connect,
                };
          resolve({
            status: res.statusCode ?? 0,
            ttfb: first - written,
            total: performance.now() - created,
            headers: res.headers,
            connect,
          });
        });
      },
    );
    req.on("socket", (socket) => {
      socket.once("lookup", () => {
        marks.lookup = performance.now();
      });
      socket.once("connect", () => {
        marks.connect = performance.now();
      });
      socket.once("secureConnect", () => {
        marks.secure = performance.now();
      });
    });
    req.on("finish", () => {
      written = performance.now();
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout on ${host}${path}`)));
    req.on("error", reject);
    req.end();
  });
}

const freshAgent = () => new Agent({ keepAlive: true, maxSockets: ASSET_CONCURRENCY });
const kib = (n: number) => "x".repeat(n * KIB);

/** H: one 20 KB page. T: index.html + 4 CSS, 4 JS, 2 PNG of 2–30 KB. */
function artifacts() {
  const css = [2, 8, 16, 30].map((size, i) => [`s${i}.css`, `/* ${kib(size)} */`] as const);
  const js = [4, 10, 20, 30].map((size, i) => [`a${i}.js`, `// ${kib(size)}\n`] as const);
  const png = [6, 24].map((size, i) => {
    const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(size * KIB)]);
    return [`i${i}.png`, { base64: bytes.toString("base64") }] as const;
  });
  const assets = [...css, ...js, ...png].map(([name]) => name);
  const index = `<!doctype html><title>latency T</title>${css
    .map(([n]) => `<link rel="stylesheet" href="${n}">`)
    .join("")}${js.map(([n]) => `<script src="${n}" defer></script>`).join("")}${png
    .map(([n]) => `<img src="${n}" alt="">`)
    .join("")}\n`;
  return {
    h: { "index.html": `<!doctype html><title>latency H</title><p>${kib(20)}</p>\n` },
    t: { "index.html": index, ...Object.fromEntries([...css, ...js, ...png]) },
    assets,
  };
}

async function apiCall(
  apiUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return json;
}

async function mintCookie(region: string, arn: string, checks: Checks): Promise<string> {
  const { SecretString } = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  if (SecretString === undefined) throw new InputError("the session secret has no SecretString");
  const secret = parseSessionSecret(SecretString);
  for (const key of Object.values(secret.keys)) checks.secret(key);
  const now = Math.floor(Date.now() / 1000);
  const cookie = mintSession(secret.keys[secret.current], secret.current, {
    sub: randomUUID(),
    email: "latency@example.invalid",
    iat: now,
    exp: now + 3 * 3600,
  });
  checks.secret(cookie);
  return cookie;
}

/** One round of T: the HTML, then the 10 assets on at most 6 connections. */
async function pageRound(agent: Agent, host: string, assets: readonly string[], cookie: string) {
  const start = performance.now();
  const html = await timedGet(agent, host, "/", cookie);
  const rest = await Promise.all(assets.map((a) => timedGet(agent, host, `/${a}`, cookie)));
  return {
    html: html.ttfb,
    slowest: Math.max(...rest.map((r) => r.ttfb)),
    complete: performance.now() - start,
  };
}

const push = (times: PageTimes, round: { html: number; slowest: number; complete: number }) => {
  times.html.push(round.html);
  times.slowest.push(round.slowest);
  times.complete.push(round.complete);
};

async function warm(stage: string, constructId: string, samples: number, checks: Checks) {
  const token = process.env.ARTIFACT_TOKEN;
  if (!token) throw new InputError("set ARTIFACT_TOKEN to an API token of the stage");
  const { region, viewDomain } = stages[stage];
  const out = matchOutputs(await stackOutputs(region, `artifact-${stage}-platform`), constructId, [
    "ApiUrl",
    "SessionSecretArn",
    "ViewLogGroupName",
    "ViewerRequestFunctionName",
  ]);
  checks.secret(token);
  const cookie = await mintCookie(region, out.SessionSecretArn, checks);
  const { h, t, assets } = artifacts();
  const hId = String(
    (await apiCall(out.ApiUrl, token, "POST", "/api/artifacts", { title: "latency H", files: h }))
      .id,
  );
  const tId = String(
    (await apiCall(out.ApiUrl, token, "POST", "/api/artifacts", { title: "latency T", files: t }))
      .id,
  );
  const state: LatencyState = {
    version: 1,
    stage,
    apiUrl: out.ApiUrl,
    sessionSecretArn: out.SessionSecretArn,
    viewLogGroupName: out.ViewLogGroupName,
    h: hId,
    t: tId,
    lastRequestAt: Date.now(),
    pop: "-",
    warm: { html: [], page: { html: [], slowest: [], complete: [] }, pinned: [], pinnedHits: 0 },
    edge: {},
    idle: { html: [], page: { html: [], slowest: [], complete: [] }, init: [] },
  };
  const hHost = `${hId}.${viewDomain}`;
  const tHost = `${tId}.${viewDomain}`;
  const agent = freshAgent();
  try {
    await checks.run("HTML warm", "D12", async () => {
      const first = await timedGet(agent, hHost, "/", cookie);
      if (first.status !== 200) throw new Error(`H: HTTP ${first.status}`);
      state.firstConnect = first.connect;
      state.pop = String(first.headers["x-amz-cf-pop"] ?? "-");
      for (let i = 0; i < samples; i++)
        state.warm.html.push((await timedGet(agent, hHost, "/", cookie)).ttfb);
      return `${samples} samples, POP ${state.pop}`;
    });
    await checks.run("10-asset page warm", "D12", async () => {
      for (let i = 0; i < samples; i++)
        push(state.warm.page, await pageRound(agent, tHost, assets, cookie));
      return `${samples} rounds`;
    });
    await checks.run("pinned /v/1/", "D12", async () => {
      for (let i = 0; i < 2; i++) await timedGet(agent, hHost, "/v/1/", cookie);
      for (let i = 0; i < samples; i++) {
        const r = await timedGet(agent, hHost, "/v/1/", cookie);
        state.warm.pinned.push(r.ttfb);
        if (r.headers["x-cache"] === "Hit from cloudfront") state.warm.pinnedHits++;
      }
      return `x-cache hits ${state.warm.pinnedHits}/${samples}`;
    });
  } finally {
    state.lastRequestAt = Date.now();
    agent.destroy();
  }
  // Edge compute (design-review NIT 3): TestFunction needs the LIVE stage's ETag as IfMatch.
  // The number is recorded, not gated, so an error becomes "—" and its name.
  const event = JSON.stringify({
    version: "1.0",
    context: { eventType: "viewer-request" },
    viewer: { ip: "198.51.100.1" },
    request: {
      method: "GET",
      uri: "/",
      querystring: {},
      headers: { host: { value: hHost }, accept: { value: "text/html" } },
      cookies: { [SESSION_COOKIE]: { value: cookie } },
    },
  });
  checks.secret(event);
  try {
    const cloudfront = new CloudFrontClient({ region: "us-east-1" });
    const name = out.ViewerRequestFunctionName;
    const { ETag } = await cloudfront.send(
      new DescribeFunctionCommand({ Name: name, Stage: "LIVE" }),
    );
    const { TestResult } = await cloudfront.send(
      new TestFunctionCommand({
        Name: name,
        IfMatch: ETag,
        Stage: "LIVE",
        EventObject: new TextEncoder().encode(event),
      }),
    );
    state.edge = { utilization: Number(TestResult?.ComputeUtilization) };
    checks.add("edge compute", "D12", "PASS", `${state.edge.utilization} %`);
  } catch (error) {
    state.edge = { error: (error as Error).name };
    checks.add("edge compute", "D12", "SKIP", `— ${state.edge.error}`);
  }
  return state;
}

async function idle(state: LatencyState, checks: Checks) {
  const { region, viewDomain } = stages[state.stage];
  const cookie = await mintCookie(region, state.sessionSecretArn, checks);
  const t0 = Date.now();
  const { assets } = artifacts();
  await checks.run("HTML idle", "D12", async () => {
    const agent = freshAgent();
    try {
      const r = await timedGet(agent, `${state.h}.${viewDomain}`, "/", cookie);
      if (r.status !== 200) throw new Error(`H: HTTP ${r.status}`);
      state.idle.html.push(r.ttfb);
      return `${Math.round(r.ttfb)} ms`;
    } finally {
      agent.destroy();
    }
  });
  await checks.run("10-asset page idle", "D12", async () => {
    const agent = freshAgent();
    try {
      push(state.idle.page, await pageRound(agent, `${state.t}.${viewDomain}`, assets, cookie));
      return "1 round";
    } finally {
      agent.destroy();
    }
  });
  state.lastRequestAt = Date.now();
  await checks.run("Init Duration", "D12", async () => {
    const logs = new CloudWatchLogsClient({ region });
    let durations: (number | null)[] = [];
    for (let attempt = 0; attempt < 12 && durations.length === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 10_000));
      durations = initDurations(await fetchEvents(logs, state.viewLogGroupName, t0 - 5000));
    }
    const cold = durations.filter((d) => d !== null);
    const init = cold.length === 0 ? null : Math.max(...cold);
    state.idle.init.push(init);
    return init === null ? "warm (no Init Duration)" : `${init} ms`;
  });
}

async function main(argv: string[]): Promise<number> {
  const args = parseLatencyArgs(argv);
  if (args.help || args.phase === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }
  const path = statePath();
  const checks = new Checks();
  if (args.phase === "warm") {
    writeState(path, await warm(args.stage, args.constructId, args.samples, checks));
    process.stdout.write(
      `${renderTable(checks.rows)}\nNow wait at least 30 minutes, then run pnpm latency idle.\n`,
    );
    return exitCode(checks.rows);
  }
  const state = readState(path);
  if (args.phase === "idle") {
    const wait = idleWaitMs(state.lastRequestAt, Date.now());
    if (wait > 0) {
      throw new InputError(
        `wait ${Math.ceil(wait / 60_000)} more minutes without opening the viewing plane`,
      );
    }
    await idle(state, checks);
    writeState(path, state);
    process.stdout.write(renderTable(checks.rows));
    return exitCode(checks.rows);
  }
  process.stdout.write(renderLatencyTable(state));
  if (!args.keep) {
    const token = process.env.ARTIFACT_TOKEN;
    if (!token) throw new InputError("set ARTIFACT_TOKEN to delete H and T (or pass --keep)");
    for (const id of [state.h, state.t]) {
      await apiCall(state.apiUrl, token, "DELETE", `/api/artifacts/${encodeURIComponent(id)}`);
    }
    rmSync(path, { force: true });
  }
  return 0;
}

if (import.meta.main) await runScript(USAGE, () => main(process.argv.slice(2)));
