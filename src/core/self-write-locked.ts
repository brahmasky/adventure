import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROTECTED_DIRS, PROTECTED_FILES } from "../capabilities/self-write-guard.js";
import { sanitizeJevText } from "../jev/egress-redact.js";
import { fenceRule, fenceUntrusted, newFenceNonce } from "../prompt/untrusted-fence.js";

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

/** Cap, in code points, on one writer-chosen path rendered into a prompt. */
const PROMPT_PATH_CHARS = 200;

/** One path as prompt data: capped, then JSON-escaped (a name can never break out of its line or quote). */
function promptPath(p: string): string {
  const chars = Array.from(p);
  return JSON.stringify(chars.length > PROMPT_PATH_CHARS ? `${chars.slice(0, PROMPT_PATH_CHARS).join("")}…` : p);
}

/**
 * The writer-chosen paths as a fenced data section (final review 2026-10-13, codex #1): the names are the writer's
 * own choice, so they sit inside a nonce fence, one JSON string per line, under a code-authored heading.
 */
function fencedPathLists(lists: Array<{ heading: string; paths: string[] }>): string {
  const nonce = newFenceNonce();
  const out = [fenceRule(nonce)];
  for (const l of lists) {
    if (l.paths.length === 0) continue;
    out.push(`${l.heading} (untrusted data: names your diff chose, one JSON string per line):`, fenceUntrusted(l.paths.map(promptPath).join("\n"), nonce));
  }
  return out.join("\n");
}

/**
 * The refine text for a locked hit. The instruction is trusted and code-authored: Houge has already restored the
 * denied paths to HEAD; fix without them, or declare the need in the sentinel file. The paths are fenced data.
 */
export function buildLockedRetryText(lockedPaths: string[], testPaths: string[]): string {
  const lines = [
    "Your diff touched LOCKED path(s), listed in the data section below. Those can never be changed by you and that part of the diff was refused.",
    "Houge has already reverted your edits to those paths (they are back at HEAD). Do NOT redo them: fix the reported problem " +
      "WITHOUT them (often the fix lives in an unlocked file). Your other edits are still in the worktree.",
    `If that is truly impossible, revert EVERYTHING and write one short paragraph in a file named ${NEEDS_LOCKED_FILE} ` +
      "at the worktree root naming the locked file and the change it needs; do nothing else.",
    renderLockedPaths()
  ];
  if (testPaths.length > 0) {
    lines.push("Your diff also edited EXISTING test file(s), listed below. Existing tests are immutable: Houge has already reverted those too; do NOT redo them, stay backward-compatible.");
  }
  lines.push(fencedPathLists([{ heading: "Locked path(s) your diff touched", paths: lockedPaths }, { heading: "Existing test file(s) your diff edited", paths: testPaths }]));
  return lines.join("\n");
}

/** The refine text for test-only denials: the same trusted instruction as before, with the paths as fenced data. */
export function buildTestRetryText(testPaths: string[]): string {
  return [
    "Your diff edited EXISTING test file(s), listed in the data section below. Existing tests are immutable — that is " +
      "forbidden and would be rejected. Houge has already reverted those test changes (they are back at HEAD); " +
      "do NOT redo them. Instead make your source change BACKWARD-COMPATIBLE so the existing tests pass " +
      "unchanged; add a NEW test file only if needed.",
    fencedPathLists([{ heading: "Existing test file(s) your diff edited", paths: testPaths }])
  ].join("\n");
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
      try {
        // Re-check on the open fd: the path may have been swapped between the lstat and the open.
        const opened = fstatSync(fd);
        if (opened.isFile() && opened.size <= SENTINEL_MAX_BYTES) text = readFileSync(fd, "utf8");
      } finally { closeSync(fd); }
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

/** A guard denial as the plan reads it: the display path and the guard's reason. */
export interface Denial { path: string; reason: string }

/** The guard's test-integrity reason (self-write-guard.ts `evaluateEntry`): the only denial a test edit produces. */
const TEST_INTEGRITY = "test integrity:";

/**
 * Split the denials into locked and test-edit display paths (deduped). The guard checks BOTH real paths of a rename
 * and gives each hit its own reason, so an entry is a test edit only when every reason it got is test integrity; any
 * other reason (a protected old or new path, a symlink, a type change, an unreadable path) makes it locked. Bucketing
 * on the display text put `tests/c.ts -> src/policy/x.ts` in the test bucket (final review 2026-10-13).
 */
export function bucketDenials(denied: Denial[]): { locked: string[]; tests: string[] } {
  const locked = new Set<string>();
  for (const d of denied) if (!d.reason.startsWith(TEST_INTEGRITY)) locked.add(d.path);
  const tests = new Set<string>();
  for (const d of denied) if (!locked.has(d.path)) tests.add(d.path);
  return { locked: [...locked], tests: [...tests] };
}

/**
 * What to do with a guard denial. Test-only denials refine (as before). A locked denial refines ONCE per run
 * (`lockedRetryUsed`) while attempts remain. An unreadable diff (empty path, fail-closed) is always terminal.
 */
export function planDenial(denied: Denial[], attempt: number, maxAttempts: number, lockedRetryUsed: boolean): DenialPlan {
  if (denied.length === 0 || attempt >= maxAttempts || denied.some((d) => d.path === "")) return { kind: "terminal" };
  const { locked, tests } = bucketDenials(denied);
  if (locked.length === 0) return { kind: "refine_tests", tests };
  return lockedRetryUsed ? { kind: "terminal" } : { kind: "refine_locked", locked, tests };
}
