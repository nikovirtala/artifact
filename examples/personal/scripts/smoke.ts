// The M9 smoke test of a deployed stage (docs/decisions/0076), run by the owner from CloudShell
// after `cdk deploy`: every deployed acceptance criterion it can automate, as a table.
//   ARTIFACT_TOKEN=<token> pnpm smoke [--stage prod] [--skip-revoke-check] [--keep]
// Exit 0 when nothing failed, 1 when a check failed, 2 on bad input.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CONTROL_ROUTE_KEYS } from "@nikovirtala/artifact/cdk";
import { stages } from "../lib/stages.ts";
import { artifact, InputError, parseOptions, REPO, runScript, sleep } from "./lib/cli.ts";
import {
  containing,
  fetchEvents,
  findRequestLine,
  type LogEvent,
  missingControls,
  parseRuntimeLine,
  seenPairs,
} from "./lib/logs.ts";
import { matchOutputs, stackOutputs } from "./lib/outputs.ts";
import { Checks, exitCode, expect, renderTable } from "./lib/table.ts";

export const USAGE = `Usage: ARTIFACT_TOKEN=<token> pnpm smoke [options]

Checks a deployed stage: API version, publish and republish through the CLI, 401/403 guards,
file_path and size limits, MCP over HTTP, cookies absent from the logs, token create and
revoke, bucket access denials, and the runtime's SDK versions.

Options:
  --stage <name>        Stage of lib/stages.ts (default prod)
  --construct-id <id>   Construct id of ArtifactHosting (default Artifacts)
  --skip-revoke-check   Skip the up-to-5-minute revocation check (reported as SKIP)
  --keep                Keep the smoke artifacts and token
  -h, --help            Show this help
`;

export type SmokeArgs = {
  stage: string;
  constructId: string;
  skipRevokeCheck: boolean;
  keep: boolean;
  help: boolean;
};

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  const { values } = parseOptions(argv, {
    stage: { type: "string" },
    "construct-id": { type: "string" },
    "skip-revoke-check": { type: "boolean" },
    keep: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  const stage = values.stage ?? "prod";
  if (!values.help && !Object.hasOwn(stages, stage)) {
    throw new InputError(
      `unknown stage ${JSON.stringify(stage)}; known: ${Object.keys(stages).join(", ")}`,
    );
  }
  return {
    stage,
    constructId: values["construct-id"] ?? "Artifacts",
    skipRevokeCheck: values["skip-revoke-check"] === true,
    keep: values.keep === true,
    help: values.help === true,
  };
}

const MIB = 1024 * 1024;
const TOKEN_POLL_MS = 15_000;
/** Warm instances refresh the token list within 5 minutes (ADR 0065), plus one poll. */
const TOKEN_WAIT_MS = 315_000;
const LOG_POLL_MS = 10_000;
const LOG_WAIT_MS = 120_000;

type Api = {
  url: string;
  call(
    method: string,
    path: string,
    options?: { token?: string | null; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; json: Record<string, unknown> }>;
};

function api(url: string, token: string): Api {
  return {
    url,
    async call(method, path, options = {}) {
      const bearer = options.token === undefined ? token : options.token;
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 200) };
      }
      return { status: response.status, json };
    },
  };
}

async function mcpClient(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "artifact-smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return {
    isError: result.isError === true,
    value: (result.structuredContent ?? {}) as Record<string, unknown>,
    text: JSON.stringify(result.content),
  };
}

/** Poll `fn` every `every` ms until it returns a value or `within` ms pass. */
async function poll<T>(within: number, every: number, fn: () => Promise<T | undefined>) {
  const deadline = Date.now() + within;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() + every > deadline) return undefined;
    await sleep(every);
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseSmokeArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const token = process.env.ARTIFACT_TOKEN;
  if (!token) throw new InputError("set ARTIFACT_TOKEN to an API token of the stage");
  const config = stages[args.stage];
  const { region, viewDomain } = config;
  const stackName = `artifact-${args.stage}-platform`;
  const out = matchOutputs(await stackOutputs(region, stackName), args.constructId, [
    "ApiUrl",
    "TokenSecretArn",
    "BucketName",
    "ControlLogGroupName",
    "AccessLogGroupName",
  ]);
  const startedAt = Date.now();
  const checks = new Checks();
  checks.secret(token);
  const http = api(out.ApiUrl, token);
  const logs = new CloudWatchLogsClient({ region });
  const env = { ARTIFACT_TOKEN: token, ARTIFACT_SERVER: out.ApiUrl };
  const created: string[] = [];
  const work = mkdtempSync(join(tmpdir(), "artifact-smoke-"));
  const repoVersion = (
    JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }
  ).version;
  console.log(`smoke: ${stackName} in ${region}, API ${out.ApiUrl}`);

  await checks.run("S1 GET /api", "GET /api {version}", async () => {
    const { status, json } = await http.call("GET", "/api");
    expect(status === 200, `HTTP ${status}`);
    const version = String(json.version);
    expect(
      version.split(".")[0] === repoVersion.split(".")[0],
      `server ${version}, repo ${repoVersion}`,
    );
    return `version ${version}`;
  });

  // S2/S3: publish through the CLI; the JSON publish also feeds S9.
  const page = join(work, "page.html");
  writeFileSync(page, `<!doctype html><title>smoke</title><p>smoke ${randomUUID()}</p>\n`);
  let id: string | undefined;
  const t2 = Date.now();
  await checks.run("S2 publish", "C6", async () => {
    const r = artifact(
      ["publish", page, "--server", out.ApiUrl, "--json", "--no-open", "--no-project"],
      env,
    );
    expect(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
    const body = JSON.parse(r.stdout) as { id: string; version: number; url: string };
    id = body.id;
    created.push(id);
    expect(body.version === 1, `version ${body.version}`);
    expect(body.url === `https://${body.id}.${viewDomain}/`, `url ${body.url}`);
    return `${body.id} v1 ${body.url}`;
  });
  await checks.run("S3 republish", "C6", async () => {
    expect(id, "no artifact from S2");
    const r = artifact(
      ["publish", page, "--id", id, "--server", out.ApiUrl, "--json", "--no-open"],
      env,
    );
    expect(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
    const { version } = JSON.parse(r.stdout) as { version: number };
    expect(version === 2, `version ${version}`);
    return "version 2";
  });

  await checks.run("S4 no token", "C8 401", async () => {
    const { status, json } = await http.call("GET", "/api/artifacts", { token: null });
    expect(status === 401 && json.error === "unauthorized", `HTTP ${status} ${json.error}`);
    return "401 unauthorized";
  });
  await checks.run("S5 wrong token", "C8 401", async () => {
    const { status, json } = await http.call("GET", "/api/artifacts", {
      token: `art_${randomUUID()}`,
    });
    expect(status === 401 && json.error === "unauthorized", `HTTP ${status} ${json.error}`);
    return "401 unauthorized";
  });
  await checks.run("S6 Origin", "C8 403", async () => {
    const { status, json } = await http.call("GET", "/api/artifacts", {
      headers: { origin: "https://example.com" },
    });
    expect(status === 403 && json.error === "forbidden", `HTTP ${status} ${json.error}`);
    return "403 forbidden";
  });
  await checks.run("S7 file_path", "C8 invalid_input", async () => {
    const client = await mcpClient(out.ApiUrl, token);
    try {
      const r = await tool(client, "artifact_publish", { file_path: "/etc/hostname" });
      expect(r.isError && r.value.error === "invalid_input", `tool result ${r.text.slice(0, 200)}`);
      return "tool error invalid_input";
    } finally {
      await client.close();
    }
  });
  await checks.run("S8 3.5 MiB file", "C8 too_large (ADR 0066)", async () => {
    const { status, json } = await http.call("POST", "/api/artifacts", {
      body: { files: { "index.html": "x".repeat(3.5 * MIB) } },
    });
    expect(
      status === 413 &&
        json.error === "too_large" &&
        json.subject === "file" &&
        json.limit === 3_145_728,
      `HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`,
    );
    return "413 too_large file 3145728";
  });

  await checks.run("S9 request shape", "V3 follow-up", async () => {
    const line = await poll(LOG_WAIT_MS, LOG_POLL_MS, async () =>
      findRequestLine(
        await fetchEvents(logs, out.ControlLogGroupName, startedAt),
        CONTROL_ROUTE_KEYS.apiProxy,
        t2,
      ),
    );
    expect(line, "no artifact request line for the JSON publish within 120 s");
    return `isBase64Encoded ${line.isBase64Encoded}, contentType ${line.contentType}`;
  });

  await checks.run("S11 MCP", "C7", async () => {
    const client = await mcpClient(out.ApiUrl, token);
    try {
      const v1 = await tool(client, "artifact_publish", {
        files: { "index.html": "<p>mcp 1</p>" },
      });
      expect(!v1.isError, `publish ${v1.text.slice(0, 200)}`);
      const mcpId = String(v1.value.id);
      created.push(mcpId);
      await tool(client, "artifact_publish", {
        id: mcpId,
        files: { "index.html": "<p>mcp 2</p>" },
      });
      const listed = await tool(client, "artifact_list", { all: true });
      expect(
        listed.text.includes(mcpId) || JSON.stringify(listed.value).includes(mcpId),
        "list misses it",
      );
      const read = await tool(client, "artifact_read", { id: mcpId });
      expect(read.text.includes("<p>mcp 2</p>"), "read content differs");
      const rolled = await tool(client, "artifact_rollback", { id: mcpId, version: 1 });
      expect(
        !rolled.isError && rolled.value.version === 1,
        `rollback ${rolled.text.slice(0, 200)}`,
      );
      return `${mcpId}: publish, list, read, rollback to 1`;
    } finally {
      await client.close();
    }
  });

  await checks.run("S12 no cookie in logs", "C2", async () => {
    const marker = `smoke-${randomUUID()}`;
    const pathMarker = `smokectl${randomUUID().replaceAll("-", "")}`;
    checks.secret(marker);
    const cookie = { cookie: `__Secure-artifact_session=${marker}` };
    const mcpHeaders = { ...cookie, accept: "application/json, text/event-stream" };
    const tA = Date.now();
    await http.call("GET", `/api/artifacts/${pathMarker}`, { headers: cookie });
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    };
    await http.call("POST", "/mcp", { body: init, headers: mcpHeaders });
    await http.call("POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      headers: mcpHeaders,
    });
    const c = await http.call("POST", "/api/artifacts", {
      body: { files: { "index.html": "<p>cookie</p>" } },
      headers: cookie,
    });
    if (typeof c.json.id === "string") created.push(c.json.id);
    const controls = {
      pathMarker,
      mcpRouteKey: CONTROL_ROUTE_KEYS.mcp,
      apiProxyRouteKey: CONTROL_ROUTE_KEYS.apiProxy,
    };
    let access: LogEvent[] = [];
    let control: LogEvent[] = [];
    let missing: string[] = [];
    const ready = await poll(LOG_WAIT_MS, LOG_POLL_MS, async () => {
      access = await fetchEvents(logs, out.AccessLogGroupName, startedAt);
      control = await fetchEvents(logs, out.ControlLogGroupName, startedAt);
      missing = missingControls(access, control, controls, tA);
      return missing.length === 0 ? true : undefined;
    });
    if (!ready) {
      throw new Error(
        `logs not delivered: missing ${missing.join("; ")}; access saw ${seenPairs(access, "access", tA).join(", ")}; control saw ${seenPairs(control, "control", tA).join(", ")}`,
      );
    }
    const leaks = containing([...access, ...control], marker).length;
    expect(leaks === 0, `the cookie marker is in ${leaks} log events`);
    return `marker absent from ${access.length} access and ${control.length} control events; controls seen`;
  });

  // S13/S14: a fresh token works, then stops after revoke.
  const smokeName = `smoke-${Date.now()}`;
  let smokeToken: string | undefined;
  let revoked = false;
  await checks.run("S13 token create", "C9", async () => {
    const r = artifact(
      ["token", "create", smokeName, "--secret", out.TokenSecretArn, "--json"],
      {},
    );
    expect(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
    smokeToken = (JSON.parse(r.stdout) as { token: string }).token;
    checks.secret(smokeToken);
    const fresh = smokeToken;
    const ok = await poll(TOKEN_WAIT_MS, TOKEN_POLL_MS, async () =>
      (await http.call("GET", "/api", { token: fresh })).status === 200 ? true : undefined,
    );
    expect(ok, "the new token got no 200 from GET /api within 315 s");
    return `${smokeName} answers GET /api`;
  });
  if (args.skipRevokeCheck) {
    checks.add("S14 token revoke", "C9", "SKIP", "--skip-revoke-check: pending");
  } else {
    await checks.run("S14 token revoke", "C9", async () => {
      expect(smokeToken, "no token from S13");
      const r = artifact(["token", "revoke", smokeName, "--secret", out.TokenSecretArn], {});
      expect(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
      revoked = true;
      const started = Date.now();
      const old = smokeToken;
      const stopped = await poll(TOKEN_WAIT_MS, TOKEN_POLL_MS, async () =>
        (await http.call("GET", "/api", { token: old })).status === 401 ? true : undefined,
      );
      expect(stopped, "the revoked token still worked after 315 s");
      return `401 after ${Math.round((Date.now() - started) / 1000)} s`;
    });
  }

  const bucketHost = `${out.BucketName}.s3.${region}.amazonaws.com`;
  for (const [check, scheme] of [
    ["S15 unsigned https", "https"],
    ["S16 unsigned http", "http"],
  ] as const) {
    await checks.run(check, "C10", async () => {
      const response = await fetch(`${scheme}://${bucketHost}/?list-type=2`);
      expect(response.status === 403, `HTTP ${response.status}`);
      return "403";
    });
  }
  const list = (endpoint: string) =>
    new S3Client({ region, endpoint, forcePathStyle: true }).send(
      new ListObjectsV2Command({ Bucket: out.BucketName, MaxKeys: 1 }),
    );
  await checks.run("S17 signed http", "C10 TLS deny", async () => {
    try {
      await list(`http://s3.${region}.amazonaws.com`);
    } catch (error) {
      const { name, $metadata } = error as {
        name: string;
        $metadata?: { httpStatusCode?: number };
      };
      expect(
        $metadata?.httpStatusCode === 403 && name === "AccessDenied",
        `${name} ${$metadata?.httpStatusCode}`,
      );
      return "403 AccessDenied";
    }
    throw new Error("signed ListObjectsV2 over http succeeded");
  });
  await checks.run("S18 signed https", "C10 control", async () => {
    const { $metadata } = await list(`https://s3.${region}.amazonaws.com`);
    expect($metadata.httpStatusCode === 200, `HTTP ${$metadata.httpStatusCode}`);
    return "200 (so S17 is the TLS deny, not missing permissions)";
  });

  await checks.run("S19 runtime SDK", "V2 residual", async () => {
    const events = await fetchEvents(logs, out.ControlLogGroupName, startedAt - 24 * 3600_000);
    const failure = events.find((e) =>
      /Runtime\.ImportModuleError|ERR_MODULE_NOT_FOUND|Cannot find package '@aws-sdk/.test(
        e.message,
      ),
    );
    expect(!failure, `init error: ${failure?.message.trim().slice(0, 300)}`);
    const info = events
      .map((e) => parseRuntimeLine(e.message))
      .filter((i) => i !== undefined)
      .pop();
    expect(info, "no artifact runtime line in the last 24 h");
    return `node ${info.node}, client-s3 ${info.clientS3}, client-secrets-manager ${info.clientSecretsManager}`;
  });

  if (!args.keep) {
    for (const artifactId of created) {
      await http
        .call("DELETE", `/api/artifacts/${encodeURIComponent(artifactId)}`)
        .catch(() => undefined);
    }
    if (smokeToken && !revoked) {
      artifact(["token", "revoke", smokeName, "--secret", out.TokenSecretArn], {});
    }
  }
  rmSync(work, { recursive: true, force: true });

  process.stdout.write(`\n${renderTable(checks.rows)}`);
  return exitCode(checks.rows);
}

if (import.meta.main) await runScript(USAGE, () => main(process.argv.slice(2)));
