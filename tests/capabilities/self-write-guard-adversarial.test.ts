import { describe, expect, it } from "vitest";
import {
  checkSelfWriteDiff,
  normalizePath,
  parseDiffRaw,
  type DiffEntry,
  type GuardResult
} from "../../src/capabilities/self-write-guard.js";

/**
 * INDEPENDENT ADVERSARIAL suite for CHECKER 1 (self-write-guard) — Phase 3 security invariant.
 *
 * Mandate: prove **no diff can EVER reach a protected path**. Authored by the independent
 * verifier (writer ≠ checker ≠ verifier). Every case below is an ATTACK; the assertion is that
 * the guard DENIES it (or, for the precision cases, ALLOWS a genuinely-safe sibling — proving the
 * matcher is segment-precise, not a sloppy prefix). A single non-denial here is a HIGH-severity
 * bypass. This file MUST NOT weaken the existing self-write-guard.test.ts; it only adds attacks.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────────────────
/** A regular-file diff entry (override status/path/modes as needed). */
function entry(partial: Partial<DiffEntry> & { status: string; path: string }): DiffEntry {
  return { newMode: "100644", oldMode: "100644", ...partial };
}
function check(...entries: DiffEntry[]): GuardResult {
  return checkSelfWriteDiff(entries);
}
function isDenied(result: GuardResult): boolean {
  return result.allowed === false;
}
function deniedPaths(result: GuardResult): string[] {
  return result.allowed ? [] : result.denied.map((d) => d.path);
}
/** Build a real `git diff --raw -M -C HEAD` line (the actual wire format the guard parses). */
function rawLine(opts: {
  oldMode?: string;
  newMode?: string;
  status: string; // may include similarity score, e.g. R100
  path: string;
  path2?: string;
}): string {
  const oldMode = opts.oldMode ?? "100644";
  const newMode = opts.newMode ?? "100644";
  const tail = opts.path2 ? `${opts.path}\t${opts.path2}` : opts.path;
  return `:${oldMode} ${newMode} 1111111 2222222 ${opts.status}\t${tail}`;
}
/** Parse one raw line and run it through the guard end-to-end (the real caller path). */
function guardRaw(line: string): GuardResult {
  return checkSelfWriteDiff(parseDiffRaw(line));
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 1. PATH TRAVERSAL — every documented escape must DENY (it resolves into a protected path or
//    escapes the repo root → fail-closed).
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: path traversal must be denied", () => {
  it("denies src/foo/../policy/x.ts (resolves into src/policy)", () => {
    const r = check(entry({ status: "M", path: "src/foo/../policy/x.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies src/policy/../../package.json (resolves to protected file package.json)", () => {
    const r = check(entry({ status: "M", path: "src/policy/../../package.json" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies ./src/policy/gate.ts (leading ./ collapses into src/policy)", () => {
    const r = check(entry({ status: "M", path: "./src/policy/gate.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies absolute path /etc/passwd (absolute paths are rejected outright)", () => {
    const r = check(entry({ status: "M", path: "/etc/passwd" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies an absolute path that points at a protected file (/repo/src/policy/x.ts)", () => {
    const r = check(entry({ status: "M", path: "/repo/src/policy/x.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies src/a/b/../../policy/c.ts (double pop resolves into src/policy)", () => {
    const r = check(entry({ status: "M", path: "src/a/b/../../policy/c.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a path that escapes the repo root entirely (../outside.ts)", () => {
    const r = check(entry({ status: "M", path: "../outside.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a traversal that pops above root then re-enters (../../adventure/src/policy/x.ts)", () => {
    const r = check(entry({ status: "M", path: "../../adventure/src/policy/x.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies backslash-separated traversal (src\\policy\\x.ts — Windows-separator paranoia)", () => {
    const r = check(entry({ status: "M", path: "src\\policy\\x.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a rename whose normalized DESTINATION traverses into a protected dir", () => {
    const r = check(entry({ status: "R", oldPath: "src/safe.ts", path: "src/x/../policy/evil.ts" }));
    expect(isDenied(r)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 2. SEGMENT-BOUNDARY PRECISION — protected match must be on path SEGMENTS, not raw prefix.
//    False-NEGATIVE (real protected path) → DENY. False-POSITIVE (safe sibling) → ALLOW.
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: matcher precision (segment boundary)", () => {
  it("DENIES the exact protected dir and its subtree (src/policy, src/policy/deep/x.ts)", () => {
    expect(isDenied(check(entry({ status: "M", path: "src/policy/gate.ts" })))).toBe(true);
    expect(isDenied(check(entry({ status: "M", path: "src/policy/deep/nested/x.ts" })))).toBe(true);
  });

  it("ALLOWS src/policymore.ts (NOT under src/policy/ — prefix is not a segment boundary)", () => {
    const r = check(entry({ status: "M", path: "src/policymore.ts" }));
    expect(r.allowed).toBe(true);
  });

  it("ALLOWS src/policy_helper.ts (sibling file, not the protected dir)", () => {
    const r = check(entry({ status: "M", path: "src/policy_helper.ts" }));
    expect(r.allowed).toBe(true);
  });

  it("ALLOWS src/policyx/y.ts (a different dir that merely shares a prefix)", () => {
    const r = check(entry({ status: "M", path: "src/policyx/y.ts" }));
    expect(r.allowed).toBe(true);
  });

  it("ALLOWS package.json.bak and package-lock.json.bak (not the exact protected file)", () => {
    expect(check(entry({ status: "A", path: "package.json.bak" })).allowed).toBe(true);
    expect(check(entry({ status: "A", path: "package-lock.json.bak" })).allowed).toBe(true);
  });

  it("ALLOWS a normal source file (src/core/core-worker.ts is NOT protected)", () => {
    const r = check(entry({ status: "M", path: "src/core/core-worker.ts" }));
    expect(r.allowed).toBe(true);
  });

  it("ALLOWS adding a brand-new ordinary source file", () => {
    const r = check(entry({ status: "A", path: "src/capabilities/new-feature.ts", oldMode: "000000" }));
    expect(r.allowed).toBe(true);
  });

  it("ALLOWS docs/decisionsmore/x.md (sibling of the protected docs/decisions dir)", () => {
    const r = check(entry({ status: "M", path: "docs/decisionsmore/x.md" }));
    expect(r.allowed).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 3. RENAME / COPY — both sides of an R/C are checked; tests/ rename is a tests/ change.
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: rename / copy on the protected surface", () => {
  it("denies a rename FROM a protected path (exfiltrating/deleting gate code)", () => {
    const r = check(entry({ status: "R", oldPath: "src/policy/gate.ts", path: "src/elsewhere.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a rename INTO a protected path", () => {
    const r = check(entry({ status: "R", oldPath: "src/elsewhere.ts", path: "src/policy/gate.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a copy FROM a protected file (C status, source protected)", () => {
    const r = check(entry({ status: "C", oldPath: "src/capabilities/coding-agent.ts", path: "src/copy.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a copy INTO a protected file (C status, destination protected)", () => {
    const r = check(entry({ status: "C", oldPath: "src/safe.ts", path: "package.json" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a rename of an EXISTING tests/ file (R is not net-new — gate-gaming)", () => {
    const r = check(entry({ status: "R", oldPath: "tests/a.test.ts", path: "tests/b.test.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a rename that MOVES a source file OUT of tests/ (source under tests/ is a tests/ change)", () => {
    const r = check(entry({ status: "R", oldPath: "tests/a.test.ts", path: "src/a.test.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a rename that moves a file INTO tests/ over an existing one (dest under tests/, not A)", () => {
    const r = check(entry({ status: "R", oldPath: "src/a.test.ts", path: "tests/a.test.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies the real wire format of a rename FROM a protected dir (raw parse path)", () => {
    const r = guardRaw(rawLine({ status: "R100", path: "src/policy/gate.ts", path2: "src/x.ts" }));
    expect(isDenied(r)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 4. tests/ INTEGRITY — A (add) allowed; M/D/R/C/T on existing tests denied (every status).
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: tests/ integrity — only net-new (A) allowed", () => {
  it("ALLOWS a net-new test file (status A under tests/)", () => {
    const r = check(entry({ status: "A", path: "tests/capabilities/my-new.test.ts", oldMode: "000000" }));
    expect(r.allowed).toBe(true);
  });

  it("denies MODIFYING an existing test (M) — would let him weaken the gate that judges him", () => {
    const r = check(entry({ status: "M", path: "tests/capabilities/self-write-guard.test.ts" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies DELETING an existing test (D) — the classic fake-pass", () => {
    const r = check(entry({ status: "D", path: "tests/capabilities/self-write-guard.test.ts", newMode: "000000" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a TYPE-CHANGE (T) under tests/", () => {
    const r = check(entry({ status: "T", path: "tests/a.test.ts", newMode: "120000" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a deeply-nested existing test modification (segment containment, not just top level)", () => {
    const r = check(entry({ status: "M", path: "tests/run/deep/nested/foo.test.ts" }));
    expect(isDenied(r)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 5. SYMLINKS + TYPE-CHANGES — a symlink target is invisible in the diff → always DENY (it
//    could point INTO the protected surface). Type-changes always DENY.
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: symlinks and type-changes", () => {
  it("denies a NEW symlink even to an ostensibly-safe path (target is unverifiable)", () => {
    const r = check(entry({ status: "A", path: "src/innocent.ts", newMode: "120000", oldMode: "000000" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a new symlink whose NAME is under a non-protected dir but could point into src/policy", () => {
    const r = guardRaw(rawLine({ oldMode: "000000", newMode: "120000", status: "A", path: "src/link-to-policy" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a MODIFIED symlink (M with new mode 120000 — re-pointing)", () => {
    const r = check(entry({ status: "M", path: "src/existing-link", newMode: "120000", oldMode: "120000" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a type-change of a regular file INTO a symlink (T, 100644 -> 120000)", () => {
    const r = check(entry({ status: "T", path: "src/foo.ts", oldMode: "100644", newMode: "120000" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies a type-change even on a path that is otherwise allowed", () => {
    const r = check(entry({ status: "T", path: "src/capabilities/new-feature.ts" }));
    expect(isDenied(r)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 6. CASE / UNICODE TRICKS — matching is case-insensitive (case-insensitive FS defense).
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: case-folding tricks", () => {
  it("denies SRC/POLICY/x.ts (upper-cased protected dir)", () => {
    expect(isDenied(check(entry({ status: "M", path: "SRC/POLICY/x.ts" })))).toBe(true);
  });

  it("denies Package.JSON and PACKAGE-LOCK.JSON (mixed/upper case)", () => {
    expect(isDenied(check(entry({ status: "M", path: "Package.JSON" })))).toBe(true);
    expect(isDenied(check(entry({ status: "M", path: "PACKAGE-LOCK.JSON" })))).toBe(true);
  });

  it("denies AGENTS.md and Agents.MD (identity file, any case)", () => {
    expect(isDenied(check(entry({ status: "M", path: "AGENTS.md" })))).toBe(true);
    expect(isDenied(check(entry({ status: "M", path: "Agents.MD" })))).toBe(true);
  });

  it("denies mixed-case of every protected single file", () => {
    const files = [
      "SRC/CONTRACTS/TASK-CONTRACT.TS",
      "Src/Capabilities/Capability-Runner.Ts",
      "src/capabilities/Capability-Policy.ts",
      "SRC/RUN/RUN-STORE.TS",
      "src/run/Worktree.ts",
      "SRC/CAPABILITIES/CODING-AGENT.TS",
      "src/capabilities/Self-Write-Guard.ts",
      "SRC/RUN/TEST-GATE.TS",
      "src/capabilities/Diff-Reviewer.ts",
      "SRC/RUN/BRANCH-PUBLISH.TS",
      "MEMORY/CORE/HOUGE.MD",
      "TSConfig.JSON",
      ".GITIGNORE"
    ];
    for (const f of files) {
      expect(isDenied(check(entry({ status: "M", path: f })))).toBe(true);
    }
  });

  it("denies case-folded protected DIRS (.GITHUB/, DOCS/DECISIONS/)", () => {
    expect(isDenied(check(entry({ status: "M", path: ".GITHUB/workflows/ci.yml" })))).toBe(true);
    expect(isDenied(check(entry({ status: "M", path: "DOCS/DECISIONS/0011-x.md" })))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 7. SELF-PROTECTION — the guard and its sibling gate modules cannot be edited by self-write.
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: self-protection of the gate machinery", () => {
  it("denies a diff editing self-write-guard.ts itself (the list of forbidden edits is forbidden)", () => {
    expect(isDenied(check(entry({ status: "M", path: "src/capabilities/self-write-guard.ts" })))).toBe(true);
  });

  it("denies editing branch-publish.ts, test-gate.ts, diff-reviewer.ts (Phase-3 gate siblings)", () => {
    expect(isDenied(check(entry({ status: "M", path: "src/run/branch-publish.ts" })))).toBe(true);
    expect(isDenied(check(entry({ status: "M", path: "src/run/test-gate.ts" })))).toBe(true);
    expect(isDenied(check(entry({ status: "M", path: "src/capabilities/diff-reviewer.ts" })))).toBe(true);
  });

  it("denies editing coding-agent.ts (the write-mode adapter / sandbox flags)", () => {
    expect(isDenied(check(entry({ status: "M", path: "src/capabilities/coding-agent.ts" })))).toBe(true);
  });

  it("denies editing capability-runner.ts, capability-policy.ts, run-store.ts, worktree.ts, task-contract.ts", () => {
    for (const f of [
      "src/capabilities/capability-runner.ts",
      "src/capabilities/capability-policy.ts",
      "src/run/run-store.ts",
      "src/run/worktree.ts",
      "src/contracts/task-contract.ts"
    ]) {
      expect(isDenied(check(entry({ status: "M", path: f })))).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 8. SUPPLY-CHAIN / BUILD / IDENTITY — deps, build config, .gitignore, ADRs, CI, identity.
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: supply-chain, build, identity surfaces", () => {
  it("denies un-ignoring secrets via .gitignore edit (could leak .env into a future worktree)", () => {
    expect(isDenied(check(entry({ status: "M", path: ".gitignore" })))).toBe(true);
  });

  it("denies adding a dependency via package.json / package-lock.json (zero-deps invariant)", () => {
    expect(isDenied(check(entry({ status: "M", path: "package.json" })))).toBe(true);
    expect(isDenied(check(entry({ status: "M", path: "package-lock.json" })))).toBe(true);
  });

  it("denies editing tsconfig.json (build config)", () => {
    expect(isDenied(check(entry({ status: "M", path: "tsconfig.json" })))).toBe(true);
  });

  it("denies editing the core identity (memory/core/houge.md)", () => {
    expect(isDenied(check(entry({ status: "M", path: "memory/core/houge.md" })))).toBe(true);
  });

  it("denies editing an ADR (docs/decisions/0011-*.md)", () => {
    expect(isDenied(check(entry({ status: "M", path: "docs/decisions/0011-self-evolution-architecture.md" })))).toBe(true);
  });

  it("denies editing AGENTS.md (identity / rules)", () => {
    expect(isDenied(check(entry({ status: "M", path: "AGENTS.md" })))).toBe(true);
  });

  it("denies editing CI workflows (.github/workflows/*)", () => {
    expect(isDenied(check(entry({ status: "M", path: ".github/workflows/ci.yml" })))).toBe(true);
    expect(isDenied(check(entry({ status: "A", path: ".github/workflows/evil.yml", oldMode: "000000" })))).toBe(true);
  });

  it("denies ADDING a new file anywhere under a protected dir (A is not a tests/ carve-out elsewhere)", () => {
    expect(isDenied(check(entry({ status: "A", path: "src/policy/sneaky.ts", oldMode: "000000" })))).toBe(true);
    expect(isDenied(check(entry({ status: "A", path: "docs/decisions/0099-fake.md", oldMode: "000000" })))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 9. FAIL-CLOSED — malformed / garbage / empty / unclassifiable input must DENY, never allow.
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: fail-closed on bad input", () => {
  it("denies a malformed entry (parser could not classify the line)", () => {
    const r = check({ status: "?", path: "", malformed: true, raw: "garbage" });
    expect(isDenied(r)).toBe(true);
  });

  it("denies garbage raw lines end-to-end (parse → guard)", () => {
    const r = guardRaw("this is not a git raw line at all");
    expect(isDenied(r)).toBe(true);
  });

  it("denies a raw line with too-few metadata fields (truncated head)", () => {
    const r = guardRaw(":100644 100644 abc\tsrc/x.ts");
    expect(isDenied(r)).toBe(true);
  });

  it("denies a rename raw line missing its second path (R with only one path)", () => {
    const r = guardRaw(":100644 100644 a b R100\ttests/only-one.ts");
    expect(isDenied(r)).toBe(true);
  });

  it("ALLOWS empty input (no entries = no changes = nothing to deny)", () => {
    expect(check().allowed).toBe(true);
    expect(checkSelfWriteDiff(parseDiffRaw("")).allowed).toBe(true);
  });

  it("denies a non-array input shape (fail-closed at the top of checkSelfWriteDiff)", () => {
    // @ts-expect-error — defending against a non-array passed by a buggy caller
    const r = checkSelfWriteDiff(null);
    expect(isDenied(r)).toBe(true);
  });

  it("denies a null/garbage entry inside the array (per-entry fail-closed)", () => {
    // @ts-expect-error — a null entry must not crash and must deny
    expect(isDenied(check(null))).toBe(true);
    // @ts-expect-error — a non-object entry must deny
    expect(isDenied(check(42))).toBe(true);
  });

  it("denies an entry with an empty path (un-normalizable → fail-closed)", () => {
    const r = check(entry({ status: "M", path: "" }));
    expect(isDenied(r)).toBe(true);
  });

  it("denies an entry whose path is only dots/slashes (normalizes to nothing)", () => {
    expect(isDenied(check(entry({ status: "M", path: "./././" })))).toBe(true);
    expect(isDenied(check(entry({ status: "M", path: "/" })))).toBe(true);
  });

  it("denies a lowercase status on a tests/ path (status is compared case-sensitively to A)", () => {
    // A hand-built entry with status 'a' (not the canonical uppercase 'A') must NOT be treated
    // as a net-new add — fail-closed: anything that is not exactly 'A' under tests/ is denied.
    const r = check(entry({ status: "a", path: "tests/x.test.ts" }));
    expect(isDenied(r)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 10. MULTI-ENTRY — one allowed + one protected ⇒ the WHOLE result is denied, offender listed.
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: multi-entry diffs", () => {
  it("denies the whole diff if ANY entry is protected (allowed src + protected policy)", () => {
    const r = check(
      entry({ status: "M", path: "src/core/core-worker.ts" }),
      entry({ status: "M", path: "src/policy/gate.ts" })
    );
    expect(isDenied(r)).toBe(true);
    expect(deniedPaths(r)).toContain("src/policy/gate.ts");
  });

  it("does NOT list the innocent file among the offenders", () => {
    const r = check(
      entry({ status: "M", path: "src/core/core-worker.ts" }),
      entry({ status: "D", path: "tests/a.test.ts", newMode: "000000" })
    );
    expect(isDenied(r)).toBe(true);
    expect(deniedPaths(r)).not.toContain("src/core/core-worker.ts");
  });

  it("lists EVERY offender across a mixed diff (deny is exhaustive, not first-match)", () => {
    const r = check(
      entry({ status: "M", path: "src/policy/a.ts" }),
      entry({ status: "M", path: "package.json" }),
      entry({ status: "A", path: "src/ok.ts", oldMode: "000000" }),
      entry({ status: "D", path: "tests/keep.test.ts", newMode: "000000" })
    );
    expect(isDenied(r)).toBe(true);
    const paths = deniedPaths(r);
    expect(paths).toContain("src/policy/a.ts");
    expect(paths).toContain("package.json");
    expect(paths).toContain("tests/keep.test.ts");
    expect(paths).not.toContain("src/ok.ts");
  });

  it("ALLOWS a fully-clean multi-entry diff (src change + net-new test)", () => {
    const r = check(
      entry({ status: "M", path: "src/core/core-worker.ts" }),
      entry({ status: "A", path: "tests/core/core-worker-new.test.ts", oldMode: "000000" })
    );
    expect(r.allowed).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 11. normalizePath — directly probe the normalizer the matcher depends on (no silent escape).
// ════════════════════════════════════════════════════════════════════════════════════════
describe("adversarial: normalizePath cannot silently bypass matching", () => {
  it("returns null for paths that escape the repo root", () => {
    expect(normalizePath("..")).toBeNull();
    expect(normalizePath("../x")).toBeNull();
    expect(normalizePath("a/../../x")).toBeNull();
    expect(normalizePath("/abs")).toBeNull();
  });

  it("returns null for empty / dot-only paths", () => {
    expect(normalizePath("")).toBeNull();
    expect(normalizePath("   ")).toBeNull();
    expect(normalizePath(".")).toBeNull();
    expect(normalizePath("./")).toBeNull();
  });

  it("resolves traversal into the canonical protected path (so the matcher sees it)", () => {
    expect(normalizePath("src/foo/../policy/x.ts")).toBe("src/policy/x.ts");
    expect(normalizePath("./src/policy/../policy/y.ts")).toBe("src/policy/y.ts");
  });

  it("lower-cases the result (case-insensitive matching is honored)", () => {
    expect(normalizePath("SRC/Policy/X.TS")).toBe("src/policy/x.ts");
  });

  it("strips trailing slash and collapses doubled slashes (no segment ambiguity)", () => {
    expect(normalizePath("src//policy///x.ts")).toBe("src/policy/x.ts");
    expect(normalizePath("src/policy/")).toBe("src/policy");
  });
});
