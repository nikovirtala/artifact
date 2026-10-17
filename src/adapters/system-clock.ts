import type { Clock } from "../core/ports.ts";

export const systemClock: Clock = { now: () => new Date() };
