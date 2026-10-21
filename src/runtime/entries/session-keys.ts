// Session-keys custom resource entry (docs/decisions/0079): wiring only. The KeyValueStore API is
// global and SigV4A-signed, and the client throws unless a SigV4A signer is imported explicitly,
// so this one bundle carries @aws-sdk/client-cloudfront-keyvaluestore and @aws-sdk/signature-v4a;
// @aws-sdk/client-secrets-manager stays external (the runtime's).
import "@aws-sdk/signature-v4a";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  ListKeysCommand,
  UpdateKeysCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createSessionKeysHandler } from "../handlers/session-keys.ts";

const kvs = new CloudFrontKeyValueStoreClient({ region: process.env.AWS_REGION });
const secrets = new SecretsManagerClient({});

export const handler = createSessionKeysHandler({
  secrets: {
    read: async (arn) => {
      const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
      if (SecretString === undefined) throw new TypeError("the session secret has no SecretString");
      return SecretString;
    },
    write: async (arn, value) => {
      await secrets.send(new PutSecretValueCommand({ SecretId: arn, SecretString: value }));
    },
  },
  kvs: {
    describe: async (arn) => {
      const { Status, ETag } = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: arn }));
      return { status: Status ?? "", etag: ETag ?? "" };
    },
    list: async (arn) => {
      const items: Record<string, string> = {};
      let NextToken: string | undefined;
      do {
        const page = await kvs.send(new ListKeysCommand({ KvsARN: arn, NextToken }));
        for (const { Key, Value } of page.Items ?? []) {
          if (Key !== undefined && Value !== undefined) items[Key] = Value;
        }
        NextToken = page.NextToken;
      } while (NextToken !== undefined);
      return items;
    },
    update: async (arn, { ifMatch, puts, deletes }) => {
      await kvs.send(
        new UpdateKeysCommand({
          KvsARN: arn,
          IfMatch: ifMatch,
          Puts: puts.map(({ key, value }) => ({ Key: key, Value: value })),
          Deletes: deletes.map((key) => ({ Key: key })),
        }),
      );
    },
  },
  randomBytes,
  sleep: (ms) => delay(ms),
  now: Date.now,
  fetch: globalThis.fetch,
});
