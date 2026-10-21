# examples/personal: deploy from AWS CloudShell

The reference deployment of `@nikovirtala/artifact/cdk`: one stage, `prod` (see `lib/stages.ts`), with three stacks:

| Stack | Region | What |
| --- | --- | --- |
| `prod/Dns` (`artifact-prod-dns`) | us-east-1 | the hosted zone `artifact.nikovirtala.dev`, kept on destroy; outputs its name servers |
| `prod/Certificate` (`artifact-prod-certificate`) | us-east-1 | the view certificate for CloudFront (apex + `*.`) |
| `prod/Platform` (`artifact-prod-platform`) | eu-north-1 | `ArtifactHosting`: bucket, token secret, API on `api.artifact.nikovirtala.dev`, functions, schedules, and the viewing plane (CloudFront on `artifact.nikovirtala.dev` + `*.artifact.nikovirtala.dev`, Cognito sign-in, session keys) |

Artifact pages open in a browser after a Cognito sign-in (M10). A stage deployed with M9 is upgraded in (j); a new stage follows (a)–(g) and then (k)–(n). Decisions: [0075](../../docs/decisions/0075-examples-personal.md), [0076](../../docs/decisions/0076-smoke-and-deploy-guide.md), [0086](../../docs/decisions/0086-m10-smoke-latency-guide.md). Only `<…>` below are your inputs; nothing in this guide is secret.

## Before you start

- Open AWS CloudShell in any Region, signed in with a role that may deploy CloudFormation stacks (an administrator role).
- CloudShell keeps only 1 GB of `$HOME` per Region; everything else is lost when the session ends. Work under `/tmp` and, in every new session, repeat steps (a), (b) and the session variables. Check the space first:

  ```sh
  df -h /tmp
  ```

- The viewing Lambda reserves 20 concurrency by default, which needs an account concurrency limit of at least 120; check `aws lambda get-account-settings`, and on a smaller account (new accounts can start at 10) set `viewing: { reservedConcurrency: false }` in the stage config.

## (a) Clone the repository

The repository is public, so no token is needed.

```sh
cd /tmp && git clone https://github.com/nikovirtala/artifact.git && cd artifact && REPO=$PWD
git checkout feat/m10-viewing-plane
# or a pull request: git fetch origin pull/<n>/head:pr-<n> && git checkout pr-<n>
```

## (b) Install the pinned toolchain (Node 24.22.0, pnpm 12.14.0)

```sh
cd /tmp
ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
curl -fsSLO "https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-$ARCH.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v24.22.0/SHASUMS256.txt"
grep " node-v24.22.0-linux-$ARCH.tar.xz\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "node-v24.22.0-linux-$ARCH.tar.xz" -C /tmp
export PATH="/tmp/node-v24.22.0-linux-$ARCH/bin:/tmp/npm-global/bin:$PATH"
npm config set prefix /tmp/npm-global
npm install -g pnpm@12.14.0
pnpm config set store-dir /tmp/pnpm-store
node --version && pnpm --version
cd "$REPO" && pnpm install --frozen-lockfile && pnpm build
cd "$REPO/examples/personal"
```

## Session variables

Set these in every session (owners are never committed; separate several with commas). `ARTIFACT_OWNERS` **must be the same owners as for the last deploy** (M9 included): adding an owner sends a Cognito invitation, and removing one deletes that owner's Cognito user.

```sh
export ARTIFACT_OWNERS=<email>
# optional: alarms on errors by email
# export ARTIFACT_ALARM_EMAIL=<email>
export AWS_REGION=eu-north-1
artifact() { node "$REPO/dist/cli/main.js" "$@"; }
```

## (c) Bootstrap once

Synthesizes the app and bootstraps both of its environments, eu-north-1 and us-east-1, in the signed-in account:

```sh
pnpm exec cdk bootstrap
```

## (d) DNS stack, delegation and check

```sh
pnpm exec cdk deploy prod/Dns
aws cloudformation describe-stacks --region us-east-1 --stack-name artifact-prod-dns \
  --query "Stacks[0].Outputs[?OutputKey=='NameServers'].OutputValue" --output text
```

In the parent zone `nikovirtala.dev` (in the other account), add an `NS` record named `artifact` with those four name servers. Then check that the delegation is live; re-run until both agree (the parent record's TTL may delay it):

```sh
dig +short NS artifact.nikovirtala.dev @1.1.1.1
# or: nslookup -type=NS artifact.nikovirtala.dev 1.1.1.1
pnpm check:dns
```

`pnpm check:dns` resolves the NS records through 1.1.1.1 and 8.8.8.8, compares them with the stack output and exits 0 when the delegation is live.

## (e) Certificate and platform

ACM validates both certificates through DNS, which works only once (d) passes. The first Regional API domain also creates the `AWSServiceRoleForAPIGateway` service-linked role.

```sh
pnpm exec cdk deploy prod/Certificate prod/Platform
```

## (f) The first API token

```sh
SECRET_ARN=$(aws cloudformation describe-stacks --region eu-north-1 --stack-name artifact-prod-platform \
  --query "Stacks[0].Outputs[?starts_with(OutputKey,'ArtifactsTokenSecretArn')].OutputValue" --output text)
artifact token create cloudshell --secret "$SECRET_ARN"
read -rs ARTIFACT_TOKEN && export ARTIFACT_TOKEN
```

`token create` prints the token once: paste it at the `read` prompt (not echoed) and keep it in your password manager. A new token works at once on new function instances and within 5 minutes on warm ones; right after the first deploy there are no warm instances. `artifact token revoke <name> --secret "$SECRET_ARN"` stops a token within 5 minutes; `artifact token list --secret "$SECRET_ARN"` shows names and dates.

## (g) Smoke test

```sh
pnpm smoke
```

It runs every check, including the revocation check that waits up to about 5 minutes (`pnpm smoke --skip-revoke-check` skips it and reports it as SKIP, pending), prints a table and exits non-zero if a check failed. It logs `isBase64Encoded` of a JSON publish (S9) and the runtime's SDK versions (S19). The viewing-plane checks S20–S41 follow (see (l)); `pnpm smoke --skip-view` runs S1–S19 only.

Manual MCP check from a laptop with Claude Code, then ask it to publish, list, read and roll back an artifact:

```sh
claude mcp add --transport http artifacts https://api.artifact.nikovirtala.dev/mcp --header "Authorization: Bearer $ARTIFACT_TOKEN"
```

The CLI works the same way: `artifact publish page.html --server https://api.artifact.nikovirtala.dev` with `ARTIFACT_TOKEN` set.

## (h) Teardown

Capture the names first; the outputs disappear with the stacks:

```sh
BUCKET=$(aws cloudformation describe-stacks --region eu-north-1 --stack-name artifact-prod-platform \
  --query "Stacks[0].Outputs[?starts_with(OutputKey,'ArtifactsBucketName')].OutputValue" --output text)
ZONE_ID=$(aws cloudformation describe-stacks --region us-east-1 --stack-name artifact-prod-dns \
  --query "Stacks[0].Outputs[?OutputKey=='HostedZoneId'].OutputValue" --output text)
echo "$BUCKET $ZONE_ID"
```

Write them down, then:

```sh
pnpm exec cdk destroy prod/Platform prod/Certificate
pnpm retention-check bucket --bucket "$BUCKET" --region eu-north-1 --expect present
```

Destroying `prod/Platform` also removes the viewing plane: the distribution (CloudFront disables, then deletes it, which takes about 15 minutes), the KeyValueStore, the viewing and session-keys functions, the session secret, the Cognito app client, login domain and owner users (the user pool itself is `DESTROY`, as in M9), and the DNS records of the view domain. The bucket is retained by default (`RETAIN`), so the check passes while the data stays. To remove the data too:

```sh
aws s3 rm "s3://$BUCKET" --recursive && aws s3api delete-bucket --bucket "$BUCKET" --region eu-north-1
```

`pnpm exec cdk destroy prod/Dns` leaves the hosted zone (also retained). To remove it: delete the `NS` record from the parent zone, delete any records in the zone other than its NS and SOA, then:

```sh
aws route53 delete-hosted-zone --id "$ZONE_ID"
```

## (i) Tarball app checks (C3 `DESTROY` and scheduled prune, C4)

Run after (e) and before (h), while the zone exists. A fresh `cdk init` app deploys the construct from the packed tarball, with no repo source, esbuild or Docker; it serves `tarball.artifact.nikovirtala.dev` and `api.tarball.artifact.nikovirtala.dev`.

1. Pack the package:

   ```sh
   cd "$REPO" && pnpm pack
   ```

2. Create the app and install the tarball with the tested CDK versions:

   ```sh
   mkdir /tmp/tarball-app && cd /tmp/tarball-app && npx --yes aws-cdk@2.1145.0 init app --language typescript --generate-only && npm install "$REPO"/nikovirtala-artifact-*.tgz aws-cdk-lib@2.273.0 constructs@10.8.1 --no-audit --no-fund
   ```

3. Replace `bin/tarball-app.ts` with:

   ```ts
   #!/usr/bin/env node
   import * as cdk from "aws-cdk-lib";
   import { TarballAppStack } from "../lib/tarball-app-stack";
   const app = new cdk.App();
   new TarballAppStack(app, "TarballAppStack", { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" } });
   ```

   and `lib/tarball-app-stack.ts` with:

   ```ts
   import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
   import { HostedZone } from "aws-cdk-lib/aws-route53";
   import type { Construct } from "constructs";
   import { ArtifactHosting, ArtifactIdentity } from "@nikovirtala/artifact/cdk";
   export class TarballAppStack extends Stack {
     constructor(scope: Construct, id: string, props?: StackProps) {
       super(scope, id, props);
       const zoneName = this.node.getContext("zoneName");
       const hostedZone = HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: this.node.getContext("zoneId"), zoneName });
       new ArtifactHosting(this, "Artifacts", {
         viewDomain: { name: `tarball.${zoneName}`, hostedZone },
         apiDomain: { name: `api.tarball.${zoneName}` },
         identity: ArtifactIdentity.cognito({ owners: (process.env.ARTIFACT_OWNERS ?? "").split(",") }),
         dataRetention: { onDestroy: RemovalPolicy.DESTROY, versions: { keepLast: 2 } },
         viewing: { reservedConcurrency: false },
       });
     }
   }
   ```

   The tarball app runs in us-east-1 and carries the viewing plane. This deploy also creates a CloudFront distribution and a us-east-1 view certificate for `tarball.artifact.nikovirtala.dev` + `*.tarball.artifact.nikovirtala.dev` (DNS-validated in the live zone, about 10 minutes), and a second Cognito pool, so **each `ARTIFACT_OWNERS` address gets one more Cognito invitation email** (for the tarball pool); ignore it.

4. Deploy, then show the C4 evidence: esbuild appears only under `tsx` (the template's TypeScript runner, not the construct), and every deployed handler is byte-identical to a bundle in the tarball (`control`, `sweep`, `viewing`, `session-keys`; expect no `MISMATCH` and the count `4`; CDK's own auto-delete handler is `index.js` and not counted):

   ```sh
   ZONE_ID=$(aws cloudformation describe-stacks --region us-east-1 --stack-name artifact-prod-dns \
     --query "Stacks[0].Outputs[?OutputKey=='HostedZoneId'].OutputValue" --output text)
   npx cdk deploy -c zoneName=artifact.nikovirtala.dev -c zoneId="$ZONE_ID"
   npm ls esbuild
   A=node_modules/@nikovirtala/artifact/dist/assets; for f in cdk.out/asset.*/index.mjs; do cmp -s "$f" $A/control/index.mjs || cmp -s "$f" $A/sweep/index.mjs || cmp -s "$f" $A/viewing/index.mjs || cmp -s "$f" $A/session-keys/index.mjs || echo "MISMATCH $f"; done; ls cdk.out/asset.*/index.mjs | wc -l
   ```

5. Check the scheduled prune: a temporary token, 4 versions, rollback to v1, the sweep function invoked with the prune schedule's exact input, then versions `[1,3,4]` with v1 current and version 2 gone:

   ```sh
   cd "$REPO/examples/personal" && pnpm retention-check prune --stack TarballAppStack --region us-east-1
   ```

6. Destroy it and check that `DESTROY` removed the bucket (allow about 15 minutes for `cdk destroy`: CloudFront disables, then deletes the distribution):

   ```sh
   TBUCKET=$(aws cloudformation describe-stacks --region us-east-1 --stack-name TarballAppStack --query "Stacks[0].Outputs[?starts_with(OutputKey,'ArtifactsBucketName')].OutputValue" --output text)
   echo "$TBUCKET"
   cd /tmp/tarball-app && npx cdk destroy -c zoneName=artifact.nikovirtala.dev -c zoneId="$ZONE_ID" --force
   cd "$REPO/examples/personal" && pnpm retention-check bucket --bucket "$TBUCKET" --region us-east-1 --expect absent
   ```

## (j) Deploy the M10 update

For a stage deployed with M9. In a session with (a), (b) and the session variables, rebuild, then run the diff gate. It must print nothing: it matches only resource-level removals and replacements, and the full diff stays in `/tmp/m10.diff`. If it prints anything, stop and report.

```sh
cd "$REPO" && pnpm install --frozen-lockfile && pnpm build && cd "$REPO/examples/personal"
pnpm exec cdk diff --no-color --no-notices prod/Certificate prod/Platform 2>&1 | tee /tmp/m10.diff | grep -nE "requires replacement|may be replaced|^\[-\] |^\[~\] .* replace$"
```

The diff shows `[~]` for the control and sweep functions (`Code`, an in-place code update) and for `ExportsReader`; everything else is added. Then deploy (about 10 minutes, because of CloudFront) and run the viewing checks:

```sh
pnpm exec cdk deploy prod/Certificate prod/Platform
pnpm smoke --view-only
```

S1 and S20 confirm the API, and S40 confirms that login can set cookies. **If S40 fails, stop before (k):** do not change the cookie allowlist or any policy, and paste the S40 row back for the owner's decision.

- The Cognito invitation email is sent during this deploy.
- After it, `GET /api` reports `0.0.0-development`, the checkout's placeholder version, and the CLI prints its major-version warning against this server; this is expected and harmless. Run the smoke only after the deploy: before it, S1 fails on the version major (`server 1.0.0, repo 0.0.0-development`).

## (k) Owner sign-in

The email "Your temporary password" arrives within minutes (the sender is `no-reply` at `verificationemail.com`). Sign in **within 7 days** at `https://artifact.nikovirtala.dev/`, which redirects to the Cognito sign-in page: enter the email and the temporary password, set a new password, and you land on the gallery.

If the invitation expired, resend it (your write, from CloudShell; `POOL` is the `UserPoolId` output):

```sh
POOL=$(aws cloudformation describe-stacks --region eu-north-1 --stack-name artifact-prod-platform \
  --query "Stacks[0].Outputs[?starts_with(OutputKey,'ArtifactsUserPoolId')].OutputValue" --output text)
aws cognito-idp admin-create-user --region eu-north-1 --user-pool-id "$POOL" --username <email> --message-action RESEND --desired-delivery-mediums EMAIL
```

## (l) Smoke the viewing plane

```sh
pnpm smoke
# or only S1 and the viewing checks (about 2 minutes; up to 8 right after a rotation):
pnpm smoke --view-only
```

It reads the session secret with your credentials and mints session cookies from it; the key and the cookies are never printed. The S40 stop rule from (j) applies here too. **S35 with a 403** means the request never reached the viewing code, so traversal is still blocked (fail closed), but the expected 400 is not shown: change nothing, and report the S35 row.

## (m) Latency

Open CloudShell **in eu-north-1** (the nearby client) and repeat (a), (b) and the session variables there, with `ARTIFACT_TOKEN` set. The edge-compute row calls `cloudfront:DescribeFunction` and `cloudfront:TestFunction`, which an administrator role has.

```sh
pnpm latency warm
# wait at least 30 minutes without opening the viewing plane; idle refuses to run earlier
pnpm latency idle
pnpm latency report
```

`report` prints a Markdown table: paste it back. It also deletes the two latency artifacts (`--keep` keeps them). The state between the phases is `$HOME/.artifact-latency.json` (ids, timestamps and results only), which survives CloudShell sessions; `idle` can be repeated, 30 minutes apart.

## (n) Browser checklist

After (k), in a browser:

- **B1** The gallery lists the artifacts, and an artifact URL opens with no second sign-in prompt.
- **B2** Artifacts cannot read each other's storage. In CloudShell, with `ARTIFACT_TOKEN` set and `export ARTIFACT_SERVER=https://api.artifact.nikovirtala.dev`:

  ```sh
  mkdir -p iso-a iso-b
  printf '%s\n' '<!doctype html><script>localStorage.k = "A"; document.write("k=" + localStorage.k)</script>' > iso-a/index.html
  printf '%s\n' '<!doctype html><script>document.write("k=" + localStorage.getItem("k"))</script>' > iso-b/index.html
  artifact publish iso-a --title iso-a
  artifact publish iso-b --title iso-b
  ```

  Open A's URL: it shows `k=A`. Then open B's URL: it shows `k=null`. DevTools → Application shows separate storage per origin.
- **B3** Open `https://artifact.nikovirtala.dev/__artifact/login?return=https://example.com/` and sign in: you land on the gallery, not on example.com.
- **B4** DevTools → Cookies: `__Secure-artifact_session` is `HttpOnly`, `Secure`, `Domain=artifact.nikovirtala.dev`, and expires in about 30 days.
- **B5** A hard refresh right after `artifact publish` shows the new version.
- **B6** `https://artifact.nikovirtala.dev/__artifact/logout` leads to the sign-in page; an artifact URL then asks you to sign in again.

## (o) Rotate the session key

Rotation is your change; nothing rotates on its own. In `lib/stages.ts`, give the `prod` stage a new label (the default is `"1"`), commit it so later deploys keep it, deploy the platform and re-run the viewing checks:

```ts
viewing: { sessionKeyRotation: "2" },
```

```sh
pnpm exec cdk deploy prod/Platform
pnpm smoke --view-only
```

S38 passes when the edge accepts both the previous and the current key, and S41 when new sign-ins are signed with the new key; that can take up to 6 minutes because of the viewing Lambda's key cache. Cookies signed with the old key keep working as "previous" until the next rotation, so rotating twice in a row signs everyone out.

## Known limits

- Publishes are limited to 3 MiB per file and per publish, with a 4,500,000-byte request body ([0066](../../docs/decisions/0066-control-lambda.md)). Text with many characters to escape can hit the body cap a little earlier. A request whose Lambda event would exceed 6 MB gets API Gateway's error instead of `too_large`.
- `artifact token create` and `revoke` are last-writer-wins: run them from one place at a time.
- A pruned pinned version, or any pinned `/v/<n>/` file of a **deleted** artifact, may be served from the edge (to signed-in owners only, behind the cookie) until it expires, for up to a year.
- No live reload on AWS until M11.
- The viewing Lambda's reserved concurrency cap (default 20) needs an account concurrency limit of at least 120 (Lambda keeps 100 unreserved); on smaller accounts, including new accounts that start at 10, set `viewing: { reservedConcurrency: false }`.
- This checkout deploys version `0.0.0-development`: `GET /api` reports it and the CLI warns that major versions differ; harmless.
- After enabling `provisionedConcurrency`, re-run `pnpm smoke --view-only` (S23, S37).
