// `artifact token create|revoke|list` (docs/decisions/0065): manages the hashed API tokens of
// an AWS deployment in its Secrets Manager secret. The SDK is an optional peer, loaded by the
// one dynamic import the v1 code may make (docs/decisions/0050); without it the command names
// the install command.

import {
  hashToken,
  MAX_TOKENS,
  newToken,
  parseTokenSecret,
  serializeTokenSecret,
  TOKEN_NAME,
  type TokenSecret,
} from "../token-secret.ts";
import { parseCommand } from "./args.ts";
import { type CliContext, CliError, EXIT, printJson, table, UsageError } from "./output.ts";

export const USAGE = `Usage: artifact token <action> [name] --secret <arn>

  artifact token create <name> --secret <arn> [--json]
  artifact token revoke <name> --secret <arn>
  artifact token list --secret <arn> [--json]

Manages the API tokens of an AWS deployment. The deployment's Secrets Manager secret (the
TokenSecretArn stack output) holds SHA-256 hashes only: create prints the new token once, so
store it then. A new token may take up to 5 minutes to work on running instances; a revoked
token stops working within 5 minutes. Uses the AWS credentials of the environment and the
secret's Region; needs @aws-sdk/client-secrets-manager installed next to artifact.

Options:
  --secret <arn>        ARN of the token secret (required)
  --json                Print JSON
  -h, --help            Show this help
`;

const SDK_PACKAGE = "@aws-sdk/client-secrets-manager";
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;

/** The part of `@aws-sdk/client-secrets-manager` this command uses. */
export type SecretsSdk = {
  SecretsManagerClient: new (config: {
    region: string;
  }) => { send(command: unknown): Promise<{ SecretString?: string }> };
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
  PutSecretValueCommand: new (input: { SecretId: string; SecretString: string }) => unknown;
};

export type TokenDeps = { loadSdk: () => Promise<SecretsSdk> };

const defaultDeps: TokenDeps = {
  loadSdk: () => import("@aws-sdk/client-secrets-manager") as unknown as Promise<SecretsSdk>,
};

/** True if `error` is the module loader failing to find `name` itself. */
export function isMissingModule(error: unknown, name: string): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    typeof message === "string" &&
    message.includes(`'${name}'`)
  );
}

async function loadSdk(deps: TokenDeps): Promise<SecretsSdk> {
  try {
    return await deps.loadSdk();
  } catch (error) {
    if (!isMissingModule(error, SDK_PACKAGE)) throw error;
    throw new CliError(
      "missing_dependency",
      `artifact token needs ${SDK_PACKAGE} next to artifact: npm install ${SDK_PACKAGE} (or npx -p @nikovirtala/artifact -p ${SDK_PACKAGE} artifact token …)`,
    );
  }
}

const awsError = (error: unknown) => {
  const { name, message } = error as { name?: unknown; message?: unknown };
  return new CliError("aws_error", `${String(name)}: ${String(message)}`);
};

/** Get, change and put the secret through one client in the secret's Region. */
function secretStore(sdk: SecretsSdk, arn: string) {
  const client = new sdk.SecretsManagerClient({ region: arn.split(":")[3] });
  return {
    async get(): Promise<TokenSecret> {
      let text: string | undefined;
      try {
        text = (await client.send(new sdk.GetSecretValueCommand({ SecretId: arn }))).SecretString;
      } catch (error) {
        throw awsError(error);
      }
      try {
        if (text === undefined) throw new TypeError("the secret has no SecretString");
        return parseTokenSecret(text);
      } catch (error) {
        throw new CliError(
          "bad_secret",
          `the token secret is malformed: ${(error as Error).message}`,
        );
      }
    },
    async put(secret: TokenSecret): Promise<void> {
      try {
        await client.send(
          new sdk.PutSecretValueCommand({
            SecretId: arn,
            SecretString: serializeTokenSecret(secret),
          }),
        );
      } catch (error) {
        throw awsError(error);
      }
    },
  };
}

export async function run(
  args: string[],
  ctx: CliContext,
  deps: TokenDeps = defaultDeps,
): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    options: { secret: { type: "string" }, json: { type: "boolean" } },
    positionals: { min: 1, max: 2 },
  });
  ctx.json = values.json === true;
  const [action, name] = positionals;
  if (action !== "create" && action !== "revoke" && action !== "list") {
    throw new UsageError(`unknown subcommand ${JSON.stringify(action)}`);
  }
  if (action === "list" && name !== undefined) {
    throw new UsageError(`unexpected argument ${JSON.stringify(name)}`);
  }
  if (action !== "list") {
    if (name === undefined) throw new UsageError("missing token name");
    if (!TOKEN_NAME.test(name)) {
      throw new UsageError(
        "the token name must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
      );
    }
  }
  const arn = values.secret;
  if (arn === undefined) throw new UsageError("--secret <arn> is required");
  if (!SECRET_ARN.test(arn)) throw new UsageError("--secret must be a Secrets Manager secret ARN");

  const store = secretStore(await loadSdk(deps), arn);
  const secret = await store.get();

  if (action === "list") {
    const tokens = secret.tokens.map(({ name, createdAt }) => ({ name, createdAt }));
    if (values.json) printJson(ctx, { tokens });
    else if (tokens.length === 0) ctx.stdout.write("no tokens\n");
    else
      ctx.stdout.write(table([["NAME", "CREATED"], ...tokens.map((t) => [t.name, t.createdAt])]));
    return EXIT.ok;
  }

  const tokenName = name as string;
  const taken = secret.tokens.some((t) => t.name === tokenName);
  if (action === "revoke") {
    if (!taken) throw new CliError("not_found", `no token named ${tokenName}`);
    await store.put({ version: 1, tokens: secret.tokens.filter((t) => t.name !== tokenName) });
    ctx.stderr.write(`artifact: revoked ${tokenName}; this takes effect within 5 minutes\n`);
    return EXIT.ok;
  }

  if (taken) throw new CliError("token_exists", `a token named ${tokenName} exists`);
  if (secret.tokens.length >= MAX_TOKENS) {
    throw new CliError("too_many_tokens", `the secret already holds ${MAX_TOKENS} tokens`);
  }
  const token = newToken();
  await store.put({
    version: 1,
    tokens: [
      ...secret.tokens,
      { name: tokenName, sha256: hashToken(token), createdAt: new Date().toISOString() },
    ],
  });
  if (values.json) printJson(ctx, { name: tokenName, token });
  else ctx.stdout.write(`${token}\n`);
  ctx.stderr.write(
    "artifact: store this token now; it is not shown again (it may take up to 5 minutes to work on running instances)\n",
  );
  return EXIT.ok;
}
