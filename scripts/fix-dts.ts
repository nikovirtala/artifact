// Rewrite relative `.ts` specifiers in dist/cdk/**/*.d.ts to `.js` (docs/decisions/0073):
// TypeScript's rewriteRelativeImportExtensions rewrites the JS output only, so the declarations
// still say `from "./x.ts"`, which consumers cannot resolve. Fails, naming the file, if any
// `.ts` specifier is left (the pack test's rule).
//   node scripts/fix-dts.ts [dir]      default dist/cdk
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TS_SPECIFIER } from "./lib/ts-specifier.ts";

const RELATIVE_TS = /((?:from\s*|import\s*\(\s*)["'])(\.\.?\/[^"']+)\.ts(["'])/g;

export async function fixDeclarations(dir: string): Promise<{ files: number; rewritten: number }> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".d.ts"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
  let rewritten = 0;
  const left: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const fixed = text.replace(RELATIVE_TS, (_, head: string, path: string, tail: string) => {
      rewritten++;
      return `${head}${path}.js${tail}`;
    });
    if (fixed !== text) await writeFile(file, fixed);
    if (TS_SPECIFIER.test(fixed)) left.push(relative(dir, file));
  }
  if (left.length > 0) {
    throw new Error(`fix-dts: .ts specifiers left in ${left.join(", ")}`);
  }
  return { files: files.length, rewritten };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? fileURLToPath(new URL("../dist/cdk", import.meta.url));
  try {
    const { files, rewritten } = await fixDeclarations(dir);
    console.log(`fix-dts: ${rewritten} specifiers rewritten in ${files} declaration files`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
