// The control Lambda (docs/decisions/0066): the standalone control app (/api, /mcp; 0056) on
// Lambda behind the HTTP API. URLs name the view domain, `file_path` is off, nothing opens a
// browser, and the event's cookies are stripped before Hono sees it.
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { handle } from "hono/aws-lambda";
import type { ArtifactService } from "../../core/artifact-service.ts";
import { createControlApp } from "../../http/control-app.ts";
import { DomainHostPolicy } from "../../http/host-policy.ts";
import type { TokenVerifier } from "../../http/token.ts";
import {
  type HttpApiEvent,
  lambdaRawTarget,
  requestShapeLine,
  stripCookies,
} from "./lambda-event.ts";

export type ControlHandlerDeps = {
  service: ArtifactService;
  verifyToken: TokenVerifier;
  viewDomain: string;
  /** Request body cap, below Lambda's 6 MB event limit (0066). */
  maxBodyBytes: number;
};

export function createControlHandler(deps: ControlHandlerDeps) {
  const { service, verifyToken, viewDomain, maxBodyBytes } = deps;
  const app = createControlApp({
    service,
    config: { port: 443, isolation: "subdomain", allowFilePath: false, maxBodyBytes },
    hosts: new DomainHostPolicy({ viewDomain }),
    verifyToken,
    rawTarget: lambdaRawTarget,
  });
  const inner = handle(app);
  return (event: HttpApiEvent, context: LambdaContext) => {
    const stripped = stripCookies(event);
    const line = requestShapeLine(stripped);
    if (line !== undefined) console.log(line);
    return inner(stripped as unknown as LambdaEvent, context);
  };
}
