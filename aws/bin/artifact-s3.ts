#!/usr/bin/env node
// S3 dev harness (docs/decisions/0062): `artifact serve` on S3 stores, every other command the
// normal CLI. ARTIFACT_S3_BUCKET names the bucket; ARTIFACT_S3_PREFIX (optional) scopes it, and
// each serve root gets its own key space under it (`<prefix><basename(root)>/`), so parallel
// e2e servers never share state. ARTIFACT_S3_ENDPOINT points the client at another endpoint
// (the fake S3 server in tests).
import { basename } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { runServe } from "../../src/cli/serve.ts";
import { createS3Store } from "../../src/runtime/adapters/s3-store.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "serve") {
  const bucket = process.env.ARTIFACT_S3_BUCKET;
  const help = args.includes("--help") || args.includes("-h");
  if (!bucket && !help) {
    process.stderr.write("artifact: ARTIFACT_S3_BUCKET is required for the S3 dev harness\n");
    process.exitCode = 1;
  } else {
    const endpoint = process.env.ARTIFACT_S3_ENDPOINT || undefined;
    const client = new S3Client(endpoint ? { endpoint, forcePathStyle: true } : {});
    process.exitCode = await runServe(args, process.env, {
      openStore: (config) => {
        const prefix = `${process.env.ARTIFACT_S3_PREFIX ?? ""}${basename(config.root)}/`;
        return {
          store: createS3Store({ client, bucket: bucket ?? "", prefix }),
          location: `s3://${bucket}/${prefix}`,
        };
      },
    });
    client.destroy();
  }
} else {
  // main.ts reads process.argv itself.
  await import("../../src/cli/main.ts");
}
