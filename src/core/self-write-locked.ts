import { closeSync, constants, lstatSync, openSync, readFileSync, rmSync } from "node:fs";
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

/** Cap, in bytes, on a sentinel the daemon will read. */
const SENTINEL_MAX_BYTES = 4096;
/** What Paco is told when the sentinel exists but cannot be trusted or read. */
export const SENTINEL_UNREADABLE = "(the writer left a note but it was unreadable or not a plain small file)";

/**
 * Read and delete the sentinel BEFORE the guard runs, so it never appears in a diff and is never published.
 * ENOENT (no file) returns undefined. Anything else that exists is removed (rm -f semantics) and the caller goes
 * terminal: only a regular file of at most 4 KiB is ever read (lstat, never following a symlink; a FIFO or a
 * huge file is never opened), and any failure returns SENTINEL_UNREADABLE after a logged warning (fail closed).
 */
export function takeNeedsLockedFile(worktree: string): string | undefined {
  const file = join(worktree, NEEDS_LOCKED_FILE);
  let text = SENTINEL_UNREADABLE;
  try {
    const st = lstatSync(file);
    if (st.isFile() && st.size <= SENTINEL_MAX_BYTES) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { text = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn(`self-write: could not read ${NEEDS_LOCKED_FILE}: ${String(error)}`);
  }
  try {
    rmSync(file, { recursive: true, force: true });
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

export const isTestPath = (p: string): boolean => p.replace(/^\.\//, "").toLowerCase().startsWith("tests/");

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
