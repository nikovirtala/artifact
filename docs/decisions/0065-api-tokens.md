# 0065. API tokens: hashed list in Secrets Manager, 5-minute cache, `artifact token`

Status: Accepted (M9)

## Context

The AWS control plane (`/api`, `/mcp` on the API host) authenticates with bearer tokens (`docs/01-plan-aws.md`, "Domains, authentication and isolation"): several named tokens per deployment, checked against SHA-256 hashes in Secrets Manager and cached for 5 minutes, so revoking one takes effect within 5 minutes. The owner needs a way to mint and revoke them. CLI-only installs of the package must stay free of AWS packages (0050).

## Decision

- **Format.** One secret per deployment, created by the construct with `{"version":1,"tokens":[]}`:

  ```json
  {"version":1,"tokens":[{"name":"laptop","sha256":"<64 lowercase hex>","createdAt":"2026-10-20T12:00:00.000Z"}]}
  ```

  `src/token-secret.ts` (v1 top level, no AWS imports) owns it for both the CLI and the Lambda: `parseTokenSecret` rejects anything but a JSON object with `version: 1`, at most 100 tokens, unique names matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, `sha256` matching `^[0-9a-f]{64}$` and a string `createdAt`; its errors never quote the text. Tokens are `art_` + 32 random bytes as base64url and are never stored.
- **CLI.** `artifact token create <name> --secret <arn> [--json]`, `revoke <name> --secret <arn>` and `list --secret <arn> [--json]` (`src/cli/token.ts`). The client's Region comes from the ARN, so the shell's default Region does not matter. `create` prints the token once on stdout and reminds on stderr to store it; `list` prints names and dates, never hashes. Errors: bad arguments exit 2; `token_exists`, `not_found`, `too_many_tokens` (at 100), `aws_error` (`<name>: <message>`) and `bad_secret` exit 1, and none prints the secret string.
- **Optional SDK.** `@aws-sdk/client-secrets-manager` is loaded with `import()`, the one dynamic AWS import 0050 allows. When the package itself is missing (`ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND` naming it), the command fails with `missing_dependency` and `npm install @aws-sdk/client-secrets-manager`. It is an optional peer of the package (0073) and a root devDependency for the tests.
- **Verification on Lambda** (`src/runtime/auth/token-verifier.ts`): the parsed hashes are cached per warm instance, refreshed when there is no successful fetch yet or the last one is at least 5 minutes old, single-flight. An empty list is cached like any other. A failed or malformed refresh rejects (500 `internal`) instead of serving the old list, and is not cached, so the next request retries. The presented token's SHA-256 is compared with every stored hash with `timingSafeEqual`.
- **Permissions.** The control role gets `secretsmanager:GetSecretValue` on the secret only; the owner's role needs `GetSecretValue` and `PutSecretValue`. No `kms:Decrypt` grant: the secret uses the AWS managed key `aws/secretsmanager`, whose key policy lets principals of the account use it for cryptographic operations when the request comes through Secrets Manager (`kms:ViaService`); only a customer managed key would need an IAM grant ([Secret encryption and decryption](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html), A9 in the M9 AWS facts).

## Consequences

- **Delay for a new token:** cold instances see it at once; instances that are already warm see it within 5 minutes. **Revocation bound:** a warm instance refetches at most 5 minutes after its last successful fetch, and a failed refresh never serves the old list, so a revoked token stops within 5 minutes everywhere. Secrets Manager is called at most once per 5 minutes per warm instance.
- **Last writer wins.** Secrets Manager has no conditional put, so two simultaneous `create`/`revoke` runs can lose one change. The command is meant for a single operator.
- **Frozen secret resource.** The construct's `AWS::SecretsManager::Secret` has only `SecretString` set, and a construct test pins its complete properties. A CloudFormation update of that resource may re-apply `SecretString` and wipe the stored tokens. This was not verified either way, so it is treated as real: any change to the resource needs a deliberate, reviewed edit of that test.
