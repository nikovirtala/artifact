// Control Lambda entry (docs/decisions/0066): wiring only. Bundled to
// dist/assets/control/index.mjs with the runtime's @aws-sdk/* left external (0068).
import { S3Client } from "@aws-sdk/client-s3";
import { systemClock } from "../../adapters/system-clock.ts";
import { createUlidIdGen } from "../../adapters/ulid.ts";
import { ArtifactService } from "../../core/artifact-service.ts";
import { noopNotifier } from "../adapters/noop-notifier.ts";
import { createS3Store } from "../adapters/s3-store.ts";
import { createTokenVerifier, secretsManagerLoader } from "../auth/token-verifier.ts";
import { parseControlEnv } from "../env.ts";
import { createControlHandler } from "../handlers/control.ts";
import { runtimeInfoLine } from "../handlers/runtime-info.ts";

const env = parseControlEnv(process.env);
const store = createS3Store({ client: new S3Client({}), bucket: env.bucket });
const service = new ArtifactService({
  blobs: store,
  pointers: store,
  notifier: noopNotifier,
  clock: systemClock,
  ids: createUlidIdGen(),
  limits: env.limits,
});
const verifyToken = createTokenVerifier({ load: secretsManagerLoader(env.tokenSecretArn) });
console.log(await runtimeInfoLine({ secretsManager: true }));

export const handler = createControlHandler({
  service,
  verifyToken,
  viewDomain: env.viewDomain,
  maxBodyBytes: env.maxBodyBytes,
});
