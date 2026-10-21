// The control plane of `ArtifactHosting` (docs/decisions/0071, 0072): functions from the
// prebuilt assets, the HTTP API on a Regional custom domain, the token secret, alarms, outputs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Template } from "aws-cdk-lib/assertions";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { CONTROL_ROUTE_KEYS } from "../../src/cdk/index.ts";
import { API, hosting, resources } from "./helpers.ts";

const ACCESS_LOG_KEYS = [
  "requestId",
  "time",
  "method",
  "path",
  "routeKey",
  "protocol",
  "status",
  "responseLength",
  "latency",
  "integrationLatency",
  "integrationStatus",
  "integrationError",
  "error",
  "sourceIp",
  "domain",
];

describe("functions", () => {
  it("run nodejs24.x on arm64 from the prebuilt assets with the AWS limits", () => {
    const { template } = hosting();
    // The viewing and session-keys functions are in viewing-plane.test.ts.
    const functions = resources(template, "AWS::Lambda::Function").filter(([id]) =>
      /^Artifacts(Control|Sweep)Function/.test(id),
    );
    assert.equal(functions.length, 2);
    const byMemory = Object.fromEntries(
      functions.map(([, f]) => [f.Properties?.MemorySize as number, f.Properties]),
    );
    for (const [memory, timeout] of [
      [1024, 30],
      [512, 300],
    ]) {
      const f = byMemory[memory] as Record<string, unknown>;
      assert.equal(f.Runtime, "nodejs24.x");
      assert.deepEqual(f.Architectures, ["arm64"]);
      assert.equal(f.Handler, "index.handler");
      assert.equal(f.Timeout, timeout);
      assert.equal(f.FunctionName, undefined);
      assert.match(JSON.stringify(f.Code), /\.zip/);
    }
    const control = (byMemory[1024] as { Environment: { Variables: Record<string, unknown> } })
      .Environment.Variables;
    assert.equal(control.ARTIFACT_MAX_BODY_BYTES, "4500000");
    assert.equal(
      control.ARTIFACT_LIMITS,
      '{"maxFileBytes":3145728,"maxPublishBytes":3145728,"maxFiles":500}',
    );
    assert.equal(control.ARTIFACT_VIEW_DOMAIN, "art.example.dev");
  });
});

describe("HTTP API", () => {
  it("has exactly the three routes, payload 2.0, no execute-api endpoint", () => {
    const { template } = hosting();
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      DisableExecuteApiEndpoint: true,
    });
    const keys = resources(template, "AWS::ApiGatewayV2::Route").map(
      ([, r]) => r.Properties?.RouteKey,
    );
    assert.deepEqual(keys.sort(), Object.values(CONTROL_ROUTE_KEYS).sort());
    template.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "2.0",
    });
  });

  it("has a $default stage with throttling and a header-free access log", () => {
    const { template } = hosting();
    const [[, stage]] = resources(template, "AWS::ApiGatewayV2::Stage");
    const props = stage.Properties as {
      StageName: string;
      AutoDeploy: boolean;
      DefaultRouteSettings: Record<string, number>;
      AccessLogSettings: { Format: string };
    };
    assert.equal(props.StageName, "$default");
    assert.equal(props.AutoDeploy, true);
    assert.deepEqual(props.DefaultRouteSettings, {
      ThrottlingBurstLimit: 40,
      ThrottlingRateLimit: 20,
    });
    const format = props.AccessLogSettings.Format;
    assert.deepEqual(Object.keys(JSON.parse(format)), ACCESS_LOG_KEYS);
    for (const forbidden of ["header", "userAgent", "$input", "$request", "cookie"]) {
      assert.ok(!format.toLowerCase().includes(forbidden.toLowerCase()), forbidden);
    }
    const throttled = hosting({ throttle: { rateLimit: 5, burstLimit: 10 } }).template;
    throttled.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
    });
  });

  it("is mapped at the root of a Regional TLS 1.2 domain with an A alias", () => {
    const { template } = hosting();
    template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainName: API,
      DomainNameConfigurations: [{ EndpointType: "REGIONAL", SecurityPolicy: "TLS_1_2" }],
    });
    const [[, mapping]] = resources(template, "AWS::ApiGatewayV2::ApiMapping");
    assert.equal(mapping.Properties?.ApiMappingKey, undefined);
    const records = resources(template, "AWS::Route53::RecordSet").filter(([id]) =>
      id.startsWith("ArtifactsApiAliasRecord"),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0][1].Properties?.Type, "A");
    assert.equal(records[0][1].Properties?.Name, `${API}.`);
    assert.ok(records[0][1].Properties?.AliasTarget);
  });

  it("creates a DNS-validated API certificate unless one is given", () => {
    const created = hosting().template;
    created.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    created.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: API,
      ValidationMethod: "DNS",
    });

    const arn =
      "arn:aws:acm:eu-north-1:123456789012:certificate/00000000-0000-0000-0000-000000000000";
    const { stack } = hosting();
    const given = Certificate.fromCertificateArn(stack, "Given", arn);
    const { template } = hosting({ apiDomain: { name: API, certificate: given } });
    template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainNameConfigurations: [{ CertificateArn: arn }],
    });
  });
});

describe("token secret", () => {
  it("is exactly the empty list, deleted with the stack (frozen, ADR 0065)", () => {
    const { template } = hosting();
    const secrets = resources(template, "AWS::SecretsManager::Secret").filter(([id]) =>
      id.startsWith("ArtifactsTokenSecret"),
    );
    assert.equal(secrets.length, 1);
    const [, secret] = secrets[0];
    assert.deepEqual(secret.Properties, { SecretString: '{"version":1,"tokens":[]}' });
    assert.equal(secret.DeletionPolicy, "Delete");
    assert.equal(secret.UpdateReplacePolicy, "Delete");
  });
});

describe("alarms", () => {
  it("exist only with alarmEmail: a topic, its subscription and four alarms", () => {
    const none = hosting().template;
    none.resourceCountIs("AWS::SNS::Topic", 0);
    none.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    const { template, construct } = hosting({ alarmEmail: "ops@example.com" });
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "ops@example.com",
    });
    const alarms = resources(template, "AWS::CloudWatch::Alarm").map(([, a]) => a.Properties);
    assert.deepEqual(
      alarms.map((a) => [a?.MetricName, a?.Threshold, a?.Period, a?.TreatMissingData]).sort(),
      [
        ["5xx", 5, 300, "notBreaching"],
        ["Errors", 1, 300, "notBreaching"],
        ["Errors", 1, 300, "notBreaching"],
        ["Errors", 1, 3600, "notBreaching"],
      ],
    );
    assert.ok(construct.alarmTopic);
  });
});

describe("outputs", () => {
  it("name the API, view, secret, bucket, log groups, sweep function and viewing plane", () => {
    const { template } = hosting();
    const names = Object.keys(template.toJSON().Outputs).map((o) => o.replace(/[0-9A-F]{8}$/, ""));
    assert.deepEqual(names.sort(), [
      "ArtifactsAccessLogGroupName",
      "ArtifactsApiUrl",
      "ArtifactsBucketName",
      "ArtifactsControlLogGroupName",
      "ArtifactsDistributionDomainName",
      "ArtifactsDistributionId",
      "ArtifactsKeyValueStoreArn",
      "ArtifactsLoginDomainUrl",
      "ArtifactsSessionKeysLogGroupName",
      "ArtifactsSessionSecretArn",
      "ArtifactsSweepFunctionName",
      "ArtifactsTokenSecretArn",
      "ArtifactsUserPoolClientId",
      "ArtifactsUserPoolId",
      "ArtifactsViewFunctionUrl",
      "ArtifactsViewLogGroupName",
      "ArtifactsViewUrl",
      "ArtifactsViewerRequestFunctionName",
    ]);
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    const value = (name: string) =>
      Object.entries(outputs).find(([k]) => k.startsWith(name))?.[1].Value;
    assert.equal(value("ArtifactsApiUrl"), `https://${API}`);
    assert.equal(value("ArtifactsViewUrl"), "https://art.example.dev/");
    assert.ok(Template.fromJSON(template.toJSON()));
  });
});
