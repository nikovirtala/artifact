// Synth-time validation of the construct's props (docs/decisions/0071): every failure throws with
// the prop path and is fatal for synth. Only the construct sees the props; the Lambdas re-parse
// their environment but never re-validate domains. The AWS limits live here and only here
// (docs/decisions/0066).
import { Duration, RemovalPolicy, Token } from "aws-cdk-lib";
import type { IHostedZone } from "aws-cdk-lib/aws-route53";

const MIB = 1024 * 1024;

/** Owner decision option B (0066): fits Lambda's 6 MB event even if JSON is base64-encoded. */
export const AWS_LIMIT_DEFAULTS = {
  maxFileBytes: 3 * MIB,
  maxPublishBytes: 3 * MIB,
  maxBodyBytes: 4_500_000,
  maxFiles: 500,
} as const;

/** What fits Lambda's 6 MB event when API Gateway passes JSON as text (0066). */
export const AWS_LIMIT_CEILINGS = {
  maxFileBytes: 4 * MIB,
  maxPublishBytes: 4 * MIB,
  maxBodyBytes: 6_000_000,
  maxFiles: 500,
} as const;

/** Room for the JSON envelope around a binary publish at the limit. */
const ENVELOPE_BYTES = 65_536;

export type ResolvedLimits = { -readonly [K in keyof typeof AWS_LIMIT_DEFAULTS]: number };

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const ARTIFACT_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const MAX_OWNERS = 50;

/** A bare domain name, lowercased; tokens are accepted unchecked. */
export function domainName(path: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${path} must be a domain name string`);
  if (Token.isUnresolved(value)) return value;
  const name = value.toLowerCase();
  if (name.length > 253 || !DOMAIN.test(name)) {
    throw new Error(`${path} must be a bare domain name, got ${JSON.stringify(value)}`);
  }
  return name;
}

/**
 * The API host must differ from the view domain, and a name exactly one label below it must not
 * look like an artifact id: the M10 `*.<view>` alias and edge function would take it for one.
 */
export function checkApiHost(api: string, view: string): void {
  if (Token.isUnresolved(api) || Token.isUnresolved(view)) return;
  if (api === view) throw new Error("apiDomain.name must differ from viewDomain.name");
  const suffix = `.${view}`;
  if (api.endsWith(suffix)) {
    const label = api.slice(0, -suffix.length);
    if (!label.includes(".") && ARTIFACT_ID.test(label)) {
      throw new Error(
        "apiDomain.name must not be a 26-character artifact id label directly below viewDomain.name",
      );
    }
  }
}

/** The zone's name; a zone that cannot tell it (`HostedZone.fromHostedZoneId`) is an error. */
export function zoneNameOf(path: string, zone: IHostedZone): string {
  let name: string;
  try {
    name = zone.zoneName;
  } catch {
    throw new Error(
      `${path} must carry its zoneName (use HostedZone.fromHostedZoneAttributes, fromLookup or a created zone)`,
    );
  }
  return Token.isUnresolved(name) ? name : name.toLowerCase().replace(/\.$/, "");
}

/** `name` must be the zone's apex or inside it (skipped for tokens). */
export function checkInZone(path: string, name: string, zoneName: string): void {
  if (Token.isUnresolved(name) || Token.isUnresolved(zoneName)) return;
  if (name !== zoneName && !name.endsWith(`.${zoneName}`)) {
    throw new Error(`${path} must be inside its hosted zone ${zoneName}`);
  }
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

/** 1–50 owner emails, trimmed and lowercased, no duplicates; errors never echo the list. */
export function normaliseOwners(owners: unknown): string[] {
  if (!Array.isArray(owners)) throw new Error("identity owners: must be an array of emails");
  if (owners.length < 1 || owners.length > MAX_OWNERS) {
    throw new Error(`identity owners: give 1 to ${MAX_OWNERS} emails, got ${owners.length}`);
  }
  const normalised = owners.map((owner, i) => {
    const email = typeof owner === "string" ? owner.trim().toLowerCase() : "";
    if (!isEmail(email)) throw new Error(`identity owners: entry ${i} is not an email address`);
    return email;
  });
  const seen = new Set<string>();
  normalised.forEach((email, i) => {
    if (seen.has(email)) throw new Error(`identity owners: entry ${i} repeats an earlier owner`);
    seen.add(email);
  });
  return normalised;
}

export type LimitsInput = Partial<Record<keyof ResolvedLimits, number>>;

/** Defaults filled in, every limit a positive safe integer under its ceiling, binary headroom. */
export function resolveLimits(limits: LimitsInput = {}): ResolvedLimits {
  const resolved = { ...AWS_LIMIT_DEFAULTS } as ResolvedLimits;
  for (const key of Object.keys(AWS_LIMIT_DEFAULTS) as (keyof ResolvedLimits)[]) {
    const value = limits[key] ?? AWS_LIMIT_DEFAULTS[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`limits.${key} must be a positive integer, got ${value}`);
    }
    if (value > AWS_LIMIT_CEILINGS[key]) {
      throw new RangeError(
        `limits.${key} must be at most ${AWS_LIMIT_CEILINGS[key]} (Lambda's 6 MB event), got ${value}`,
      );
    }
    resolved[key] = value;
  }
  if (resolved.maxFileBytes > resolved.maxPublishBytes) {
    throw new RangeError("limits.maxFileBytes must not exceed limits.maxPublishBytes");
  }
  const needed = Math.ceil((resolved.maxPublishBytes * 4) / 3) + ENVELOPE_BYTES;
  if (resolved.maxBodyBytes < needed) {
    throw new RangeError(
      `limits.maxBodyBytes must be at least ceil(maxPublishBytes × 4/3) + ${ENVELOPE_BYTES} = ${needed}, so a binary publish at the limit fits (ceiling ${AWS_LIMIT_CEILINGS.maxBodyBytes})`,
    );
  }
  return resolved;
}

export type DataRetentionInput = {
  onDestroy?: RemovalPolicy;
  versions?: { keepLast?: number; olderThan?: Duration };
};

export type ResolvedRetention = {
  onDestroy: RemovalPolicy.RETAIN | RemovalPolicy.DESTROY;
  versions?: { keepLast?: number; olderThanMs?: number };
};

export function resolveRetention(retention: DataRetentionInput = {}): ResolvedRetention {
  const onDestroy = retention.onDestroy ?? RemovalPolicy.RETAIN;
  if (onDestroy !== RemovalPolicy.RETAIN && onDestroy !== RemovalPolicy.DESTROY) {
    throw new Error(
      "dataRetention.onDestroy must be RemovalPolicy.RETAIN or RemovalPolicy.DESTROY",
    );
  }
  if (retention.versions === undefined) return { onDestroy };
  const { keepLast, olderThan } = retention.versions;
  if (keepLast === undefined && olderThan === undefined) {
    throw new Error("dataRetention.versions must set keepLast, olderThan or both");
  }
  if (keepLast !== undefined && (!Number.isSafeInteger(keepLast) || keepLast < 1)) {
    throw new Error("dataRetention.versions.keepLast must be a positive integer");
  }
  let olderThanMs: number | undefined;
  if (olderThan !== undefined) {
    if (!(olderThan instanceof Duration) || olderThan.isUnresolved()) {
      throw new Error("dataRetention.versions.olderThan must be a resolved Duration");
    }
    olderThanMs = olderThan.toMilliseconds();
  }
  return {
    onDestroy,
    versions: {
      ...(keepLast === undefined ? {} : { keepLast }),
      ...(olderThanMs === undefined ? {} : { olderThanMs }),
    },
  };
}

export type ThrottleInput = { rateLimit?: number; burstLimit?: number };

export function resolveThrottle(throttle: ThrottleInput = {}): Required<ThrottleInput> {
  const resolved = { rateLimit: throttle.rateLimit ?? 20, burstLimit: throttle.burstLimit ?? 40 };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`throttle.${key} must be a positive integer, got ${value}`);
    }
  }
  return resolved;
}

export function checkAlarmEmail(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  if (typeof email !== "string" || !isEmail(email.trim())) {
    throw new Error("alarmEmail must be an email address");
  }
  return email.trim();
}
