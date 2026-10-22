// The pure parts of the smoke, retention and DNS scripts (docs/decisions/0076); no AWS calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CONTROL_ROUTE_KEYS } from "@nikovirtala/artifact/cdk";
import { dnsErrorDetail, normaliseNs, parseDnsArgs, sameNs } from "../scripts/check-dns.ts";
import { InputError } from "../scripts/lib/cli.ts";
import {
  containing,
  fetchEvents,
  findRequestLine,
  type LogEvent,
  MAX_PAGES,
  missingControls,
  parseAccessLine,
  parseRequestLine,
  parseRuntimeLine,
  postTo,
  runtimeVerdict,
  seenPairs,
} from "../scripts/lib/logs.ts";
import { matchOutputs, OUTPUT_NAMES } from "../scripts/lib/outputs.ts";
import { Checks, exitCode, redact, renderTable } from "../scripts/lib/table.ts";
import {
  bucketResult,
  parseRetentionArgs,
  parseScheduleInput,
} from "../scripts/retention-check.ts";
import { parseSmokeArgs } from "../scripts/smoke.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const T = 1_760_954_400_000;
const ev = (message: string, timestamp = T): LogEvent => ({ message, timestamp });

/** An access-log line with every key of the construct's format. */
function accessLine(fields: Record<string, string>): string {
  return JSON.stringify({
    requestId: "x",
    time: String(T),
    method: "GET",
    path: "/api",
    routeKey: "ANY /api",
    protocol: "HTTP/1.1",
    status: "200",
    responseLength: "10",
    latency: "5",
    integrationLatency: "4",
    integrationStatus: "200",
    integrationError: "-",
    error: "-",
    sourceIp: "192.0.2.1",
    domain: "api.example.dev",
    ...fields,
  });
}

const requestLine = (method: string, routeKey: string) =>
  `artifact request {"requestId":"x","method":"${method}","routeKey":"${routeKey}","contentType":"application/json","isBase64Encoded":false,"bodyLength":42}`;

describe("stack outputs", () => {
  const outputs = [
    { OutputKey: "ArtifactsApiUrlDB84C18F", OutputValue: "https://api.example.dev" },
    { OutputKey: "ArtifactsBucketNameA6BBDB86", OutputValue: "b" },
    { OutputKey: "OtherApiUrl12345678", OutputValue: "x" },
    { OutputKey: "ArtifactsApiUrlX", OutputValue: "y" },
  ];

  it("match <constructId><Name><8 hex>", () => {
    assert.deepEqual(matchOutputs(outputs, "Artifacts", ["ApiUrl", "BucketName"]), {
      ApiUrl: "https://api.example.dev",
      BucketName: "b",
    });
    assert.deepEqual(matchOutputs(outputs, "Other", ["ApiUrl"]), { ApiUrl: "x" });
  });

  it("include the eleven viewing-plane outputs", () => {
    for (const name of [
      "DistributionId",
      "DistributionDomainName",
      "ViewFunctionUrl",
      "ViewLogGroupName",
      "ViewerRequestFunctionName",
      "KeyValueStoreArn",
      "SessionSecretArn",
      "SessionKeysLogGroupName",
      "UserPoolId",
      "UserPoolClientId",
      "LoginDomainUrl",
    ] as const) {
      assert.ok(OUTPUT_NAMES.includes(name), name);
    }
  });

  it("name a missing output as bad input", () => {
    assert.throws(
      () => matchOutputs(outputs, "Artifacts", ["ApiUrl", "PruneScheduleName"]),
      (e: Error) => e instanceof InputError && /ArtifactsPruneScheduleName/.test(e.message),
    );
  });
});

describe("arguments", () => {
  it("smoke: defaults, unknown stage and unknown option", () => {
    assert.deepEqual(parseSmokeArgs([]), {
      stage: "prod",
      constructId: "Artifacts",
      skipRevokeCheck: false,
      keep: false,
      help: false,
      viewOnly: false,
      skipView: false,
    });
    assert.equal(parseSmokeArgs(["--skip-revoke-check", "--keep"]).skipRevokeCheck, true);
    assert.equal(parseSmokeArgs(["--view-only"]).viewOnly, true);
    assert.equal(parseSmokeArgs(["--skip-view"]).skipView, true);
    assert.throws(() => parseSmokeArgs(["--view-only", "--skip-view"]), InputError);
    assert.throws(() => parseSmokeArgs(["--stage", "nope"]), InputError);
    assert.throws(() => parseSmokeArgs(["--bogus"]), InputError);
    assert.throws(() => parseSmokeArgs(["extra"]), InputError);
  });

  it("retention-check: every bucket option is required", () => {
    assert.deepEqual(
      parseRetentionArgs([
        "bucket",
        "--bucket",
        "b",
        "--region",
        "eu-north-1",
        "--expect",
        "absent",
      ]),
      { command: "bucket", bucket: "b", region: "eu-north-1", expect: "absent" },
    );
    for (const argv of [
      ["bucket", "--bucket", "b", "--expect", "present"],
      ["bucket", "--bucket", "b", "--region", "eu-north-1"],
      ["bucket", "--region", "eu-north-1", "--expect", "present"],
      ["bucket", "--bucket", "b", "--region", "r", "--expect", "maybe"],
      ["bucket", "--bucket", "b", "--region", "r", "--expect", "present", "--bogus"],
      ["prune", "--stack", "S"],
      ["prune", "--region", "r"],
      ["sweep"],
      [],
    ]) {
      assert.throws(() => parseRetentionArgs(argv), InputError, argv.join(" "));
    }
    assert.deepEqual(parseRetentionArgs(["prune", "--stack", "S", "--region", "r"]), {
      command: "prune",
      stack: "S",
      region: "r",
      constructId: "Artifacts",
    });
  });

  it("check-dns: stage and options", () => {
    assert.deepEqual(parseDnsArgs([]), { stage: "prod" });
    assert.throws(() => parseDnsArgs(["--stage", "nope"]), InputError);
    assert.throws(() => parseDnsArgs(["--bogus"]), InputError);
  });

  it("bad input exits 2 before any AWS call", () => {
    for (const [script, args] of [
      ["scripts/retention-check.ts", ["bucket"]],
      ["scripts/retention-check.ts", ["bucket", "--bucket", "b", "--region", "r"]],
      ["scripts/smoke.ts", ["--stage", "nope"]],
      ["scripts/smoke.ts", ["--view-only", "--skip-view"]],
      ["scripts/check-dns.ts", ["--bogus"]],
    ] as const) {
      const r = spawnSync(process.execPath, ["--conditions=artifact-source", script, ...args], {
        cwd: here,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", AWS_EC2_METADATA_DISABLED: "true" },
      });
      assert.equal(r.status, 2, `${script} ${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /Usage:/);
    }
  });
});

describe("table", () => {
  it("renders rows and a summary; any FAIL exits 1", () => {
    const rows = [
      { check: "S1", covers: "C1", result: "PASS" as const, detail: "ok" },
      { check: "S14 token revoke", covers: "C9", result: "SKIP" as const, detail: "pending" },
    ];
    const text = renderTable(rows);
    assert.match(text, /^check +\| covers \| result \| detail\n/);
    assert.match(text, /S14 token revoke \| C9 +\| SKIP +\| pending/);
    assert.match(text, /1 PASS, 0 FAIL, 1 SKIP\n$/);
    assert.equal(exitCode(rows), 0);
    assert.equal(exitCode([...rows, { ...rows[0], result: "FAIL" }]), 1);
  });

  it("redacts tokens and cookie markers from every detail", async () => {
    const checks = new Checks();
    checks.secret("art_SECRET");
    checks.secret("smoke-MARKER");
    await checks.run("a", "x", async () => "got art_SECRET");
    await checks.run("b", "x", async () => {
      throw new Error("saw smoke-MARKER in a log");
    });
    assert.deepEqual(
      checks.rows.map((r) => [r.result, r.detail]),
      [
        ["PASS", "got <redacted>"],
        ["FAIL", "saw <redacted> in a log"],
      ],
    );
    assert.equal(redact("a b a", ["a", undefined]), "<redacted> b <redacted>");
  });
});

describe("log parsers", () => {
  it("never throw and need string method and path / routeKey", () => {
    for (const bad of [
      "",
      "{",
      "null",
      "[]",
      '"x"',
      '{"path":"/mcp"}',
      '{"method":1,"path":"/"}',
    ]) {
      assert.equal(parseAccessLine(bad), undefined, bad);
    }
    for (const bad of [
      "artifact request {",
      "artifact request []",
      'artifact request {"routeKey":"ANY /mcp"}',
      "other line",
    ]) {
      assert.equal(parseRequestLine(bad), undefined, bad);
    }
    assert.equal(parseAccessLine(accessLine({ method: "POST" }))?.method, "POST");
    const line = parseRequestLine(
      `2026-10-20T12:00:00Z\tid\tINFO\t${requestLine("POST", "ANY /mcp")}`,
    );
    assert.equal(line?.routeKey, "ANY /mcp");
  });

  it("reads the runtime line behind the managed runtime's text log prefix (S19)", () => {
    // Shape of a real control-function event from the first deploy (2026-10-20).
    const info = parseRuntimeLine(
      '2026-10-20T16:31:06.350Z\t-\tINFO\tartifact runtime {"node":"v24.21.0","clientS3":"3.1105.0","clientSecretsManager":"3.1105.0","package":"1.0.0"}\n',
    );
    assert.deepEqual(info, {
      node: "v24.21.0",
      clientS3: "3.1105.0",
      clientSecretsManager: "3.1105.0",
      package: "1.0.0",
    });
    for (const bad of ["artifact runtime {", "artifact runtime", "INIT_START Runtime Version"]) {
      assert.equal(parseRuntimeLine(bad), undefined, bad);
    }
  });
});

describe("S39 predicate", () => {
  const runtime = (t: number) =>
    ev(
      `2026-10-21T10:00:00.000Z\t-\tINFO\tartifact runtime {"node":"v24.22.0","package":"2.0.0"}`,
      t,
    );
  const initError = (t: number, name = "Runtime.ImportModuleError") =>
    ev(
      `2026-10-21T10:00:00.000Z\tundefined\tERROR\tUncaught Exception {"errorType":"${name}","errorMessage":"x"}`,
      t,
    );

  it("passes on a runtime line newer than a stale init error", () => {
    const verdict = runtimeVerdict([initError(T), runtime(T + 1000)]);
    assert.equal(verdict.status, "pass");
  });

  it("fails on an init error newer than the newest runtime line, naming the error only", () => {
    assert.deepEqual(runtimeVerdict([runtime(T), initError(T + 1000)]), {
      status: "fail",
      detail: "init error Runtime.ImportModuleError",
    });
    const enoent = runtimeVerdict([
      ev("Error: ENOENT: no such file or directory, open '/var/task/reload-client.js'", T),
    ]);
    assert.deepEqual(enoent, { status: "fail", detail: "init error ENOENT" });
  });

  it("waits while there is neither", () => {
    assert.deepEqual(runtimeVerdict([ev("START RequestId: x", T)]), { status: "wait" });
    assert.deepEqual(runtimeVerdict([]), { status: "wait" });
  });
});

describe("S9 and S12 predicates", () => {
  it("match POSTs by method and path, with or without a stage prefix", () => {
    for (const path of ["/api/artifacts", "/$default/api/artifacts"]) {
      assert.equal(
        postTo(parseAccessLine(accessLine({ method: "POST", path })), "/api/artifacts"),
        true,
      );
    }
    for (const path of ["/mcp", "/$default/mcp"]) {
      assert.equal(postTo(parseAccessLine(accessLine({ method: "POST", path })), "/mcp"), true);
    }
    assert.equal(
      postTo(
        parseAccessLine(accessLine({ method: "GET", path: "/api/artifacts" })),
        "/api/artifacts",
      ),
      false,
    );
    assert.equal(
      postTo(
        parseAccessLine(accessLine({ method: "POST", path: "/api/artifacts/x" })),
        "/api/artifacts",
      ),
      false,
    );
  });

  it("match control lines on the selected route key, not the request method", () => {
    const events = [
      ev(requestLine("POST", "ANY /mcp")),
      ev(requestLine("POST", "POST /api/artifacts")),
    ];
    assert.ok(findRequestLine(events, CONTROL_ROUTE_KEYS.mcp, T));
    assert.equal(
      findRequestLine([ev(requestLine("POST", "POST /mcp"))], CONTROL_ROUTE_KEYS.mcp, T),
      undefined,
    );
    assert.equal(findRequestLine(events, CONTROL_ROUTE_KEYS.apiProxy, T), undefined);
    assert.ok(
      findRequestLine(
        [ev(requestLine("POST", "ANY /api/{proxy+}"))],
        CONTROL_ROUTE_KEYS.apiProxy,
        T,
      ),
    );
  });

  it("allow 5 s of clock skew", () => {
    const line = [ev(requestLine("POST", "ANY /mcp"), T - 5000)];
    assert.ok(findRequestLine(line, CONTROL_ROUTE_KEYS.mcp, T));
    assert.equal(
      findRequestLine([ev(requestLine("POST", "ANY /mcp"), T - 5001)], CONTROL_ROUTE_KEYS.mcp, T),
      undefined,
    );
  });

  const controls = {
    pathMarker: "smokectlabc",
    mcpRouteKey: CONTROL_ROUTE_KEYS.mcp,
    apiProxyRouteKey: CONTROL_ROUTE_KEYS.apiProxy,
  };
  const access = [
    ev(accessLine({ method: "GET", path: "/api/artifacts/smokectlabc" })),
    ev(accessLine({ method: "POST", path: "/$default/mcp" })),
    ev(accessLine({ method: "POST", path: "/api/artifacts" })),
  ];
  const control = [
    ev(requestLine("POST", "ANY /mcp")),
    ev(requestLine("POST", "ANY /api/{proxy+}")),
  ];

  it("need every positive control before absence counts", () => {
    assert.deepEqual(missingControls(access, control, controls, T), []);
    assert.deepEqual(missingControls(access.slice(1), control.slice(1), controls, T), [
      "access GET marker path",
      "control POST ANY /mcp",
    ]);
  });

  it("find the marker in any raw line, parsed or not", () => {
    const marker = "smoke-1234";
    assert.equal(containing([...access, ...control], marker).length, 0);
    assert.equal(containing([...access, ev(`START ${marker}`)], marker).length, 1);
    const broken = '{"method":"POST","path":"/mcp","error":"bad "x" value"}';
    assert.equal(parseAccessLine(broken), undefined);
    assert.equal(postTo(parseAccessLine(broken), "/mcp"), false);
    assert.equal(containing([ev(`${broken} ${marker}`)], marker).length, 1);
  });

  it("list at most 20 seen pairs", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ev(accessLine({ method: "GET", path: `/p${i}` })),
    );
    const pairs = seenPairs(many, "access", T);
    assert.equal(pairs.length, 20);
    assert.equal(pairs[0], "GET /p0");
    assert.deepEqual(seenPairs(control, "control", T), ["POST ANY /mcp", "POST ANY /api/{proxy+}"]);
  });
});

describe("fetchEvents", () => {
  it("follows nextToken without a filter pattern", async () => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      send: async (command: FilterLogEventsCommand) => {
        sent.push(command.input as Record<string, unknown>);
        const page = sent.length;
        return {
          events: [{ message: `m${page}`, timestamp: page }],
          nextToken: page < 3 ? `t${page}` : undefined,
        };
      },
    };
    const events = await fetchEvents(client as never, "g", 5);
    assert.deepEqual(events, [
      { message: "m1", timestamp: 1 },
      { message: "m2", timestamp: 2 },
      { message: "m3", timestamp: 3 },
    ]);
    assert.deepEqual(
      sent.map((s) => s.nextToken),
      [undefined, "t1", "t2"],
    );
    for (const input of sent) {
      assert.equal(input.filterPattern, undefined);
      assert.equal(input.logGroupName, "g");
      assert.equal(input.startTime, 5);
    }
  });

  it("fails after 50 pages", async () => {
    let pages = 0;
    const client = { send: async () => ({ events: [], nextToken: `t${++pages}` }) };
    await assert.rejects(fetchEvents(client as never, "g", 0), /too many log events/);
    assert.equal(pages, MAX_PAGES);
  });
});

describe("retention-check helpers", () => {
  it("parse the prune schedule input", () => {
    assert.deepEqual(parseScheduleInput('{"task":"prune","keepLast":2}'), {
      task: "prune",
      keepLast: 2,
    });
    for (const bad of [undefined, "", "{", '{"task":"sweep"}', "null"]) {
      assert.throws(() => parseScheduleInput(bad), Error, String(bad));
    }
  });

  it("map HeadBucket outcomes", () => {
    const cases: [Parameters<typeof bucketResult>[0], "present" | "absent", boolean, string][] = [
      [{ status: 200 }, "present", true, "bucket exists"],
      [{ status: 200 }, "absent", false, "bucket still exists"],
      [{ status: 404, name: "NotFound" }, "absent", true, "bucket is gone"],
      [{ status: 404, name: "NotFound" }, "present", false, "bucket not found"],
      [{ status: 301 }, "present", false, "bucket is in another Region"],
      [{ status: 0, name: "PermanentRedirect" }, "absent", false, "bucket is in another Region"],
      [{ status: 403 }, "present", false, "cannot tell: access denied"],
      [
        { status: 500, name: "InternalError", message: "boom" },
        "absent",
        false,
        "InternalError: boom",
      ],
    ];
    for (const [outcome, expected, pass, detail] of cases) {
      assert.deepEqual(bucketResult(outcome, expected), { pass, detail });
    }
  });
});

describe("check-dns helpers", () => {
  it("normalise case, trailing dots, order and empty entries", () => {
    assert.deepEqual(normaliseNs("NS-1.Example.org., ns-2.example.org,, "), [
      "ns-1.example.org",
      "ns-2.example.org",
    ]);
    assert.deepEqual(normaliseNs(["b.", "A"]), ["a", "b"]);
  });

  it("compare as sets", () => {
    assert.equal(sameNs(["a", "b."], ["B", "a"]), true);
    assert.equal(sameNs(["a"], ["a", "b"]), false);
    assert.equal(sameNs(["a", "c"], ["a", "b"]), false);
  });

  it("map resolver errors", () => {
    assert.equal(dnsErrorDetail("ENOTFOUND"), "not delegated yet");
    assert.equal(dnsErrorDetail("ENODATA"), "not delegated yet");
    assert.equal(dnsErrorDetail("ETIMEOUT"), "timeout");
    assert.equal(dnsErrorDetail("ESERVFAIL"), "error ESERVFAIL");
  });
});
