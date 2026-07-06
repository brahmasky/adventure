/**
 * Self-write guard (ADR 0011, Phase 3 — code self-write) — CHECKER 1 of the check stack.
 *
 * This is the deterministic, ungameable HARD-DENY that makes Houge's self-write channel
 * **structurally incapable** of modifying its own safety machinery (gates / identity /
 * supply-chain / existing tests). It is NOT overridable by `/approve` (spec § Security
 * review): the protected constants are "changeable only by Paco's hand" — Paco edits those
 * files directly, never through Houge's self-write.
 *
 * The module is itself in the protected gate-machinery class (self-protection): Houge cannot
 * edit the list of what he is forbidden to edit. The protected list therefore lives HERE,
 * encoded as data.
 *
 * ── How the caller feeds this guard ───────────────────────────────────────────────────
 * The caller runs, inside the verified worktree (NOT the live tree):
 *
 *     git diff --raw -M -C HEAD
 *
 * and passes the raw stdout to `parseDiffRaw`, then the parsed entries to
 * `checkSelfWriteDiff`. `--raw` is REQUIRED over `--name-status` because the raw format
 * carries the file MODE (old + new), which is the only way to detect symlinks (mode
 * `120000`) and mode flips — bypasses `--name-status` is blind to. `-M -C` surface
 * renames/copies so both old and new paths can be checked.
 *
 * ── FAIL-CLOSED everywhere ───────────────────────────────────────────────────────────
 * When in doubt, DENY. Unparseable lines become DENY entries (never silently dropped, never
 * thrown). Paths that escape the repo root are DENY. New symlinks are DENY. Type-changes are
 * DENY. Matching is case-insensitive (defense-in-depth on macOS's case-insensitive FS).
 */

/** A single parsed entry of `git diff --raw -M -C HEAD`. */
export interface DiffEntry {
  /** Status letter: A/M/D/T/R/C (R/C may carry a similarity score in the raw line). */
  status: string;
  /** New/primary path (POSIX, NOT yet normalized — the guard normalizes). For D this is the deleted path. */
  path: string;
  /** Source path for renames (R) and copies (C). Undefined otherwise. */
  oldPath?: string;
  /** Old git file mode, e.g. `100644`, `120000` (symlink), `000000` (absent). */
  oldMode?: string;
  /** New git file mode, e.g. `100644`, `100755`, `120000` (symlink), `000000` (deleted). */
  newMode?: string;
  /**
   * Set when this entry could not be parsed from a raw line. Such an entry is ALWAYS denied
   * (fail-closed) — we refuse to reason about input we don't understand.
   */
  malformed?: boolean;
  /** The original raw line, for diagnostics on malformed/denied entries. */
  raw?: string;
}

export type GuardResult =
  | { allowed: true }
  | { allowed: false; denied: Array<{ path: string; status: string; reason: string }> };

const SYMLINK_MODE = "120000";

/**
 * The protected surface (spec § Security review table). Encoded as DATA, in this file, which
 * is itself protected (self-protection). Two kinds of entry:
 *   - dir-prefix: a directory whose entire subtree is locked. Matched on path-SEGMENT
 *     boundaries (so `src/policy/` matches `src/policy/x.ts` but NOT `src/policymore.ts`).
 *   - file: a single locked file (exact normalized match).
 *
 * Paths are stored POSIX-normalized and lower-cased; matching is case-insensitive.
 */
const PROTECTED_DIRS: readonly string[] = [
  "src/policy", // gate machinery (also covers src/policy/capability-policy.ts)
  "docs/decisions", // the ADRs — identity / rules
  ".github" // CI / supply-chain
];

const PROTECTED_FILES: readonly string[] = [
  // ── Gate machinery ──
  "src/contracts/task-contract.ts",
  "src/capabilities/capability-runner.ts",
  "src/capabilities/capability-policy.ts", // listed in spec; defended even though the live file lives under src/policy/
  "src/run/run-store.ts",
  "src/run/run-ledger.ts", // audit-event schema (incl. self_write_* events) — protect the audit trail
  "src/run/worktree.ts",
  "src/capabilities/coding-agent.ts",
  "src/capabilities/local-project-write-adapter.ts", // a gated write-capability adapter — defense-in-depth
  "src/capabilities/self-write-guard.ts", // SELF-PROTECTION — the guard cannot edit itself
  "src/core/quarantine.ts", // dual-LLM wall, pure half (ADR 0014): reader schema/parse/digest — Paco's hand only. The wall's WIRING (core-worker/inner-loop call sites, READER_DISCIPLINE) stays self-writable, backstopped by the check stack + human merge.
  "src/config/secret-broker.ts", // secrets firewall (ADR 0015) — a self-write can't re-route secrets or disable the strip
  "src/cli.ts", // secrets firewall boot wiring (ADR 0015 §7) — protect the strip call + broker construction
  "src/llm/registry.ts", // secrets firewall (ADR 0015 §7) — single-source-of-truth key resolution; no re-introducing a process.env fallback
  "src/web/registry.ts", // secrets firewall (ADR 0015 §7) — single-source-of-truth key resolution
  "src/run/test-gate.ts", // new Phase-3 module (checker 2)
  "src/capabilities/diff-reviewer.ts", // new Phase-3 module (checker 3)
  "src/run/branch-publish.ts", // new Phase-3 module (step 7 — branch publish)
  // ── Identity / rules ──
  "memory/core/houge.md",
  "agents.md", // stored lower-case; matching is case-insensitive
  // ── Supply chain / build ──
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".gitignore"
];

/** The test-integrity dir: existing files immutable, net-new (status A) allowed. */
const TESTS_DIR = "tests";

/**
 * Parse the output of `git diff --raw -M -C HEAD` into DiffEntry[]. Never throws — a line we
 * cannot understand becomes a `malformed` entry (denied downstream). Blank lines are skipped.
 *
 * Raw line shape: `:<oldMode> <newMode> <oldSha> <newSha> <STATUS>\t<path>[\t<path2>]`
 * The leading metadata is space-separated up to the status; paths are tab-separated. R/C carry
 * a similarity score appended to the status (e.g. `R100`) and a second (destination) path.
 */
export function parseDiffRaw(raw: string): DiffEntry[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const entries: DiffEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    entries.push(parseRawLine(line));
  }
  return entries;
}

function parseRawLine(line: string): DiffEntry {
  // A well-formed raw line starts with ':'. Anything else is garbage → fail closed.
  if (!line.startsWith(":")) {
    return { status: "?", path: "", malformed: true, raw: line };
  }
  // Split the metadata head from the tab-separated path tail.
  const tabIdx = line.indexOf("\t");
  if (tabIdx < 0) {
    return { status: "?", path: "", malformed: true, raw: line };
  }
  const head = line.slice(1, tabIdx); // drop leading ':'
  const tail = line.slice(tabIdx + 1);
  const meta = head.split(" ");
  // meta = [oldMode, newMode, oldSha, newSha, STATUS]
  if (meta.length < 5) {
    return { status: "?", path: "", malformed: true, raw: line };
  }
  const oldMode = meta[0]!;
  const newMode = meta[1]!;
  const rawStatus = meta[4];
  if (!rawStatus || rawStatus.length === 0) {
    return { status: "?", path: "", malformed: true, raw: line };
  }
  const status = rawStatus[0]!.toUpperCase(); // strip the R100/C75 similarity score
  const paths = tail.split("\t").filter((p) => p.length > 0);

  if (status === "R" || status === "C") {
    // Renames/copies carry both source and destination paths.
    if (paths.length < 2) {
      return { status, path: paths[0] ?? "", malformed: true, raw: line };
    }
    return { status, oldPath: paths[0]!, path: paths[1]!, oldMode, newMode, raw: line };
  }

  if (paths.length < 1) {
    return { status, path: "", malformed: true, raw: line };
  }
  return { status, path: paths[0]!, oldMode, newMode, raw: line };
}

/**
 * Normalize a path for matching: POSIX separators, strip leading `./`, resolve `.`/`..`
 * segments. Returns `null` if the path escapes the repo root (a leading `..` that pops above
 * root) or is empty — callers treat `null` as DENY (fail closed). Lower-cased for the
 * case-insensitive compare (defense-in-depth on case-insensitive filesystems).
 */
export function normalizePath(input: string): string | null {
  if (typeof input !== "string" || input.trim().length === 0) return null;
  // Reject absolute paths outright — a self-write diff is always repo-relative.
  if (input.startsWith("/")) return null;
  const unified = input.replace(/\\/g, "/"); // Windows-separator paranoia
  const out: string[] = [];
  for (const segRaw of unified.split("/")) {
    const seg = segRaw.trim();
    if (seg === "" || seg === ".") continue; // collapse empty + current-dir segments
    if (seg === "..") {
      if (out.length === 0) return null; // escapes repo root → DENY
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join("/").toLowerCase();
}

/** Segment-aware containment: is `path` exactly `dir` or strictly inside `dir/`? */
function isUnderDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + "/");
}

/** Is a normalized path part of the protected surface (dirs or single files)? */
function matchProtected(normalized: string): boolean {
  for (const dir of PROTECTED_DIRS) {
    if (isUnderDir(normalized, dir)) return true;
  }
  for (const file of PROTECTED_FILES) {
    if (normalized === file) return true;
  }
  return false;
}

/**
 * Evaluate a parsed diff against the protected surface. Pure. FAIL-CLOSED: any malformed
 * entry, any escaping/unparseable path, any new symlink, any type-change, and every protected
 * hit are DENIED, and ALL offenders are listed. If nothing is denied, `{ allowed: true }`.
 */
export function checkSelfWriteDiff(entries: DiffEntry[]): GuardResult {
  const denied: Array<{ path: string; status: string; reason: string }> = [];
  if (!Array.isArray(entries)) {
    // Unparseable input shape → fail closed with a single synthetic denial.
    return { allowed: false, denied: [{ path: "", status: "?", reason: "diff input was not a list of entries" }] };
  }

  for (const entry of entries) {
    const offenses = evaluateEntry(entry);
    for (const o of offenses) denied.push(o);
  }

  return denied.length === 0 ? { allowed: true } : { allowed: false, denied };
}

/** All reasons a single entry is denied (may be several). Empty array = this entry is clean. */
function evaluateEntry(entry: DiffEntry): Array<{ path: string; status: string; reason: string }> {
  const out: Array<{ path: string; status: string; reason: string }> = [];
  if (!entry || typeof entry !== "object") {
    return [{ path: "", status: "?", reason: "unparseable diff entry (fail-closed)" }];
  }
  if (entry.malformed) {
    return [{ path: entry.path ?? "", status: entry.status ?? "?", reason: "malformed diff line (fail-closed)" }];
  }

  const status = entry.status;
  const display = entry.oldPath ? `${entry.oldPath} -> ${entry.path}` : entry.path;

  // ── Type changes (T): a file becoming a symlink/regular/etc. Always deny — a T touching
  // an allowed path can re-point it (e.g. into a protected area) in ways the path alone hides.
  if (status === "T") {
    return [{ path: display, status, reason: "type-change (T) is denied: re-typing a file (e.g. to a symlink) is a gate-erosion vector" }];
  }

  // ── New / modified symlinks: a symlink can point into the protected surface; its target is
  // not in the diff, so we cannot prove it is safe → deny conservatively (fail-closed).
  if (entry.newMode === SYMLINK_MODE && status !== "D") {
    return [{ path: display, status, reason: "symlink (mode 120000) added/changed: target is unverifiable from the diff, denied conservatively" }];
  }

  // ── Normalize every path the entry touches; an un-normalizable path (escapes root, empty)
  // is denied — we will not let a path we can't resolve through.
  const newNorm = normalizePath(entry.path);
  if (newNorm === null) {
    out.push({ path: display, status, reason: "path could not be normalized or escapes repo root (fail-closed)" });
  }
  let oldNorm: string | null = null;
  if (entry.oldPath !== undefined) {
    oldNorm = normalizePath(entry.oldPath);
    if (oldNorm === null) {
      out.push({ path: display, status, reason: "rename/copy source could not be normalized or escapes repo root (fail-closed)" });
    }
  }
  // If any path failed to normalize, stop — we already denied; don't reason further.
  if (out.length > 0) return out;

  // From here both newNorm (and oldNorm when present) are valid strings.
  const checkedNew = newNorm as string;
  const checkedOld = oldNorm; // string | null; null only when there is no oldPath

  // ── Protected-surface match on BOTH sides of a rename/copy. A rename FROM a protected path
  // (exfiltrating/deleting gate code) OR INTO one is denied.
  if (matchProtected(checkedNew)) {
    out.push({ path: display, status, reason: `protected path: ${checkedNew}` });
  }
  if (checkedOld !== null && matchProtected(checkedOld)) {
    out.push({ path: display, status, reason: `protected source path (rename/copy from locked surface): ${checkedOld}` });
  }

  // ── Test integrity: under tests/, only net-new (A) is allowed; M/D/R/C/T weaken the gate
  // that judges him. A rename whose source OR destination is under tests/ is a tests/ change.
  const newInTests = isUnderDir(checkedNew, TESTS_DIR);
  const oldInTests = checkedOld !== null && isUnderDir(checkedOld, TESTS_DIR);
  if (newInTests || oldInTests) {
    if (status !== "A") {
      out.push({
        path: display,
        status,
        reason: `test integrity: only net-new test files (status A) are allowed under ${TESTS_DIR}/; status ${status} on an existing test is denied`
      });
    }
  }

  return out;
}
