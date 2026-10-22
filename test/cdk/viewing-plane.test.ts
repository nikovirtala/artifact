// The viewing plane of `ArtifactHosting` (docs/decisions/0082, 0083, 0085): the viewing function
// behind an AWS_IAM function URL and OAC, the distribution with its policies, behaviours, edge
// function and records, the session keys, the alarm and the outputs.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { renderEdgeFunction } from "../../src/cdk/edge.ts";
import { ArtifactHosting } from "../../src/cdk/index.ts";
import {
  ACCOUNT,
  API,
  baseProps,
  hosting,
  resources,
  testZone,
  VIEW,
  VIEW_CERTIFICATE_ARN,
} from "./helpers.ts";

const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/session-vectors.json", import.meta.url), "utf8"),
) as { keys: Record<string, string> };
const EDGE_DIST = new URL("../../dist/assets/edge/viewer-request.js", import.meta.url);
/** The managed CachingDisabled policy. */
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ERROR_CODES = [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504];
const LOGIN_PATHS = ["/__artifact/login", "/__artifact/callback", "/__artifact/logout"];

type Built = ReturnType<typeof hosting>;

/** The one resource of `type` whose logical id is `Artifacts<id><8 hex>`. */
function one(built: Built, type: string, id: string) {
  const found = resources(built.template, type).filter(([logicalId]) =>
    new RegExp(`^Artifacts${id}[0-9A-F]{8}$`).test(logicalId),
  );
  assert.equal(found.length, 1, `${type} ${id}`);
  return found[0];
}
const ref = (built: Built, type: string, id: string) => ({ Ref: one(built, type, id)[0] });
const getAtt = (built: Built, type: string, id: string, attribute: string) => ({
  "Fn::GetAtt": [one(built, type, id)[0], attribute],
});

/** The deep property of `value` at `path`, for terse assertions. */
const at = (value: unknown, ...path: string[]) =>
  path.reduce((v, key) => (v as Record<string, unknown>)?.[key], value);

describe("viewing function", () => {
  it("runs the viewing asset on nodejs24.x arm64 with a reserved cap of 20 and its own logs", () => {
    const built = hosting();
    const [, fn] = one(built, "AWS::Lambda::Function", "ViewFunction");
    const p = fn.Properties as Record<string, unknown>;
    assert.equal(p.Runtime, "nodejs24.x");
    assert.deepEqual(p.Architectures, ["arm64"]);
    assert.equal(p.MemorySize, 512);
    assert.equal(p.Timeout, 10);
    assert.equal(p.Handler, "index.handler");
    assert.equal(p.ReservedConcurrentExecutions, 20);
    assert.equal(p.FunctionName, undefined);
    assert.deepEqual(
      at(p, "LoggingConfig", "LogGroup"),
      ref(built, "AWS::Logs::LogGroup", "ViewLogGroup"),
    );
    const reserved = (reservedConcurrency: number | false) =>
      one(hosting({ viewing: { reservedConcurrency } }), "AWS::Lambda::Function", "ViewFunction")[1]
        .Properties?.ReservedConcurrentExecutions;
    assert.equal(reserved(false), undefined);
    assert.equal(reserved(5), 5);
  });

  it("is reached only through an AWS_IAM function URL behind an explicit OAC", () => {
    const built = hosting();
    const [, url] = one(built, "AWS::Lambda::Url", "ViewFunctionUrlResource");
    assert.deepEqual(url.Properties, {
      AuthType: "AWS_IAM",
      InvokeMode: "BUFFERED",
      TargetFunctionArn: getAtt(built, "AWS::Lambda::Function", "ViewFunction", "Arn"),
    });
    const [oacId, oac] = one(
      built,
      "AWS::CloudFront::OriginAccessControl",
      "ViewOriginAccessControl",
    );
    assert.deepEqual(
      { ...(at(oac.Properties, "OriginAccessControlConfig") as object), Name: undefined },
      {
        Name: undefined,
        OriginAccessControlOriginType: "lambda",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      },
    );
    const [, distribution] = one(built, "AWS::CloudFront::Distribution", "Distribution");
    const origins = at(distribution.Properties, "DistributionConfig", "Origins") as Record<
      string,
      unknown
    >[];
    assert.equal(origins.length, 1);
    assert.deepEqual(origins[0].OriginAccessControlId, { "Fn::GetAtt": [oacId, "Id"] });

    // CDK's two permissions: CloudFront, this distribution, the URL's function.
    const permissions = resources(built.template, "AWS::Lambda::Permission").filter(
      ([, p]) => p.Properties?.Principal === "cloudfront.amazonaws.com",
    );
    assert.deepEqual(
      permissions
        .map(([, p]) => [p.Properties?.Action, p.Properties?.InvokedViaFunctionUrl])
        .sort(),
      [
        ["lambda:InvokeFunction", true],
        ["lambda:InvokeFunctionUrl", undefined],
      ],
    );
    const distributionId = one(built, "AWS::CloudFront::Distribution", "Distribution")[0];
    for (const [, p] of permissions) {
      assert.deepEqual(
        p.Properties?.FunctionName,
        getAtt(built, "AWS::Lambda::Url", "ViewFunctionUrlResource", "FunctionArn"),
      );
      assert.match(
        JSON.stringify(p.Properties?.SourceArn),
        new RegExp(`"Ref":"${distributionId}"`),
      );
    }
    assert.equal(resources(built.template, "AWS::Lambda::Alias").length, 0);
  });

  it("with provisionedConcurrency: a live alias carries the URL and two own permissions", () => {
    const built = hosting({ viewing: { provisionedConcurrency: 2 } });
    const [aliasId, alias] = one(built, "AWS::Lambda::Alias", "ViewAlias");
    assert.equal(alias.Properties?.Name, "live");
    assert.deepEqual(alias.Properties?.ProvisionedConcurrencyConfig, {
      ProvisionedConcurrentExecutions: 2,
    });
    const [, url] = one(built, "AWS::Lambda::Url", "ViewFunctionUrlResource");
    assert.equal(url.Properties?.Qualifier, "live");
    const distributionArn = built.stack.resolve(built.construct.distribution.distributionArn);
    const own = resources(built.template, "AWS::Lambda::Permission").filter(
      ([, p]) => JSON.stringify(p.Properties?.FunctionName) === JSON.stringify({ Ref: aliasId }),
    );
    assert.deepEqual(own.map(([id]) => id.replace(/[0-9A-F]{8}$/, "")).sort(), [
      "ArtifactsViewAliasInvokePermission",
      "ArtifactsViewAliasInvokeUrlPermission",
    ]);
    for (const [id, p] of own) {
      assert.equal(p.Properties?.Principal, "cloudfront.amazonaws.com");
      assert.deepEqual(p.Properties?.SourceArn, distributionArn);
      if (id.startsWith("ArtifactsViewAliasInvokeUrlPermission")) {
        assert.equal(p.Properties?.Action, "lambda:InvokeFunctionUrl");
        assert.equal(p.Properties?.FunctionUrlAuthType, "AWS_IAM");
      } else {
        assert.equal(p.Properties?.Action, "lambda:InvokeFunction");
        assert.equal(p.Properties?.InvokedViaFunctionUrl, true);
      }
    }
    assert.ok(built.construct.viewAlias);
  });

  it("gets the viewing environment, with the issuer from the user pool", () => {
    const built = hosting();
    const vars = at(
      one(built, "AWS::Lambda::Function", "ViewFunction")[1].Properties,
      "Environment",
      "Variables",
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(vars).sort(), [
      "ARTIFACT_BUCKET",
      "ARTIFACT_OIDC_AUTHORIZE_URL",
      "ARTIFACT_OIDC_CLIENT_ID",
      "ARTIFACT_OIDC_ISSUER",
      "ARTIFACT_OIDC_LOGOUT_URL",
      "ARTIFACT_OIDC_TOKEN_URL",
      "ARTIFACT_OWNERS",
      "ARTIFACT_SESSION_SECRET_ARN",
      "ARTIFACT_VIEW_DOMAIN",
    ]);
    assert.equal(vars.ARTIFACT_VIEW_DOMAIN, VIEW);
    assert.equal(vars.ARTIFACT_OWNERS, '["owner@example.com"]');
    assert.deepEqual(
      vars.ARTIFACT_SESSION_SECRET_ARN,
      ref(built, "AWS::SecretsManager::Secret", "SessionSecret"),
    );
  });
});

describe("cache and origin request policies", () => {
  it("key the cache on x-artifact-host, path and query, never a cookie", () => {
    const built = hosting();
    const [, policy] = one(built, "AWS::CloudFront::CachePolicy", "ViewCachePolicy");
    const config = at(policy.Properties, "CachePolicyConfig") as Record<string, unknown>;
    assert.deepEqual(
      { ...config, Name: undefined },
      {
        Name: undefined,
        MinTTL: 0,
        DefaultTTL: 0,
        MaxTTL: 31_536_000,
        ParametersInCacheKeyAndForwardedToOrigin: {
          CookiesConfig: { CookieBehavior: "none" },
          HeadersConfig: { HeaderBehavior: "whitelist", Headers: ["x-artifact-host"] },
          QueryStringsConfig: { QueryStringBehavior: "all" },
          EnableAcceptEncodingGzip: true,
          EnableAcceptEncodingBrotli: true,
        },
      },
    );
  });

  it("forward x-artifact-host and the query; only the login policy forwards one cookie", () => {
    const built = hosting();
    const config = (id: string) => {
      const c = at(
        one(built, "AWS::CloudFront::OriginRequestPolicy", id)[1].Properties,
        "OriginRequestPolicyConfig",
      ) as Record<string, unknown>;
      return { ...c, Name: undefined };
    };
    const common = {
      Name: undefined,
      HeadersConfig: { HeaderBehavior: "whitelist", Headers: ["x-artifact-host"] },
      QueryStringsConfig: { QueryStringBehavior: "all" },
    };
    assert.deepEqual(config("ViewOriginRequestPolicy"), {
      ...common,
      CookiesConfig: { CookieBehavior: "none" },
    });
    assert.deepEqual(config("LoginOriginRequestPolicy"), {
      ...common,
      CookiesConfig: { CookieBehavior: "whitelist", Cookies: ["__Host-artifact_login"] },
    });
  });
});

describe("distribution", () => {
  it("serves the apex and the wildcard over TLS 1.2, HTTP/2 and 3, IPv6, without logs", () => {
    const built = hosting();
    const [, distribution] = one(built, "AWS::CloudFront::Distribution", "Distribution");
    const c = at(distribution.Properties, "DistributionConfig") as Record<string, unknown>;
    assert.deepEqual(c.Aliases, [VIEW, `*.${VIEW}`]);
    assert.deepEqual(c.ViewerCertificate, {
      AcmCertificateArn: VIEW_CERTIFICATE_ARN,
      MinimumProtocolVersion: "TLSv1.2_2021",
      SslSupportMethod: "sni-only",
    });
    assert.equal(c.HttpVersion, "http2and3");
    assert.equal(c.IPV6Enabled, true);
    assert.equal(c.Enabled, true);
    assert.equal(c.Logging, undefined);
    assert.equal(c.DefaultRootObject, undefined);
    assert.deepEqual(
      c.CustomErrorResponses,
      ERROR_CODES.map((ErrorCode) => ({ ErrorCode, ErrorCachingMinTTL: 0 })),
    );
    assert.deepEqual(distribution.DependsOn, [
      one(built, "Custom::ArtifactSessionKeys", "SessionKeys")[0],
    ]);
  });

  it("runs the edge function on every behaviour; the login paths do not cache", () => {
    const built = hosting();
    const c = at(
      one(built, "AWS::CloudFront::Distribution", "Distribution")[1].Properties,
      "DistributionConfig",
    ) as Record<string, unknown>;
    const functionAssociations = [
      {
        EventType: "viewer-request",
        FunctionARN: getAtt(
          built,
          "AWS::CloudFront::Function",
          "ViewerRequestFunction",
          "FunctionARN",
        ),
      },
    ];
    const origin = (at(c, "Origins") as { Id: string }[])[0].Id;
    const methods = {
      AllowedMethods: ["GET", "HEAD"],
      CachedMethods: ["GET", "HEAD"],
      ViewerProtocolPolicy: "redirect-to-https",
      TargetOriginId: origin,
      FunctionAssociations: functionAssociations,
    };
    assert.deepEqual(c.DefaultCacheBehavior, {
      ...methods,
      CachePolicyId: ref(built, "AWS::CloudFront::CachePolicy", "ViewCachePolicy"),
      OriginRequestPolicyId: ref(
        built,
        "AWS::CloudFront::OriginRequestPolicy",
        "ViewOriginRequestPolicy",
      ),
      Compress: true,
    });
    assert.deepEqual(
      c.CacheBehaviors,
      LOGIN_PATHS.map((PathPattern) => ({
        ...methods,
        PathPattern,
        CachePolicyId: CACHING_DISABLED,
        OriginRequestPolicyId: ref(
          built,
          "AWS::CloudFront::OriginRequestPolicy",
          "LoginOriginRequestPolicy",
        ),
        Compress: false,
      })),
    );
  });

  it("has a JS 2.0 viewer-request function with the KVS and the domain rendered in", () => {
    const built = hosting();
    const [, fn] = one(built, "AWS::CloudFront::Function", "ViewerRequestFunction");
    assert.equal(fn.Properties?.AutoPublish, true);
    assert.deepEqual(at(fn.Properties, "FunctionConfig", "Runtime"), "cloudfront-js-2.0");
    assert.deepEqual(at(fn.Properties, "FunctionConfig", "KeyValueStoreAssociations"), [
      { KeyValueStoreARN: getAtt(built, "AWS::CloudFront::KeyValueStore", "KeyValueStore", "Arn") },
    ]);
    const code = fn.Properties?.FunctionCode as string;
    assert.equal(code, renderEdgeFunction(readFileSync(EDGE_DIST, "utf8"), VIEW));
    assert.ok(code.includes(`const VIEW_DOMAIN = "${VIEW}";`));
    assert.ok(!code.includes("__ARTIFACT_VIEW_DOMAIN__"));
  });

  it("has apex and wildcard A and AAAA aliases, and keeps the api record", () => {
    const built = hosting();
    const dnsName = getAtt(built, "AWS::CloudFront::Distribution", "Distribution", "DomainName");
    for (const [id, Type, Name] of [
      ["ViewAliasRecord", "A", `${VIEW}.`],
      ["ViewAliasRecordAaaa", "AAAA", `${VIEW}.`],
      ["ViewWildcardRecord", "A", `*.${VIEW}.`],
      ["ViewWildcardRecordAaaa", "AAAA", `*.${VIEW}.`],
    ]) {
      const [, record] = one(built, "AWS::Route53::RecordSet", id);
      assert.equal(record.Properties?.Type, Type, id);
      assert.equal(record.Properties?.Name, Name, id);
      assert.deepEqual(at(record.Properties, "AliasTarget", "DNSName"), dnsName, id);
    }
    const [, api] = one(built, "AWS::Route53::RecordSet", "ApiAliasRecord");
    assert.equal(api.Properties?.Name, `${API}.`);
    assert.equal(resources(built.template, "AWS::Route53::RecordSet").length, 5);
  });
});

describe("session keys", () => {
  it("pins the placeholder secret and creates an empty KVS", () => {
    const built = hosting();
    const [, secret] = one(built, "AWS::SecretsManager::Secret", "SessionSecret");
    assert.deepEqual(secret.Properties, { SecretString: '{"version":1,"current":null,"keys":{}}' });
    assert.equal(secret.DeletionPolicy, "Delete");
    assert.equal(secret.UpdateReplacePolicy, "Delete");
    const [, kvs] = one(built, "AWS::CloudFront::KeyValueStore", "KeyValueStore");
    assert.deepEqual(Object.keys(kvs.Properties ?? {}), ["Name"]);
  });

  it("provisions them with a custom resource on the session-keys function, no Provider", () => {
    const built = hosting();
    const [, fn] = one(built, "AWS::Lambda::Function", "SessionKeysFunction");
    const p = fn.Properties as Record<string, unknown>;
    assert.equal(p.Runtime, "nodejs24.x");
    assert.deepEqual(p.Architectures, ["arm64"]);
    assert.equal(p.MemorySize, 256);
    assert.equal(p.Timeout, 120);
    assert.equal(p.Handler, "index.handler");
    assert.deepEqual(
      at(p, "LoggingConfig", "LogGroup"),
      ref(built, "AWS::Logs::LogGroup", "SessionKeysLogGroup"),
    );
    const [, resource] = one(built, "Custom::ArtifactSessionKeys", "SessionKeys");
    assert.deepEqual(resource.Properties, {
      ServiceToken: getAtt(built, "AWS::Lambda::Function", "SessionKeysFunction", "Arn"),
      ServiceTimeout: "300",
      SecretArn: ref(built, "AWS::SecretsManager::Secret", "SessionSecret"),
      KeyValueStoreArn: getAtt(built, "AWS::CloudFront::KeyValueStore", "KeyValueStore", "Arn"),
      Rotation: "1",
    });
    const rotated = hosting({ viewing: { sessionKeyRotation: "2026-10" } });
    assert.equal(
      one(rotated, "Custom::ArtifactSessionKeys", "SessionKeys")[1].Properties?.Rotation,
      "2026-10",
    );
  });

  it("puts no key material into the template or cdk.out", () => {
    const { app } = hosting();
    const dir = app.synth().directory;
    for (const file of globSync("**/*", { cwd: dir, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const text = readFileSync(join(file.parentPath, file.name), "utf8");
      for (const key of Object.values(vectors.keys)) assert.ok(!text.includes(key), file.name);
      assert.doesNotMatch(text, /"key"\s*:\s*"[A-Za-z0-9_-]{43}"/, file.name);
    }
  });
});

describe("names", () => {
  const NAMED: [string, string, string, number][] = [
    [
      "AWS::CloudFront::OriginRequestPolicy",
      "ViewOriginRequestPolicy",
      "OriginRequestPolicyConfig",
      128,
    ],
    [
      "AWS::CloudFront::OriginRequestPolicy",
      "LoginOriginRequestPolicy",
      "OriginRequestPolicyConfig",
      128,
    ],
    ["AWS::CloudFront::KeyValueStore", "KeyValueStore", "", 64],
    [
      "AWS::CloudFront::OriginAccessControl",
      "ViewOriginAccessControl",
      "OriginAccessControlConfig",
      64,
    ],
  ];
  const names = (built: Built) =>
    NAMED.map(([type, id, config]) => {
      const p = one(built, type, id)[1].Properties;
      return (config === "" ? at(p, "Name") : at(p, config, "Name")) as string;
    });

  it("are distinct, within their limits and carry the Region", () => {
    const built = hosting();
    const values = names(built);
    assert.equal(new Set(values).size, 4);
    for (const [i, name] of values.entries()) {
      assert.equal(typeof name, "string");
      assert.ok(name.endsWith("-eu-north-1"), name);
      assert.ok(name.length + "-southeast-".length <= NAMED[i][3], name);
      assert.match(name, /^[A-Za-z0-9-]+$/);
    }
    const west = (() => {
      const app = new App();
      const stack = new Stack(app, "Test", { env: { account: ACCOUNT, region: "eu-west-1" } });
      const construct = new ArtifactHosting(stack, "Artifacts", baseProps(testZone(stack)));
      return { app, stack, construct, template: Template.fromStack(stack) };
    })();
    for (const [i, name] of names(west).entries()) assert.notEqual(name, values[i]);
  });
});

describe("outputs and logical ids", () => {
  const NEW_OUTPUTS = [
    "DistributionId",
    "DistributionDomainName",
    "ViewFunctionUrl",
    "ViewLogGroupName",
    "ViewerRequestFunctionName",
    "KeyValueStoreArn",
    "SessionSecretArn",
    "SessionKeysLogGroupName",
    "UserPoolId",
    "UserPoolClientId",
    "LoginDomainUrl",
  ];

  it("has each of the eleven new outputs exactly once, named like the scripts expect", () => {
    const { template } = hosting();
    const outputs = Object.keys(template.toJSON().Outputs);
    for (const name of NEW_OUTPUTS) {
      const re = new RegExp(`^Artifacts${name}[0-9A-F]{8}$`);
      assert.equal(outputs.filter((o) => re.test(o)).length, 1, name);
    }
  });

  it("names the function URL ViewFunctionUrlResource and its output ViewFunctionUrl", () => {
    // CDK forbids two children with one id in a scope, and both live under the construct.
    const built = hosting();
    const [urlId] = one(built, "AWS::Lambda::Url", "ViewFunctionUrlResource");
    const outputs = built.template.toJSON().Outputs as Record<string, { Value: unknown }>;
    const [outputId] = Object.keys(outputs).filter((o) =>
      /^ArtifactsViewFunctionUrl[0-9A-F]{8}$/.test(o),
    );
    assert.ok(outputId);
    assert.deepEqual(outputs[outputId].Value, { "Fn::GetAtt": [urlId, "FunctionUrl"] });
  });

  it("gives the new resources Artifacts<Id> logical ids with no intermediate segment", () => {
    const built = hosting({ alarmEmail: "ops@example.com" });
    for (const [type, id] of [
      ["AWS::Logs::LogGroup", "ViewLogGroup"],
      ["AWS::IAM::Role", "ViewRole"],
      ["AWS::Lambda::Function", "ViewFunction"],
      ["AWS::Lambda::Url", "ViewFunctionUrlResource"],
      ["AWS::CloudFront::OriginAccessControl", "ViewOriginAccessControl"],
      ["AWS::CloudFront::CachePolicy", "ViewCachePolicy"],
      ["AWS::CloudFront::OriginRequestPolicy", "ViewOriginRequestPolicy"],
      ["AWS::CloudFront::OriginRequestPolicy", "LoginOriginRequestPolicy"],
      ["AWS::CloudFront::KeyValueStore", "KeyValueStore"],
      ["AWS::CloudFront::Function", "ViewerRequestFunction"],
      ["AWS::CloudFront::Distribution", "Distribution"],
      ["AWS::SecretsManager::Secret", "SessionSecret"],
      ["AWS::Logs::LogGroup", "SessionKeysLogGroup"],
      ["AWS::IAM::Role", "SessionKeysRole"],
      ["AWS::Lambda::Function", "SessionKeysFunction"],
      ["Custom::ArtifactSessionKeys", "SessionKeys"],
      ["AWS::CloudWatch::Alarm", "ViewErrorsAlarm"],
    ]) {
      one(built, type, id);
    }
    const text = JSON.stringify(built.template.toJSON());
    assert.doesNotMatch(text, /ArtifactsViewing/);
  });
});

describe("alarm", () => {
  it("alarms on any viewing function error in 5 minutes, only with alarmEmail", () => {
    assert.equal(resources(hosting().template, "AWS::CloudWatch::Alarm").length, 0);
    const built = hosting({ alarmEmail: "ops@example.com" });
    const [, alarm] = one(built, "AWS::CloudWatch::Alarm", "ViewErrorsAlarm");
    const p = alarm.Properties as Record<string, unknown>;
    assert.equal(p.MetricName, "Errors");
    assert.equal(p.Statistic, "Sum");
    assert.equal(p.Period, 300);
    assert.equal(p.Threshold, 1);
    assert.equal(p.ComparisonOperator, "GreaterThanOrEqualToThreshold");
    assert.deepEqual(p.Dimensions, [
      { Name: "FunctionName", Value: ref(built, "AWS::Lambda::Function", "ViewFunction") },
    ]);
    assert.deepEqual(p.AlarmActions, [ref(built, "AWS::SNS::Topic", "AlarmTopic")]);
  });
});
