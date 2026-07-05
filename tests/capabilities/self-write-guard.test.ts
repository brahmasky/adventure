import { describe, expect, it } from "vitest";
import {
  checkSelfWriteDiff,
  normalizePath,
  parseDiffRaw,
  type DiffEntry,
  type GuardResult
} from "../../src/capabilities/self-write-guard.js";

/**
 * These tests are the adversarial spec for CHECKER 1 (self-write-guard). Each cluster encodes
 * WHY the behavior matters: the protected surface (ADR 0011 Phase 3 § Security review) must be
 * structurally unreachable by Houge's self-write, and every documented bypass must fail closed.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────────────────
function entry(partial: Partial<DiffEntry> & { status: string; path: string }): DiffEntry {
  return { newMode: "100644", oldMode: "100644", ...partial };
}
function check(...entries: DiffEntry[]): GuardResult {
  return checkSelfWriteDiff(entries);
}
function deniedPaths(result: GuardResult): string[] {
  return result.allowed ? [] : result.denied.map((d) => d.path);
}

// ── parseDiffRaw: the real git --raw format ────────────────────────────────────────────────
describe("parseDiffRaw", () => {
  it("parses modify, add, symlink, and rename lines from real `git diff --raw -M -C` output", () => {
    const raw = [
      ":100644 100644 7898192 422c2b7 M\tsrc/a.ts",
      ":000000 100644 0000000 3e75765 A\tsrc/new.ts",
      ":000000 120000 0000000 3594e94 A\tsrc/sym.ts",
      ":100644 100644 3367afd 3367afd R100\ttests/x.test.ts\ttests/y.test.ts"
    ].join("\n");
    const parsed = parseDiffRaw(raw);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({ status: "M", path: "src/a.ts", newMode: "100644" });
    expect(parsed[1]).toMatchObject({ status: "A", path: "src/new.ts" });
    expect(parsed[2]).toMatchObject({ status: "A", path: "src/sym.ts", newMode: "120000" });
    // Rename: status normalized to "R" (score stripped), both paths captured.
    expect(parsed[3]).toMatchObject({ status: "R", oldPath: "tests/x.test.ts", path: "tests/y.test.ts" });
  });

  it("captures a type-change (T) with its mode flip", () => {
    const parsed = parseDiffRaw(":100644 120000 7898192 3594e94 T\tsrc/a.ts");
    expect(parsed[0]).toMatchObject({ status: "T", path: "src/a.ts", oldMode: "100644", newMode: "120000" });
  });

  it("returns [] for empty input and never throws", () => {
    expect(parseDiffRaw("")).toEqual([]);
    expect(parseDiffRaw("\n\n")).toEqual([]);
    // @ts-expect-error — defending against non-string input
    expect(parseDiffRaw(undefined)).toEqual([]);
  });

  it("marks garbage lines malformed instead of throwing (fail-closed input)", () => {
    const parsed = parseDiffRaw("not a diff line\n:bad meta no tab\n:100644 100644 a b R100\ttests/only-one.ts");
    expect(parsed[0]!.malformed).toBe(true); // no leading ':'
    expect(parsed[1]!.malformed).toBe(true); // no tab
    expect(parsed[2]!.malformed).toBe(true); // rename with only one path
  });
});

// ── normalizePath: the matching foundation ─────────────────────────────────────────────────
describe("normalizePath", () => {
  it("strips ./, collapses .. , unifies separators, lower-cases", () => {
    expect(normalizePath("./src/foo.ts")).toBe("src/foo.ts");
    expect(normalizePath("src/foo/../bar.ts")).toBe("src/bar.ts");
    expect(normalizePath("src\\foo.ts")).toBe("src/foo.ts");
    expect(normalizePath("SRC/Policy/X.ts")).toBe("src/policy/x.ts");
  });

  it("returns null for paths that escape the repo root or are empty/absolute (fail-closed)", () => {
    expect(normalizePath("../outside")).toBeNull();
    expect(normalizePath("src/../../package.json")).toBeNull();
    expect(normalizePath("")).toBeNull();
    expect(normalizePath("   ")).toBeNull();
    expect(normalizePath("/etc/passwd")).toBeNull();
  });
});

// ── ALLOWED: the legitimate self-write surface ─────────────────────────────────────────────
describe("checkSelfWriteDiff — allowed", () => {
  it("allows a net-new src file (A)", () => {
    expect(check(entry({ status: "A", path: "src/capabilities/foo.ts", oldMode: "000000" }))).toEqual({ allowed: true });
  });

  it("allows modifying an unprotected src file (M)", () => {
    expect(check(entry({ status: "M", path: "src/core/core-worker.ts" }))).toEqual({ allowed: true });
  });

  it("allows ADDING a net-new test file (A under tests/) — coverage for his own fix", () => {
    expect(check(entry({ status: "A", path: "tests/capabilities/foo.test.ts", oldMode: "000000" }))).toEqual({ allowed: true });
  });

  it("allows several clean changes at once", () => {
    const r = check(
      entry({ status: "M", path: "src/core/core-worker.ts" }),
      entry({ status: "A", path: "src/core/helper.ts", oldMode: "000000" }),
      entry({ status: "A", path: "tests/core/helper.test.ts", oldMode: "000000" })
    );
    expect(r).toEqual({ allowed: true });
  });
});

// ── DENIED: each protected class (the surface table) ───────────────────────────────────────
describe("checkSelfWriteDiff — every protected class is hard-denied", () => {
  const protectedHits: Array<[string, DiffEntry]> = [
    ["policy dir", entry({ status: "M", path: "src/policy/something.ts" })],
    ["capability-policy under policy dir", entry({ status: "M", path: "src/policy/capability-policy.ts" })],
    ["task-contract", entry({ status: "M", path: "src/contracts/task-contract.ts" })],
    ["capability-runner", entry({ status: "M", path: "src/capabilities/capability-runner.ts" })],
    ["capability-policy (spec-listed path)", entry({ status: "M", path: "src/capabilities/capability-policy.ts" })],
    ["run-store", entry({ status: "M", path: "src/run/run-store.ts" })],
    ["worktree", entry({ status: "M", path: "src/run/worktree.ts" })],
    ["coding-agent", entry({ status: "M", path: "src/capabilities/coding-agent.ts" })],
    ["self-write-guard ITSELF (self-protection)", entry({ status: "M", path: "src/capabilities/self-write-guard.ts" })],
    ["secret-broker (secrets firewall wiring)", entry({ status: "M", path: "src/config/secret-broker.ts" })],
    ["cli.ts (secrets firewall boot wiring)", entry({ status: "M", path: "src/cli.ts" })],
    ["llm/registry (secrets firewall key resolution)", entry({ status: "M", path: "src/llm/registry.ts" })],
    ["web/registry (secrets firewall key resolution)", entry({ status: "M", path: "src/web/registry.ts" })],
    ["test-gate (Phase-3)", entry({ status: "M", path: "src/run/test-gate.ts" })],
    ["diff-reviewer (Phase-3)", entry({ status: "M", path: "src/capabilities/diff-reviewer.ts" })],
    ["houge.md identity", entry({ status: "M", path: "memory/core/houge.md" })],
    ["docs/decisions ADR dir", entry({ status: "M", path: "docs/decisions/0011-self-evolution-architecture.md" })],
    ["AGENTS.md", entry({ status: "M", path: "AGENTS.md" })],
    ["package.json", entry({ status: "M", path: "package.json" })],
    ["package-lock.json", entry({ status: "M", path: "package-lock.json" })],
    ["tsconfig.json", entry({ status: "M", path: "tsconfig.json" })],
    [".gitignore", entry({ status: "M", path: ".gitignore" })],
    [".github dir", entry({ status: "M", path: ".github/workflows/ci.yml" })]
  ];

  for (const [name, e] of protectedHits) {
    it(`denies ${name}`, () => {
      const r = check(e);
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.denied).toHaveLength(1);
    });
  }

  it("even DELETING a protected file is denied (can't remove a gate)", () => {
    expect(check(entry({ status: "D", path: "src/policy/x.ts", newMode: "000000" })).allowed).toBe(false);
  });

  it("even ADDING into a protected dir is denied (A under src/policy/)", () => {
    expect(check(entry({ status: "A", path: "src/policy/new-gate.ts", oldMode: "000000" })).allowed).toBe(false);
  });
});

// ── DENIED: test-integrity (net-new only) ──────────────────────────────────────────────────
describe("checkSelfWriteDiff — test integrity (he may add coverage, never weaken it)", () => {
  it("denies modifying an existing test (M)", () => {
    expect(check(entry({ status: "M", path: "tests/capabilities/coding-agent.test.ts" })).allowed).toBe(false);
  });
  it("denies deleting a test (D) — the fake-pass-by-deleting-the-failing-test attack", () => {
    expect(check(entry({ status: "D", path: "tests/capabilities/coding-agent.test.ts", newMode: "000000" })).allowed).toBe(false);
  });
  it("denies renaming a test (R tests/a -> tests/b)", () => {
    expect(check(entry({ status: "R", oldPath: "tests/a.test.ts", path: "tests/b.test.ts" })).allowed).toBe(false);
  });
  it("denies renaming a test OUT of tests/ (exfiltrate the failing test)", () => {
    expect(check(entry({ status: "R", oldPath: "tests/a.test.ts", path: "src/a.test.ts" })).allowed).toBe(false);
  });
  it("denies copying over a test (C into tests/)", () => {
    expect(check(entry({ status: "C", oldPath: "src/x.ts", path: "tests/x.test.ts" })).allowed).toBe(false);
  });
});

// ── DENIED: the 7 documented bypass classes ────────────────────────────────────────────────
describe("checkSelfWriteDiff — bypass defenses (1: normalization)", () => {
  it("denies a traversal that normalizes into a protected file", () => {
    // src/foo/../policy/x.ts → src/policy/x.ts
    expect(check(entry({ status: "M", path: "src/foo/../policy/x.ts" })).allowed).toBe(false);
  });
  it("denies a traversal that escapes the worktree root entirely (fail-closed)", () => {
    // src/policy/../../package.json escapes root → null → DENY
    expect(check(entry({ status: "M", path: "src/policy/../../package.json" })).allowed).toBe(false);
  });
  it("denies a leading-./ disguise of a protected file", () => {
    expect(check(entry({ status: "M", path: "./src/run/worktree.ts" })).allowed).toBe(false);
  });
});

describe("checkSelfWriteDiff — bypass defenses (2: segment-boundary precision)", () => {
  it("ALLOWS src/policymore.ts — proves the matcher is segment-precise, not a raw prefix", () => {
    expect(check(entry({ status: "M", path: "src/policymore.ts" }))).toEqual({ allowed: true });
  });
  it("ALLOWS src/policy-extra.ts (sibling, not under the dir)", () => {
    expect(check(entry({ status: "A", path: "src/policy-extra.ts", oldMode: "000000" }))).toEqual({ allowed: true });
  });
  it("ALLOWS a file whose name merely contains a protected basename", () => {
    expect(check(entry({ status: "A", path: "src/capabilities/coding-agent-helpers.ts", oldMode: "000000" }))).toEqual({ allowed: true });
  });
  it("still denies the exact protected dir prefix", () => {
    expect(check(entry({ status: "M", path: "src/policy/sub/deep.ts" })).allowed).toBe(false);
  });
});

describe("checkSelfWriteDiff — bypass defenses (3: renames/copies, both sides)", () => {
  it("denies a rename FROM a protected path (exfiltrate gate code)", () => {
    expect(check(entry({ status: "R", oldPath: "src/policy/x.ts", path: "src/whatever.ts" })).allowed).toBe(false);
  });
  it("denies a rename INTO a protected path", () => {
    expect(check(entry({ status: "R", oldPath: "src/whatever.ts", path: "src/policy/x.ts" })).allowed).toBe(false);
  });
  it("denies a copy FROM a protected path", () => {
    expect(check(entry({ status: "C", oldPath: "src/run/worktree.ts", path: "src/copy.ts" })).allowed).toBe(false);
  });
  it("allows a clean rename of two unprotected, non-test files", () => {
    expect(check(entry({ status: "R", oldPath: "src/old.ts", path: "src/new.ts" }))).toEqual({ allowed: true });
  });
});

describe("checkSelfWriteDiff — bypass defenses (4: symlinks & type-changes)", () => {
  it("denies an added symlink even in an allowed location (target unverifiable)", () => {
    expect(check(entry({ status: "A", path: "src/link.ts", oldMode: "000000", newMode: "120000" })).allowed).toBe(false);
  });
  it("denies a type-change (T) on any path", () => {
    expect(check(entry({ status: "T", path: "src/core/core-worker.ts", oldMode: "100644", newMode: "120000" })).allowed).toBe(false);
  });
  it("denies a symlink that points at a protected location via its path too", () => {
    expect(check(entry({ status: "A", path: "src/policy/link.ts", oldMode: "000000", newMode: "120000" })).allowed).toBe(false);
  });
});

describe("checkSelfWriteDiff — bypass defenses (5: case / encoding)", () => {
  it("denies a case-variant of a protected file (macOS case-insensitive FS)", () => {
    expect(check(entry({ status: "M", path: "SRC/Policy/Gate.ts" })).allowed).toBe(false);
    expect(check(entry({ status: "M", path: "Package.JSON" })).allowed).toBe(false);
    expect(check(entry({ status: "M", path: "agents.md" })).allowed).toBe(false);
  });
});

describe("checkSelfWriteDiff — bypass defenses (6: garbage/empty fails closed)", () => {
  it("allows a truly empty diff (nothing changed = nothing to deny)", () => {
    expect(check()).toEqual({ allowed: true });
  });
  it("denies a malformed parsed entry (fail-closed, never throws)", () => {
    const parsed = parseDiffRaw("garbage not a diff");
    expect(checkSelfWriteDiff(parsed).allowed).toBe(false);
  });
  it("denies an entry with an empty/unnormalizable path", () => {
    expect(check(entry({ status: "M", path: "" })).allowed).toBe(false);
    expect(check(entry({ status: "M", path: "../escape.ts" })).allowed).toBe(false);
  });
  it("denies when the whole input is not an array (defensive)", () => {
    // @ts-expect-error — guarding against bad caller input
    expect(checkSelfWriteDiff(null).allowed).toBe(false);
    // @ts-expect-error
    expect(checkSelfWriteDiff(undefined).allowed).toBe(false);
  });
  it("end-to-end from raw garbage never throws and fails closed", () => {
    expect(() => checkSelfWriteDiff(parseDiffRaw(":::::\n\t\t\t"))).not.toThrow();
    expect(checkSelfWriteDiff(parseDiffRaw(":::::\n\t\t\t")).allowed).toBe(false);
  });
});

describe("checkSelfWriteDiff — bypass defenses (7: any hit denies the whole set, all listed)", () => {
  it("denies the whole diff if ANY entry hits protected, listing every offender", () => {
    const r = check(
      entry({ status: "M", path: "src/core/core-worker.ts" }), // clean
      entry({ status: "M", path: "src/policy/gate.ts" }), // protected
      entry({ status: "D", path: "tests/x.test.ts", newMode: "000000" }) // test integrity
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.denied).toHaveLength(2);
      expect(deniedPaths(r)).toContain("src/policy/gate.ts");
      expect(deniedPaths(r)).toContain("tests/x.test.ts");
    }
  });

  it("each denial carries a path, status, and a reason", () => {
    const r = check(entry({ status: "M", path: "package.json" }));
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.denied[0]).toMatchObject({ path: "package.json", status: "M" });
      expect(r.denied[0]!.reason).toMatch(/protected/i);
    }
  });
});

// ── End-to-end: parse a realistic mixed diff, then guard it ────────────────────────────────
describe("checkSelfWriteDiff — end-to-end from real raw output shape", () => {
  it("denies a realistic mixed diff (good fix + sneaky gate edit + deleted test)", () => {
    const raw = [
      ":000000 100644 0000000 3e75765 A\tsrc/core/fix.ts", // ok
      ":100644 100644 7898192 422c2b7 M\tsrc/run/worktree.ts", // protected
      ":100644 000000 3367afd 0000000 D\ttests/capabilities/coding-agent.test.ts" // test del
    ].join("\n");
    const r = checkSelfWriteDiff(parseDiffRaw(raw));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.denied).toHaveLength(2);
  });

  it("allows a realistic clean diff (fix + net-new test)", () => {
    const raw = [
      ":100644 100644 7898192 422c2b7 M\tsrc/core/core-worker.ts",
      ":000000 100644 0000000 3e75765 A\ttests/core/core-worker.fix.test.ts"
    ].join("\n");
    expect(checkSelfWriteDiff(parseDiffRaw(raw))).toEqual({ allowed: true });
  });
});
