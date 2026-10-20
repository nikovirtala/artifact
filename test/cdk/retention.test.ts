// `dataRetention` (docs/decisions/0067): a daily sweep always; a daily prune only with versions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Duration } from "aws-cdk-lib";
import { hosting, resources } from "./helpers.ts";

function schedules(template: ReturnType<typeof hosting>["template"]) {
  return resources(template, "AWS::Scheduler::Schedule").map(([, s]) => {
    const props = s.Properties as {
      ScheduleExpression: string;
      FlexibleTimeWindow: { Mode: string };
      Name?: string;
      Target: {
        Input: string;
        RetryPolicy: { MaximumRetryAttempts: number; MaximumEventAgeInSeconds: number };
      };
    };
    assert.equal(props.ScheduleExpression, "rate(1 day)");
    assert.deepEqual(props.FlexibleTimeWindow, { Mode: "OFF" });
    assert.equal(props.Name, undefined);
    assert.deepEqual(props.Target.RetryPolicy, {
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 3600,
    });
    return JSON.parse(props.Target.Input) as Record<string, unknown>;
  });
}

const hasPruneOutput = (template: ReturnType<typeof hosting>["template"]) =>
  Object.keys(template.toJSON().Outputs).some((o) => o.startsWith("ArtifactsPruneScheduleName"));

describe("schedules", () => {
  it("sweep daily and keep every version by default", () => {
    const { template, construct } = hosting();
    assert.deepEqual(schedules(template), [{ task: "sweep" }]);
    assert.equal(construct.pruneSchedule, undefined);
    assert.equal(hasPruneOutput(template), false);
  });

  it("prune daily with keepLast and/or olderThan", () => {
    const cases = [
      [{ keepLast: 2 }, { task: "prune", keepLast: 2 }],
      [{ olderThan: Duration.days(30) }, { task: "prune", olderThanMs: 2_592_000_000 }],
      [
        { keepLast: 5, olderThan: Duration.hours(1) },
        { task: "prune", keepLast: 5, olderThanMs: 3_600_000 },
      ],
    ] as const;
    for (const [versions, input] of cases) {
      const { template, construct } = hosting({ dataRetention: { versions } });
      assert.deepEqual(schedules(template), [{ task: "sweep" }, input]);
      assert.ok(construct.pruneSchedule);
      assert.equal(hasPruneOutput(template), true);
    }
  });
});
