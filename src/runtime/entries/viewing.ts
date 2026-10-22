// Viewing Lambda entry (docs/decisions/0082): wiring only. Bundled to
// dist/assets/viewing/index.mjs with the runtime's @aws-sdk/* left external (0068) and
// reload-client.js copied next to it.
import { S3Client } from "@aws-sdk/client-s3";
import { systemClock } from "../../adapters/system-clock.ts";
import { createUlidIdGen } from "../../adapters/ulid.ts";
import { ArtifactService } from "../../core/artifact-service.ts";
import { noopNotifier } from "../adapters/noop-notifier.ts";
import { createS3Store } from "../adapters/s3-store.ts";
import { createKeyCache, sessionSecretLoader } from "../auth/session-keys-loader.ts";
import { parseViewingEnv } from "../env.ts";
import { runtimeInfoLine } from "../handlers/runtime-info.ts";
import { createViewingHandler } from "../handlers/viewing.ts";

const env = parseViewingEnv(process.env);
const store = createS3Store({ client: new S3Client({}), bucket: env.bucket });
const service = new ArtifactService({
  blobs: store,
  pointers: store,
  notifier: noopNotifier,
  clock: systemClock,
  // Reads only; the service requires one.
  ids: createUlidIdGen(),
});
const loadKeys = createKeyCache(sessionSecretLoader(env.sessionSecretArn));
console.log(await runtimeInfoLine({ secretsManager: true }));

export const handler = createViewingHandler({
  service,
  viewDomain: env.viewDomain,
  loadKeys,
  oidc: env.oidc,
  owners: env.owners,
  fetch: globalThis.fetch,
});
