// The result table every script prints: check | covers | result | detail, and the exit code.
export type Result = "PASS" | "FAIL" | "SKIP";
export type Row = { check: string; covers: string; result: Result; detail: string };

/** Replace every secret (tokens, cookie markers) in `text`. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, "<redacted>");
  }
  return out;
}

export function renderTable(rows: readonly Row[]): string {
  const header: Row = {
    check: "check",
    covers: "covers",
    result: "result" as Result,
    detail: "detail",
  };
  const all = [header, ...rows];
  const width = (key: keyof Row) => Math.max(...all.map((r) => r[key].length));
  const [c, v, r] = [width("check"), width("covers"), width("result")];
  const line = (row: Row) =>
    `${row.check.padEnd(c)} | ${row.covers.padEnd(v)} | ${row.result.padEnd(r)} | ${row.detail}`.trimEnd();
  const counts = (["PASS", "FAIL", "SKIP"] as const).map(
    (k) => `${rows.filter((row) => row.result === k).length} ${k}`,
  );
  return `${[line(header), ...rows.map(line)].join("\n")}\n\n${counts.join(", ")}\n`;
}

/** 1 if any check failed, else 0. */
export function exitCode(rows: readonly Row[]): number {
  return rows.some((row) => row.result === "FAIL") ? 1 : 0;
}

/** Collects rows; each check catches its own errors and reports FAIL with the message. */
export class Checks {
  readonly rows: Row[] = [];
  readonly #secrets: (string | undefined)[] = [];

  /** Values never printed in a detail. */
  secret(value: string | undefined): void {
    this.#secrets.push(value);
  }

  add(check: string, covers: string, result: Result, detail: string): void {
    this.rows.push({ check, covers, result, detail: redact(detail, this.#secrets) });
  }

  /** Run `fn`: a returned string is a PASS detail, a thrown error is a FAIL. */
  async run(check: string, covers: string, fn: () => Promise<string>): Promise<boolean> {
    try {
      this.add(check, covers, "PASS", await fn());
      return true;
    } catch (error) {
      this.add(check, covers, "FAIL", (error as Error).message);
      return false;
    }
  }
}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
