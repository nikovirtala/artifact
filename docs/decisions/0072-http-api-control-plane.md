# 0072. Control plane on an HTTP API: Regional custom domain, three routes, explicit access log

Status: Accepted (M9)

## Context

The plan puts `/api` and `/mcp` behind an API Gateway HTTP API on `api.<view domain>` rather than behind CloudFront with a Lambda function URL, relying on fact **V4**, and lets the API host coexist with M10's `*.<view domain>` distribution, relying on fact **V5**. The access log must not record the session cookie the API host receives.

### V4 result: holds

A Lambda function URL behind CloudFront with origin access control needs the payload hash: for `PUT` and `POST`, users must compute the SHA-256 of the body and send it in `x-amz-content-sha256`, because Lambda does not support unsigned payloads ([Restrict access to a Lambda function URL origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)). The CLI, Claude Code (`claude mcp add --transport http … --header`) and other MCP clients do not send that header, so API Gateway stays in front of `/api` and `/mcp`.

### V5 result: holds (deployed confirmation in M10, when the distribution exists)

1. HTTP APIs have Regional custom domains only; edge-optimized (CloudFront-backed) domains are for REST APIs ([HTTP API custom domain names](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-custom-domain-names.html); [API Gateway domain certificates](https://repost.aws/knowledge-center/api-gateway-domain-certificate)). So `api.artifact.nikovirtala.dev` is never a CloudFront alternate domain name.
2. CloudFront's alternate-domain overlap rule concerns two distributions; a wildcard such as `*.example.com` may overlap a specific name in another distribution, and CloudFront then routes by the more specific match ([Alternate domain names](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html)). With one distribution, a client whose DNS answer for the API host is the Regional endpoint never reaches CloudFront.
3. Route 53 answers a specific record before a wildcard ([Domain name format](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DomainNameFormat.html)).

The construct keeps the plan's guard that the API label directly below the view domain is never a 26-character artifact id, so M10's edge function never routes it.

## Decision

- **API:** `HttpApi` with no default stage and `disableExecuteApiEndpoint: true`, so the custom domain is the only way in and the "any Host" control app (0056) only ever sees the API host. Routes are built from `CONTROL_ROUTE_KEYS`: `ANY /api`, `ANY /api/{proxy+}` and `ANY /mcp`, all to one Lambda integration with payload format 2.0. Everything else gets API Gateway's 404 without invoking Lambda.
- **Stage:** `$default`, auto-deploy, throttling 20 requests per second with bursts of 40 (the `throttle` prop), mapped at the root of the domain so `rawPath` is the full path (A4).
- **Domain:** Regional endpoint, TLS 1.2 (the only policy HTTP API domains support), a certificate in the stack's Region (given, or created and DNS-validated in the API zone), and a Route 53 A alias record to the Regional domain name. API Gateway needs a Regional, same-Region ACM certificate; with Route 53, an A alias is the recommended record; the first Regional custom domain creates the `AWSServiceRoleForAPIGateway` service-linked role ([Regional custom domain names](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-regional-api-custom-domain-create.html), A3 and A12). No AAAA record, since dual-stack Regional endpoints were not verified.
- **Access log:** a JSON line with exactly these `$context` fields: `requestId`, `requestTimeEpoch`, `httpMethod`, `path`, `routeKey`, `protocol`, `status`, `responseLength`, `responseLatency`, `integrationLatency`, `integrationStatus`, `integrationErrorMessage`, `error.message`, `identity.sourceIp`, `domainName`. The format must include `$context.requestId`; no header is logged unless named, and `$context.identity.userAgent` (the `User-Agent` header) is left out ([HTTP API logging variables](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging-variables.html), A5). The access log group is deleted with the stack, like the function log groups.
- **Timeout:** the control function's 30 s matches the HTTP API's maximum integration timeout (A6).
- **Route keys in logs:** `$context.routeKey` and `requestContext.routeKey` carry the selected route's key, so a `POST /api/artifacts` is logged as `ANY /api/{proxy+}` ([HTTP API routes](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-routes.html), A17). The exact `$context.path` value for a `$default` stage behind a root-mapped domain is not documented (A19) and nothing relies on it.

## Consequences

The control plane costs nothing when idle, and a request carrying the view domain's session cookie leaves no trace of it in the access log (the control function strips it as well, 0066). A consumer who wants another API host outside the view domain passes `apiDomain.hostedZone`.
