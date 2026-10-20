// A specifier that names a .ts module: anything shipped that still has one is a leftover. Shared
// by the pack test, the bundle test and scripts/fix-dts.ts, so all check with the same rule.
export const TS_SPECIFIER = /(?:from\s*|import\s*\(\s*)["'][^"']+\.ts["']/;
