// Lowercase ULID ids: 10 chars of millisecond time + 16 random chars, Crockford base32.
// Lowercase so an id is a valid DNS label for `<id>.localhost`.
import type { IdGen } from "../core/ports.ts";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const MAX_TIME = 2 ** 48 - 1;

export function ulid(
  time: number = Date.now(),
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  if (!Number.isSafeInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`ulid time out of range: ${time}`);
  }
  let timePart = "";
  for (let t = time, i = 0; i < 10; i++, t = Math.floor(t / 32))
    timePart = ALPHABET[t % 32] + timePart;
  let randomPart = "";
  // 256 is a multiple of 32, so masking each byte keeps every symbol equally likely.
  for (const byte of random(new Uint8Array(16))) randomPart += ALPHABET[byte & 31];
  return timePart + randomPart;
}

export function createUlidIdGen(options: { now?: () => number } = {}): IdGen {
  const now = options.now ?? Date.now;
  return { next: () => ulid(now()) };
}
