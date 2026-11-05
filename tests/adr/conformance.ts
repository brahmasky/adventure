/** Pure ADR-conformance checks. Each takes the text it needs and returns violations ([] = conforms). */

export function dependencyProblems(packageJson: string): string[] {
  const deps = (JSON.parse(packageJson) as { dependencies?: Record<string, string> }).dependencies ?? {};
  const names = Object.keys(deps);
  return names.length === 0 ? [] : [`package.json dependencies is not empty: ${names.join(", ")}`];
}

/** Files whose `claude` literals are model/family names omp is configured with, not binaries (each with its reason). */
export const CLAUDE_MODEL_NAME_FILES: Record<string, string> = {
  "src/omp/model-tiers.ts": "tier table: model ids (claude-opus-5-5) and the family label, resolved by omp",
  "src/omp/model-string.ts": "family classifier: id.startsWith('claude') and the ModelFamily union"
};

/**
 * ADR 0032 D7. Ways to reach Claude outside omp, each by a documented pattern:
 * - the API host `api.anthropic.com`;
 * - an Anthropic SDK import (`@anthropic-ai/*` or `anthropic`) via `from` or `require`;
 * - a subprocess call (spawn, spawnSync, execFile, execFileSync, exec, execSync, fork) whose first argument is a string
 *   literal ending in `/claude` (a path to the binary);
 * - any string literal that is exactly `claude` or `claude-<suffix>`, or a path ending in one (/^(.*\/)?claude(-[\w-]+)?$/), outside comment lines and
 *   outside CLAUDE_MODEL_NAME_FILES. This catches `const bin = "claude"; spawn(bin)`, `?? "claude"` defaults and a
 *   `claude-code` binary. A binary assembled at runtime from parts is not detectable hermetically.
 * Provider/tier names (`"sonnet@anthropic"`) are model ids routed through omp and do not match.
 */
export function claudeAccessProblems(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const checks: Array<[string, RegExp]> = [
    ["Anthropic API host", /api\.anthropic\.com/],
    ["Anthropic SDK import", /(?:from\s+|require\(\s*)["'](?:@anthropic-ai\/[^"']*|anthropic)["']/],
    ["spawns the claude binary", /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(\s*["'`][^"'`\s]*\/claude["'`]/]
  ];
  return files.flatMap((f) => {
    const out = checks.filter(([, re]) => re.test(f.text)).map(([what]) => `${f.path}: ${what}`);
    const code = f.text.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
    const literal = [...code.matchAll(/(["'`])((?:[^"'`\s]*\/)?claude(?:-[\w-]+)?)\1/g)].length > 0;
    if (literal && !(f.path in CLAUDE_MODEL_NAME_FILES)) out.push(`${f.path}: string literal naming a claude binary`);
    return out;
  });
}

/** ADR 0034 1.6 (R13): env names that look like a switch (suffix OFF, DISABLE(D), SHADOW, ENABLED, ON, ARM, MODE, SKIP). Sorted, distinct. */
export function switchEnvNames(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\bHOUGE_[A-Z0-9_]*_(?:OFF|DISABLED?|SHADOW|ENABLED|ON|ARM|MODE|SKIP)\b/g)) out.add(m[0]);
  return [...out].sort();
}

/**
 * The modes the front door's flag accepts: the string literals of the `JevTriageMode` union plus every `raw === "x"`
 * comparison inside `resolveJevTriageMode` (where the env value is read). Sorted, distinct.
 */
export function triageModes(jevFlagsSrc: string): string[] {
  const modes = new Set<string>();
  const union = /export type JevTriageMode =([^;]+);/.exec(jevFlagsSrc)?.[1] ?? "";
  for (const m of union.matchAll(/"([a-z]+)"/g)) modes.add(m[1] as string);
  const fn = /export function resolveJevTriageMode[\s\S]*?\n}\n/.exec(jevFlagsSrc)?.[0] ?? "";
  for (const m of fn.matchAll(/\braw === "([a-z]+)"/g)) modes.add(m[1] as string);
  return [...modes].sort();
}
