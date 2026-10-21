// The smoke test of a deployed stage (docs/decisions/0076, 0086), run by the owner from CloudShell
// after `cdk deploy`: every deployed acceptance criterion it can automate, as a table.
//   ARTIFACT_TOKEN=<token> pnpm smoke [--stage prod] [--view-only | --skip-view] [--keep]
// Exit 0 when nothing failed, 1 when a check failed, 2 on bad input.
import { randomUUID } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ListResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
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
  INIT_ERROR,
  type LogEvent,
  missingControls,
  parseRuntimeLine,
  runtimeVerdict,
  seenPairs,
} from "./lib/logs.ts";
import { matchOutputs, type OutputName, stackOutputs } from "./lib/outputs.ts";
import {
  cookieSegments,
  decodePayload,
  mintSession,
  parseSessionSecret,
  randomKey,
  randomKid,
  SESSION_COOKIE,
  type SessionSecret,
  TRANSACTION_COOKIE,
} from "./lib/session-cookie.ts";
import { Checks, exitCode, expect, renderTable } from "./lib/table.ts";
import {
  authorizeProblems,
  cookieValue,
  leaks,
  loginCookieKid,
  loginCookieOk,
  loginLocation,
  logoutCookieOk,
  setCookie,
  viewLineFor,
} from "./lib/view-checks.ts";

export const USAGE = `Usage: ARTIFACT_TOKEN=<token> pnpm smoke [options]

Checks a deployed stage: API version, publish and republish through the CLI, 401/403 guards,
file_path and size limits, MCP over HTTP, cookies absent from the logs, token create and
revoke, bucket access denials, and the runtime's SDK versions (S1-S19); then the viewing plane
(S20-S41): API DNS, sign-in redirects, minted session cookies, caching, cookies absent from
the viewing logs, login and logout cookies, traversal, hosts and the session keys. Minted
cookies and the session key are never printed.

Options:
  --stage <name>        Stage of lib/stages.ts (default prod)
  --construct-id <id>   Construct id of ArtifactHosting (default Artifacts)
  --view-only           Run S1 and the viewing checks S20-S41 only
  --skip-view           Run the M9 checks S1-S19 only
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
  viewOnly: boolean;
  skipView: boolean;
};

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  const { values } = parseOptions(argv, {
    stage: { type: "string" },
    "construct-id": { type: "string" },
    "skip-revoke-check": { type: "boolean" },
    keep: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    "view-only": { type: "boolean" },
    "skip-view": { type: "boolean" },
  });
  if (values["view-only"] && values["skip-view"]) {
    throw new InputError("--view-only and --skip-view exclude each other");
  }
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
    viewOnly: values["view-only"] === true,
    skipView: values["skip-view"] === true,
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

/** The outputs the viewing checks read (the eleven of ADR 0085 are all in `OUTPUT_NAMES`). */
const VIEW_OUTPUTS = [
  "ViewFunctionUrl",
  "ViewLogGroupName",
  "SessionSecretArn",
  "UserPoolClientId",
  "LoginDomainUrl",
] as const satisfies readonly OutputName[];

const VIEW_LOG_POLL_MS = 5_000;
const VIEW_RUNTIME_WAIT_MS = 60_000;
const KID_POLL_MS = 30_000;
/** The 5-minute key cache of the viewing Lambda, plus warm instances that refresh later. */
const KID_WAIT_MS = 360_000;
const SMOKE_EMAIL = "smoke@example.invalid";
const NAVIGATE = { accept: "text/html", "sec-fetch-mode": "navigate" };
const S35_403 =
  "403: blocked before the viewing code (OAC signing of encoded paths, F4 residual); report this row to the owner";
const S40_STOP =
  "STOP: CloudFront drops Set-Cookie for non-allowlisted names (F6); report to the owner";

async function readSessionSecret(region: string, arn: string): Promise<SessionSecret> {
  const { SecretString } = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  if (SecretString === undefined) throw new InputError("the session secret has no SecretString");
  return parseSessionSecret(SecretString);
}

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };

/**
 * One HTTPS request with `path` sent exactly as given: `fetch` would normalise `%2e%2e` and
 * fold the multiple `Set-Cookie` headers the checks read one by one.
 */
function request(
  host: string,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host, path, method: options.method ?? "GET", headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error(`timeout on ${host}${path}`)));
    req.on("error", reject);
    req.end();
  });
}

const setCookies = (r: RawResponse) => r.headers["set-cookie"] ?? [];
const headerOf = (r: RawResponse, name: string) => String(r.headers[name] ?? "-");
const versionOf = (body: string) => /data-version="(\d+)"/.exec(body)?.[1] ?? "none";
const withSession = (cookie: string, extra = "") => ({
  cookie: `${SESSION_COOKIE}=${cookie}${extra}`,
});

type ViewContext = {
  checks: Checks;
  http: Api;
  logs: CloudWatchLogsClient;
  out: Record<OutputName, string>;
  secret: SessionSecret;
  view: string;
  region: string;
  stage: string;
  /** Where the DNS stack (zone id output) lives. */
  dnsRegion: string;
  startedAt: number;
  created: string[];
};

/** S20–S41 (design §14): each check maps to one criterion of D1–D15. */
async function viewChecks(ctx: ViewContext): Promise<void> {
  const { checks, http, logs, out, secret, view, region } = ctx;
  const nowS = () => Math.floor(Date.now() / 1000);
  /** A fresh session cookie (its own `sub`), registered as a secret with both segments. */
  const mint = (opts: { kid?: string; key?: string; exp?: number } = {}) => {
    const kid = opts.kid ?? secret.current;
    const cookie = mintSession(opts.key ?? secret.keys[kid], kid, {
      sub: randomUUID(),
      email: SMOKE_EMAIL,
      iat: nowS(),
      exp: opts.exp ?? nowS() + 3600,
    });
    const { payload, signature } = cookieSegments(cookie);
    for (const value of [cookie, payload, signature]) checks.secret(value);
    return cookie;
  };
  const marker = () => {
    const value = randomUUID().replaceAll("-", "");
    checks.secret(value);
    return value;
  };
  const viewEvents = (since: number) => fetchEvents(logs, out.ViewLogGroupName, since);

  await checks.run("S20 API DNS", "D11", async () => {
    const apiName = `api.${view}`;
    const dnsStack = `artifact-${ctx.stage}-dns`;
    const zoneId = (await stackOutputs(ctx.dnsRegion, dnsStack)).find(
      (o) => o.OutputKey === "HostedZoneId",
    )?.OutputValue;
    expect(zoneId, `${dnsStack} has no HostedZoneId output`);
    const { ResourceRecordSets = [] } = await new Route53Client({ region: "us-east-1" }).send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        StartRecordName: apiName,
        MaxItems: 10,
      }),
    );
    const named = ResourceRecordSets.filter(
      (r) => r.Name?.toLowerCase().replace(/\.$/, "") === apiName,
    );
    const target = named.find((r) => r.Type === "A")?.AliasTarget?.DNSName?.toLowerCase() ?? "";
    const alias = new RegExp(`^[^.]+\\.execute-api\\.${region}\\.amazonaws\\.com\\.?$`);
    expect(alias.test(target), `api A alias ${target || "missing"}`);
    expect(!named.some((r) => r.Type === "AAAA"), "an AAAA record named api exists");
    const resolver = new Resolver({ timeout: 5000, tries: 2 });
    resolver.setServers(["1.1.1.1"]);
    const aaaa = await resolver.resolve6(apiName).then(
      (records) => `resolves to ${records.length} AAAA`,
      (error: { code?: string }) => error.code,
    );
    expect(aaaa === "ENODATA", `resolve6 ${apiName}: ${aaaa}`);
    const apex = await resolver.resolve4(view);
    expect(apex.length > 0, `resolve4 ${view}: no address`);
    return `A alias ${target}, no AAAA (ENODATA), apex resolves`;
  });

  // S21–S41 share the artifact P (index.html + style.css), published through the API.
  const publish = await http.call("POST", "/api/artifacts", {
    body: {
      title: "smoke view",
      files: {
        "index.html": `<!doctype html><title>smoke view</title><link rel="stylesheet" href="style.css"><p>v1</p>\n`,
        "style.css": `p { color: teal } /* ${randomUUID()} */\n`,
      },
    },
  });
  const id = typeof publish.json.id === "string" ? publish.json.id : undefined;
  if (id) ctx.created.push(id);
  const host = `${id}.${view}`;
  const current = `https://${host}/`;
  const needP = () => {
    expect(id, `publish P: HTTP ${publish.status}`);
    return id;
  };
  const cookie = mint();

  await checks.run("S21 no cookie page", "D1", async () => {
    needP();
    const r = await request(host, "/", { headers: NAVIGATE });
    const location = headerOf(r, "location");
    expect(r.status === 302, `HTTP ${r.status}`);
    expect(location === loginLocation(view, current), `location ${location}`);
    return "302 to login with the exact return";
  });
  await checks.run("S22 no cookie version", "D1", async () => {
    needP();
    const r = await request(host, "/__artifact/version", { headers: { accept: "*/*" } });
    expect(r.status === 401, `HTTP ${r.status}`);
    return "401";
  });
  await checks.run("S23 valid cookie", "D2", async () => {
    needP();
    const page = await request(host, "/", { headers: { ...NAVIGATE, ...withSession(cookie) } });
    expect(page.status === 200, `page HTTP ${page.status}`);
    expect(versionOf(page.body) === "1", `page data-version ${versionOf(page.body)}`);
    const gallery = await request(view, "/", { headers: { ...NAVIGATE, ...withSession(cookie) } });
    expect(
      gallery.status === 200 && headerOf(gallery, "content-type").startsWith("text/html"),
      `gallery HTTP ${gallery.status} ${headerOf(gallery, "content-type")}`,
    );
    const reload = await request(host, "/__artifact/reload.js", { headers: withSession(cookie) });
    expect(reload.status === 200, `reload.js HTTP ${reload.status}`);
    expect(reload.body.includes('transport: "none"'), 'reload.js lacks transport: "none"');
    return 'page v1, gallery HTML, reload.js transport "none"';
  });
  await checks.run("S24 HEAD", "D10", async () => {
    needP();
    const signed = await request(host, "/", { method: "HEAD", headers: withSession(cookie) });
    expect(signed.status === 200 && signed.body === "", `with cookie HTTP ${signed.status}`);
    const anonymous = await request(host, "/", { method: "HEAD" });
    expect(anonymous.status === 401, `without cookie HTTP ${anonymous.status}`);
    return "200 without a body; 401 without a cookie";
  });
  await checks.run("S25 fresh after publish", "D3", async () => {
    const pId = needP();
    const before = await request(host, "/", { headers: withSession(cookie) });
    expect(versionOf(before.body) === "1", `before: version ${versionOf(before.body)}`);
    const republish = await http.call("PUT", `/api/artifacts/${encodeURIComponent(pId)}`, {
      body: {
        files: {
          "index.html": `<!doctype html><title>smoke view</title><link rel="stylesheet" href="style.css"><p>v2</p>\n`,
          "style.css": `p { color: navy } /* ${randomUUID()} */\n`,
        },
      },
    });
    expect(republish.json.version === 2, `republish HTTP ${republish.status}`);
    const after = await request(host, "/", { headers: withSession(cookie) });
    const version = versionOf(after.body);
    expect(
      version === "2",
      `version ${version}, x-cache ${headerOf(after, "x-cache")}, age ${headerOf(after, "age")}`,
    );
    return "version 2 on the first GET";
  });
  const pinned = "/v/1/style.css";
  const hit = (r: RawResponse) => headerOf(r, "x-cache") === "Hit from cloudfront";
  await checks.run("S26 pinned hit", "D4", async () => {
    needP();
    let r = await request(host, pinned, { headers: withSession(cookie) });
    expect(r.status === 200, `HTTP ${r.status}`);
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await request(host, pinned, { headers: withSession(cookie) });
      if (hit(r)) break;
    }
    expect(hit(r), `x-cache ${headerOf(r, "x-cache")}`);
    const cacheControl = headerOf(r, "cache-control");
    expect(cacheControl.includes("immutable"), `cache-control ${cacheControl}`);
    return `Hit from cloudfront, ${cacheControl}`;
  });
  await checks.run("S27 cookie not in key", "D5 cache key", async () => {
    needP();
    const r = await request(host, pinned, { headers: withSession(mint()) });
    expect(hit(r), `another cookie: x-cache ${headerOf(r, "x-cache")}`);
    return "another cookie: Hit from cloudfront";
  });

  /** S28/S29: the control line appears with `cookies: 0`, and no needle is in any event. */
  const noCookieAtOrigin = async (
    path: string,
    send: (cookie: string, marker: string) => Promise<RawResponse>,
  ) => {
    const a = mint();
    const { payload, signature } = cookieSegments(a);
    const m = marker();
    const tA = Date.now();
    await send(a, m);
    let events: LogEvent[] = [];
    const seen = await poll(LOG_WAIT_MS, LOG_POLL_MS, async () => {
      events = await viewEvents(tA - 5000);
      return viewLineFor(events, path, tA);
    });
    expect(seen, `no access line for ${path} with cookies 0 within 120 s`);
    const found = leaks(events, {
      "cookie payload": payload,
      "cookie signature": signature,
      marker: m,
    });
    expect(found.length === 0, `in the viewing logs: ${found.join(", ")}`);
    return `absent from ${events.length} viewing events; control line seen`;
  };
  await checks.run("S28 cookie not at origin", "D5 origin", async () => {
    needP();
    const path = `/smokectl${randomUUID().replaceAll("-", "")}.html`;
    return noCookieAtOrigin(path, async (a, m) => {
      const r = await request(host, path, { headers: withSession(a, `; smoke_marker=${m}`) });
      expect(r.status === 404, `HTTP ${r.status}`);
      return r;
    });
  });
  await checks.run("S29 cookie not at origin on login", "D14", async () =>
    noCookieAtOrigin("/__artifact/login", (b, m) =>
      request(view, "/__artifact/login", { headers: withSession(b, `; smoke_marker=${m}`) }),
    ),
  );

  const toLogin = async (session: string) => {
    needP();
    const r = await request(host, "/", { headers: { ...NAVIGATE, ...withSession(session) } });
    const location = headerOf(r, "location");
    expect(
      r.status === 302 && location === loginLocation(view, current),
      `HTTP ${r.status}, location ${location}`,
    );
    return "302 to login";
  };
  await checks.run("S30 tampered", "D6", async () => {
    const { kid, payload, signature } = cookieSegments(mint());
    const flipped = (payload[0] === "e" ? "f" : "e") + payload.slice(1);
    const tampered = `v1.${kid}.${flipped}.${signature}`;
    checks.secret(tampered);
    return toLogin(tampered);
  });
  await checks.run("S31 expired", "D6", () => toLogin(mint({ exp: nowS() - 60 })));
  await checks.run("S32 unknown kid", "D6", async () => {
    const key = randomKey();
    checks.secret(key);
    return toLogin(mint({ kid: randomKid(), key }));
  });

  const login = (returnUrl: string) =>
    request(view, `/__artifact/login?return=${encodeURIComponent(returnUrl)}`);
  /** The transaction cookie of a login response, registered as a secret. */
  const transaction = (r: RawResponse) => {
    const header = setCookie(setCookies(r), TRANSACTION_COOKIE);
    if (header !== undefined) checks.secret(cookieValue(header));
    return header;
  };
  await checks.run("S33 login redirect", "D13", async () => {
    const r = await login(current);
    expect(r.status === 302, `HTTP ${r.status}`);
    const problems = authorizeProblems(headerOf(r, "location"), {
      loginDomainUrl: out.LoginDomainUrl,
      clientId: out.UserPoolClientId,
      view,
    });
    expect(problems.length === 0, `authorize URL: ${problems.join(", ")}`);
    expect(
      loginCookieOk(transaction(r)),
      `no ${TRANSACTION_COOKIE} with Secure, HttpOnly, Path=/, Max-Age=600`,
    );
    return "302 to the authorize URL with PKCE; transaction cookie through CloudFront";
  });
  await checks.run("S34 foreign return", "D6 return", async () => {
    const gallery = `https://${view}/`;
    for (const foreign of ["https://example.com/", `http://${host}/`]) {
      const header = transaction(await login(foreign));
      expect(header, `${foreign}: no transaction cookie`);
      const r = decodePayload(cookieValue(header))?.r;
      expect(r === gallery, `${foreign}: return ${String(r)}`);
    }
    return "both kept as the gallery";
  });
  await checks.run("S35 traversal", "D7", async () => {
    needP();
    const results: string[] = [];
    let blocked = false;
    for (const path of ["/x%2f..%2fy", "/..%5cx"]) {
      const r = await request(host, path, { headers: withSession(cookie) });
      results.push(`${path} ${r.status} ${JSON.stringify(r.body.slice(0, 100))}`);
      if (r.status === 403) blocked = true;
      else expect(r.status === 400, results.join("; "));
    }
    expect(!blocked, `${S35_403} (${results.join("; ")})`);
    return results.join("; ");
  });
  await checks.run("S36 unknown host", "D7", async () => {
    const r = await request(`notanartifactid.${view}`, "/", { headers: NAVIGATE });
    expect(r.status === 403 && r.body.includes("forbidden"), `HTTP ${r.status}`);
    return "403 forbidden";
  });
  await checks.run("S37 function URL direct", "D9", async () => {
    const r = await fetch(out.ViewFunctionUrl);
    expect(r.status === 403, `HTTP ${r.status}`);
    return "403";
  });
  if (secret.previous === undefined) {
    checks.add("S38 previous kid", "D15", "SKIP", "not rotated yet");
  } else {
    const previous = secret.previous;
    await checks.run("S38 previous kid", "D15", async () => {
      needP();
      for (const [name, kid] of [
        ["previous", previous],
        ["current", secret.current],
      ] as const) {
        const r = await request(host, "/", { headers: withSession(mint({ kid })) });
        expect(r.status === 200, `${name} kid ${kid}: HTTP ${r.status}`);
      }
      return `previous ${previous} and current ${secret.current} accepted`;
    });
  }
  await checks.run("S39 viewing runtime", "V2 residual", async () => {
    const verdict = await poll(VIEW_RUNTIME_WAIT_MS, VIEW_LOG_POLL_MS, async () => {
      const v = runtimeVerdict(await viewEvents(ctx.startedAt - 24 * 3600_000));
      return v.status === "wait" ? undefined : v;
    });
    expect(verdict, "no artifact runtime line");
    expect(verdict.status === "pass", verdict.status === "fail" ? verdict.detail : "");
    return `node ${verdict.info.node}, package ${verdict.info.package}`;
  });
  await checks.run("S40 logout Set-Cookie", "D13 F6 residual", async () => {
    const r = await request(view, "/__artifact/logout", { headers: withSession(mint()) });
    expect(
      r.status === 302 && logoutCookieOk(setCookies(r), view),
      `${S40_STOP} (HTTP ${r.status})`,
    );
    return `302, ${SESSION_COOKIE} cleared on ${view}`;
  });
  await checks.run("S41 new kid signs", "D15 new kid", async () => {
    let signed: string | undefined;
    const ok = await poll(KID_WAIT_MS, KID_POLL_MS, async () => {
      const r = await request(view, "/__artifact/login");
      transaction(r);
      signed = loginCookieKid(setCookies(r));
      return signed === secret.current ? true : undefined;
    });
    expect(ok, `signed kid ${signed ?? "none"}, secret current ${secret.current}`);
    return `signed with the current kid ${secret.current}`;
  });
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
  const needed: OutputName[] = ["ApiUrl"];
  if (!args.viewOnly) {
    needed.push("TokenSecretArn", "BucketName", "ControlLogGroupName", "AccessLogGroupName");
  }
  if (!args.skipView) needed.push(...VIEW_OUTPUTS);
  const out = matchOutputs(await stackOutputs(region, stackName), args.constructId, needed);
  const startedAt = Date.now();
  const checks = new Checks();
  checks.secret(token);
  const secret = args.skipView ? undefined : await readSessionSecret(region, out.SessionSecretArn);
  for (const key of Object.values(secret?.keys ?? {})) checks.secret(key);
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

  // S2–S19 are the M9 checks; --view-only skips them.
  const smokeName = `smoke-${Date.now()}`;
  let smokeToken: string | undefined;
  let revoked = false;
  if (!args.viewOnly) {
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
        expect(
          r.isError && r.value.error === "invalid_input",
          `tool result ${r.text.slice(0, 200)}`,
        );
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
      const failure = events.find((e) => INIT_ERROR.test(e.message));
      expect(!failure, `init error: ${failure?.message.trim().slice(0, 300)}`);
      const info = events
        .map((e) => parseRuntimeLine(e.message))
        .filter((i) => i !== undefined)
        .pop();
      expect(info, "no artifact runtime line in the last 24 h");
      return `node ${info.node}, client-s3 ${info.clientS3}, client-secrets-manager ${info.clientSecretsManager}`;
    });
  }

  if (secret) {
    await viewChecks({
      checks,
      http,
      logs,
      out,
      secret,
      view: viewDomain,
      region,
      stage: args.stage,
      dnsRegion: config.certificateRegion,
      startedAt,
      created,
    });
  }

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
