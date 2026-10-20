// Deployed evidence for dataRetention (C3, docs/decisions/0076), run by the owner from CloudShell.
//   pnpm retention-check prune --stack <name> --region <r> [--construct-id Artifacts]
//   pnpm retention-check bucket --bucket <name> --region <r> --expect present|absent
// Exit 0 when nothing failed, 1 when a check failed, 2 on bad input.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GetScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { artifact, InputError, parseOptions, runScript, sleep } from "./lib/cli.ts";
import { matchOutputs, stackOutputs } from "./lib/outputs.ts";
import { Checks, exitCode, expect, renderTable } from "./lib/table.ts";

export const USAGE = `Usage: pnpm retention-check <prune|bucket> [options]

  prune --stack <name> --region <region> [--construct-id Artifacts]
      Publishes 4 versions, rolls back to v1, invokes the sweep function with the prune
      schedule's exact input and expects versions [1,3,4] with v1 current (keepLast: 2).
  bucket --bucket <name> --region <region> --expect present|absent
      Whether the bucket still exists (after cdk destroy: present under RETAIN, absent under
      DESTROY).
`;

export type RetentionArgs =
  | { command: "prune"; stack: string; region: string; constructId: string }
  | { command: "bucket"; bucket: string; region: string; expect: "present" | "absent" };

export function parseRetentionArgs(argv: readonly string[]): RetentionArgs {
  const [command, ...rest] = argv;
  if (command === "prune") {
    const { values } = parseOptions(rest, {
      stack: { type: "string" },
      region: { type: "string" },
      "construct-id": { type: "string" },
    });
    if (!values.stack || !values.region) throw new InputError("prune needs --stack and --region");
    return {
      command,
      stack: values.stack,
      region: values.region,
      constructId: values["construct-id"] ?? "Artifacts",
    };
  }
  if (command === "bucket") {
    const { values } = parseOptions(rest, {
      bucket: { type: "string" },
      region: { type: "string" },
      expect: { type: "string" },
    });
    if (!values.bucket || !values.region || !values.expect) {
      throw new InputError("bucket needs --bucket, --region and --expect");
    }
    if (values.expect !== "present" && values.expect !== "absent") {
      throw new InputError("--expect must be present or absent");
    }
    return { command, bucket: values.bucket, region: values.region, expect: values.expect };
  }
  throw new InputError(
    command === undefined ? "missing command" : `unknown command ${JSON.stringify(command)}`,
  );
}

/** The prune schedule's input: `{task: "prune", keepLast?, olderThanMs?}`. */
export function parseScheduleInput(input: string | undefined): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(input ?? "");
  } catch {
    throw new Error("the schedule's Target.Input is not JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { task?: unknown }).task !== "prune"
  ) {
    throw new Error(`the schedule's input is not a prune task: ${input}`);
  }
  return value as Record<string, unknown>;
}

/** HeadBucket's outcome against the expectation. */
export function bucketResult(
  outcome: { status: number; name?: string; message?: string },
  expected: "present" | "absent",
): { pass: boolean; detail: string } {
  if (outcome.status === 200) {
    return {
      pass: expected === "present",
      detail: expected === "present" ? "bucket exists" : "bucket still exists",
    };
  }
  if (outcome.status === 404) {
    return {
      pass: expected === "absent",
      detail: expected === "absent" ? "bucket is gone" : "bucket not found",
    };
  }
  if (outcome.status === 301 || outcome.name === "PermanentRedirect") {
    return { pass: false, detail: "bucket is in another Region" };
  }
  if (outcome.status === 403) return { pass: false, detail: "cannot tell: access denied" };
  return {
    pass: false,
    detail: `${outcome.name ?? "error"}: ${outcome.message ?? outcome.status}`,
  };
}

async function headBucket(bucket: string, region: string) {
  try {
    const { $metadata } = await new S3Client({ region }).send(
      new HeadBucketCommand({ Bucket: bucket }),
    );
    return { status: $metadata.httpStatusCode ?? 200 };
  } catch (error) {
    const { name, message, $metadata } = error as {
      name: string;
      message: string;
      $metadata?: { httpStatusCode?: number };
    };
    return { status: $metadata?.httpStatusCode ?? 0, name, message };
  }
}

async function prune(args: Extract<RetentionArgs, { command: "prune" }>, checks: Checks) {
  const out = matchOutputs(await stackOutputs(args.region, args.stack), args.constructId, [
    "ApiUrl",
    "TokenSecretArn",
    "SweepFunctionName",
  ]);
  let scheduleName: string;
  try {
    scheduleName = matchOutputs(await stackOutputs(args.region, args.stack), args.constructId, [
      "PruneScheduleName",
    ]).PruneScheduleName;
  } catch {
    throw new InputError("the stack has no prune schedule (no dataRetention.versions)");
  }
  const name = `retention-${Date.now()}`;
  let token: string | undefined;
  let id: string | undefined;
  const env = () => ({ ARTIFACT_TOKEN: token, ARTIFACT_SERVER: out.ApiUrl });
  try {
    const ready = await checks.run("R1 token", "C3 setup", async () => {
      const r = artifact(["token", "create", name, "--secret", out.TokenSecretArn, "--json"], {});
      expect(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
      token = (JSON.parse(r.stdout) as { token: string }).token;
      checks.secret(token);
      for (const deadline = Date.now() + 315_000; Date.now() < deadline; await sleep(15_000)) {
        const res = await fetch(`${out.ApiUrl}/api`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.status === 200) return `${name} works`;
      }
      throw new Error("the token got no 200 from GET /api within 315 s");
    });
    if (!ready) return;
    await checks.run("R2 publish 4 versions", "C3", async () => {
      for (let v = 1; v <= 4; v++) {
        const page = `<!doctype html><p>retention v${v}</p>`;
        const res = await fetch(`${out.ApiUrl}/api/artifacts${id ? `/${id}` : ""}`, {
          method: id ? "PUT" : "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ files: { "index.html": page } }),
        });
        const body = (await res.json()) as { id: string; version: number };
        expect(body.version === v, `HTTP ${res.status}, version ${body.version}`);
        id = body.id;
      }
      return `${id} v1..v4`;
    });
    await checks.run("R3 rollback to v1", "C3", async () => {
      expect(id, "no artifact");
      const r = artifact(["rollback", id, "1", "--json"], env());
      expect(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
      expect((JSON.parse(r.stdout) as { version: number }).version === 1, r.stdout);
      return "current 1";
    });
    let input = "";
    await checks.run("R4 prune schedule input", "C3", async () => {
      const schedule = await new SchedulerClient({ region: args.region }).send(
        new GetScheduleCommand({ Name: scheduleName }),
      );
      input = schedule.Target?.Input ?? "";
      return JSON.stringify(parseScheduleInput(input));
    });
    await checks.run("R5 invoke with that input", "C3", async () => {
      expect(input, "no schedule input");
      const res = await new LambdaClient({ region: args.region }).send(
        new InvokeCommand({
          FunctionName: out.SweepFunctionName,
          Payload: new TextEncoder().encode(input),
        }),
      );
      const payload = new TextDecoder().decode(res.Payload);
      expect(!res.FunctionError, `${res.FunctionError}: ${payload.slice(0, 300)}`);
      const result = JSON.parse(payload) as Record<string, number>;
      expect(
        Object.keys(result).sort().join() === "artifacts,skipped,versions" &&
          result.artifacts >= 1 &&
          result.versions >= 1 &&
          result.skipped === 0,
        payload,
      );
      return payload;
    });
    await checks.run("R6 versions kept", "C3 keepLast 2 keeps current", async () => {
      expect(id, "no artifact");
      const r = artifact(["read", id, "--json"], env());
      expect(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
      const meta = JSON.parse(r.stdout) as {
        currentVersion: number;
        versions: { version: number }[];
      };
      const versions = meta.versions.map((v) => v.version).join(",");
      expect(
        versions === "1,3,4" && meta.currentVersion === 1,
        `versions ${versions}, current ${meta.currentVersion}`,
      );
      return "versions [1,3,4], current 1";
    });
    await checks.run("R7 v2 pruned", "C3", async () => {
      expect(id, "no artifact");
      const r = artifact(["read", id, "--version", "2"], env());
      expect(
        r.status === 1 && r.stderr.includes("not_found"),
        `exit ${r.status}: ${r.stderr.trim()}`,
      );
      return "not_found";
    });
  } finally {
    if (id && token) artifact(["rm", id, "--yes"], env());
    if (token) artifact(["token", "revoke", name, "--secret", out.TokenSecretArn], {});
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const args = parseRetentionArgs(argv);
  const checks = new Checks();
  if (args.command === "bucket") {
    const { pass, detail } = bucketResult(await headBucket(args.bucket, args.region), args.expect);
    checks.add(`bucket ${args.expect}`, "C3", pass ? "PASS" : "FAIL", `${args.bucket}: ${detail}`);
  } else {
    await prune(args, checks);
  }
  process.stdout.write(renderTable(checks.rows));
  return exitCode(checks.rows);
}

if (import.meta.main) await runScript(USAGE, () => main(process.argv.slice(2)));
