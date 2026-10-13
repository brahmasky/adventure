import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROTECTED_DIRS, PROTECTED_FILES } from "../capabilities/self-write-guard.js";
import { sanitizeJevText } from "../jev/egress-redact.js";

/** The file the writer leaves at the worktree root to say a locked change is unavoidable. */
export const NEEDS_LOCKED_FILE = "HOUGE_NEEDS_LOCKED.md";

/** Cap, in characters, on the writer's reason quoted to Paco. */
const REASON_CHARS = 500;

/** The locked surface rendered from the guard's own lists (no second list to drift). Directories end in `/`. */
export function renderLockedPaths(): string {
  return [
    "LOCKED — a diff that touches any of these is refused and never lands. Do not edit, create or delete them:",
    ...PROTECTED_DIRS.map((d) => `- ${d}/ (the whole directory)`),
    ...PROTECTED_FILES.map((f) => `- ${f}`)
  ].join("\n");
}

/** The refine text for a locked hit: revert, fix without them, or declare the need in the sentinel file. */
export function buildLockedRetryText(lockedPaths: string[], testPaths: string[]): string {
  const lines = [
    `Your diff touched LOCKED path(s): ${lockedPaths.join(", ")}. Those can never be changed by you and the diff was discarded.`,
    "REVERT those edits and fix the reported problem WITHOUT them (often the fix lives in an unlocked file).",
    `If that is truly impossible, revert EVERYTHING and write one short paragraph in a file named ${NEEDS_LOCKED_FILE} ` +
      "at the worktree root naming the locked file and the change it needs; do nothing else.",
    renderLockedPaths()
  ];
  if (testPaths.length > 0) {
    lines.push(`Your diff also edited EXISTING test file(s): ${testPaths.join(", ")}. Existing tests are immutable: revert those too and stay backward-compatible.`);
  }
  return lines.join("\n");
}

/**
 * Read and delete the sentinel BEFORE the guard runs, so it never appears in a diff and is never published.
 * A missing file is the normal case. Any other failure is logged and treated as "no sentinel" (a left-over
 * file would be an unlocked root file; the guard and reviewer still judge the diff).
 */
export function takeNeedsLockedFile(worktree: string): string | undefined {
  const file = join(worktree, NEEDS_LOCKED_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`self-write: could not read ${NEEDS_LOCKED_FILE}: ${String(error)}`);
    return undefined;
  }
  try {
    rmSync(file, { force: true });
  } catch (error) {
    console.warn(`self-write: could not delete ${NEEDS_LOCKED_FILE}: ${String(error)}`);
  }
  return text;
}

/** The writer's reason as Paco will see it: secrets masked first (broker values, then shapes), THEN truncated. */
export function quoteNeedsLockedReason(raw: string, brokerRedact?: (s: string) => string): string {
  const masked = sanitizeJevText(raw.trim(), brokerRedact);
  const chars = Array.from(masked);
  return chars.length > REASON_CHARS ? `${chars.slice(0, REASON_CHARS).join("")}…` : masked;
}

export type DenialPlan =
  | { kind: "refine_tests"; tests: string[] }
  | { kind: "refine_locked"; locked: string[]; tests: string[] }
  | { kind: "terminal" };

const isTestPath = (p: string): boolean => p.replace(/^\.\//, "").toLowerCase().startsWith("tests/");

/**
 * What to do with a guard denial. Test-only denials refine (as before). A locked denial refines ONCE per run
 * (`lockedRetryUsed`) while attempts remain. An unreadable diff (empty path, fail-closed) is always terminal.
 */
export function planDenial(denied: Array<{ path: string }>, attempt: number, maxAttempts: number, lockedRetryUsed: boolean): DenialPlan {
  if (denied.length === 0 || attempt >= maxAttempts || denied.some((d) => d.path === "")) return { kind: "terminal" };
  const tests = denied.map((d) => d.path).filter(isTestPath);
  const locked = denied.map((d) => d.path).filter((p) => !isTestPath(p));
  if (locked.length === 0) return { kind: "refine_tests", tests };
  return lockedRetryUsed ? { kind: "terminal" } : { kind: "refine_locked", locked, tests };
}
