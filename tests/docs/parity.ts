/** Pure docs-parity checks. Each takes the text it needs and returns violations ([] = in parity). */

/** Parser aliases that are deliberately not in the README (each with its reason). */
export const COMMAND_ALIASES_NOT_DOCUMENTED = new Map<string, string>([
  ["/forget-memory", "typed alias of /forget_memory (a Telegram command allows no hyphen); the underscore form is documented"],
  ["/idea", "silent alias of /radar week and /radar pick, kept for old habits (parser comment); /radar is documented"]
]);

/** HOUGE_* names in src that are not configuration (each with its reason). */
export const ENV_NOT_CONFIGURATION: Record<string, string> = {
  HOUGE_STATUS_MAX_CHARS: "a TypeScript constant, not an environment variable",
  HOUGE_GMAIL_ADDRESS: "a code constant holding Houge's own Gmail address, not an env var",
  HOUGE_SHELL_CLEANROOM: "set by the shell wrapper for its own child, never by Paco",
  HOUGE_SHELL_SANDBOX: "set by the shell wrapper for its own child, never by Paco",
  HOUGE_NEEDS_LOCKED: "the sentinel FILE name HOUGE_NEEDS_LOCKED.md the self-write writer leaves, not a variable",
  HOUGE_OMP: "a prefix named in a comment (HOUGE_OMP_*), not a variable",
  HOUGE_OMP_TICKS: "retired chain variable, named in omp-config's retired list; configuration.md documents it as `_TICKS`",
  HOUGE_OMP_JUDGES: "retired chain variable (see HOUGE_OMP_TICKS); documented as `_JUDGES`",
  HOUGE_OMP_CHAIR: "retired chain variable (see HOUGE_OMP_TICKS); documented as `_CHAIR`",
  HOUGE_OMP_READER: "retired chain variable (see HOUGE_OMP_TICKS)",
  HOUGE_OMP_REVIEWER: "retired chain variable (see HOUGE_OMP_TICKS); documented as `_REVIEWER`",
  HOUGE_DECISION_DIGEST_AT: "retired (spec 2026-11-07 §10: the digest is gone); named once at boot by warnRetiredDigestAt, never read"
};

export const ADR_TEMPLATE = "0000-template.md";

/**
 * Commands the parser accepts: every `command === "/name"` comparison in the parser source. The parser dispatches only
 * through this exact form (an `if (command === "/x" || command === "/y")` yields both), so the regex is complete for it.
 */
export function parserCommands(parserSrc: string): string[] {
  const names = new Set<string>();
  for (const m of parserSrc.matchAll(/\bcommand === "(\/[a-z][a-z0-9_-]*)"/g)) names.add(m[1] as string);
  return [...names].sort();
}

/** A command is documented when the README has it in backticks, opening as `` `/name `` and ending at a non-name char. */
export function commandProblems(cmds: readonly string[], readme: string, aliases: ReadonlyMap<string, string>): string[] {
  return cmds
    .filter((c) => !aliases.has(c) && !new RegExp(`\`${c}(?![A-Za-z0-9_-])`).test(readme))
    .map((c) => `README.md does not mention parser command ${c}`);
}

export function toolNameProblems(toolJsonTexts: readonly string[], readme: string): string[] {
  const names = toolJsonTexts.map((t) => (JSON.parse(t) as { name: string }).name);
  return names.filter((n) => !readme.includes(`\`${n}\``)).map((n) => `README.md does not mention tool \`${n}\``);
}

/** Every distinct HOUGE_NAME token in the given source texts (trailing underscores dropped: a prefix is not a name). */
export function envNamesRead(srcTexts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of srcTexts) for (const m of t.matchAll(/HOUGE_[A-Z0-9_]+/g)) out.add(m[0].replace(/_+$/, ""));
  return out;
}

/** Forward direction only: the reverse (documented but unread) needs judgment about retired tables and non-src readers. */
export function envDocProblems(srcTexts: readonly string[], configDoc: string, notConfig: Record<string, string>): string[] {
  return [...envNamesRead(srcTexts)].sort()
    .filter((n) => !(n in notConfig) && !configDoc.includes(`\`${n}\``))
    .map((n) => `configuration.md does not document ${n} (read in src)`);
}

/** Backticked ids in the first column of the "Registry entries" table, versus the registry's ids. */
export function decisionMapProblems(registryIds: readonly string[], mapDoc: string): string[] {
  const section = mapDoc.split(/^## /m).find((s) => s.startsWith("Registry entries")) ?? "";
  const listed = [...section.matchAll(/^\| `([a-z_]+\.[a-z_]+)` \|/gm)].map((m) => m[1] as string);
  return [
    ...registryIds.filter((id) => !listed.includes(id)).map((id) => `decision-map.md does not list registry entry ${id}`),
    ...listed.filter((id) => !registryIds.includes(id)).map((id) => `decision-map.md lists ${id}, which is not in the registry`)
  ];
}

export function adrIndexProblems(adrFiles: readonly string[], indexMd: string, template: string): string[] {
  const linked = [...indexMd.matchAll(/\]\((\d{4}-[^)\s]+\.md)\)/g)].map((m) => m[1] as string);
  return [
    ...adrFiles.filter((f) => f !== template && !linked.includes(f)).map((f) => `docs/decisions/README.md has no row linking ${f}`),
    ...[...new Set(linked)].filter((f) => !adrFiles.includes(f)).map((f) => `docs/decisions/README.md links ${f}, which does not exist`)
  ];
}
