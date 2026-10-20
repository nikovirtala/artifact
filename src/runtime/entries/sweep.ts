// Sweep Lambda entry (docs/decisions/0067): wiring only. Bundled to
// dist/assets/sweep/index.mjs with the runtime's @aws-sdk/* left external (0068).
import { S3Client } from "@aws-sdk/client-s3";
import { systemClock } from "../../adapters/system-clock.ts";
import { createUlidIdGen } from "../../adapters/ulid.ts";
import { ArtifactService } from "../../core/artifact-service.ts";
import { noopNotifier } from "../adapters/noop-notifier.ts";
import { createS3Store } from "../adapters/s3-store.ts";
import { parseSweepEnv } from "../env.ts";
import { runtimeInfoLine } from "../handlers/runtime-info.ts";
import { createSweepHandler } from "../handlers/sweep.ts";

const env = parseSweepEnv(process.env);
const store = createS3Store({ client: new S3Client({}), bucket: env.bucket });
const service = new ArtifactService({
  blobs: store,
  pointers: store,
  notifier: noopNotifier,
  clock: systemClock,
  ids: createUlidIdGen(),
  limits: env.limits,
});
console.log(await runtimeInfoLine({ secretsManager: false }));

export const handler = createSweepHandler({ service });
