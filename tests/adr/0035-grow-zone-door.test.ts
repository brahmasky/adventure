/**
 * Rules: ADR 0035 (docs/decisions/0035-grow-zone-verification.md) G1 the orchestrator writes no grow-zone item but the
 * exemplars in `grow-seed/`, and they are out of a self-write's reach.
 * Changing a rule changes its test in the same commit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTECTED_DIRS } from "../../src/capabilities/self-write-guard.js";
import { contentHash, parseSkillFile } from "../../src/grow/checks.js";
import { EXEMPLAR_NAME } from "../../src/grow/seed.js";

const root = join(import.meta.dirname, "..", "..");

describe("ADR 0035 G1: the exemplar is the orchestrator's alone", () => {
  it("lists grow-seed in PROTECTED_DIRS, so a self-write cannot edit or add an exemplar (one publishes unreviewed)", () => {
    expect(PROTECTED_DIRS).toContain("grow-seed");
  });

  // The exemplar's content is pinned: changing grow-seed/skills/option-comparison/SKILL.md changes this hash in the
  // same commit, so an edit to the one item that skips review is always a visible, reviewed change to this test.
  it("pins the exemplar's content hash", () => {
    const parsed = parseSkillFile(readFileSync(join(root, "grow-seed", "skills", EXEMPLAR_NAME, "SKILL.md"), "utf8"));
    expect(parsed).not.toBeNull();
    expect(parsed!.origin).toBe("exemplar");
    expect(contentHash(parsed!)).toBe("23c43d5335a7b3679c3073163ce7789952e47afc991bc29adfde9f4a73cd2a01");
  });
});
