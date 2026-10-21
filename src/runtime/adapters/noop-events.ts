// No live reload on AWS before M11 (AppSync Events): the viewing Lambda subscribes nobody.
import type { ArtifactEvents } from "../../http/sse.ts";

export const noopEvents: ArtifactEvents = { subscribe: () => () => {} };
