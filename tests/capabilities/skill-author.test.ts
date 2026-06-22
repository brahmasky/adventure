import { describe, expect, it } from "vitest";
import { buildSkillAuthorQuestion, parseAuthoredSkill } from "../../src/capabilities/skill-author.js";

const VALID_FILE = `---
name: cross-check-figures
scope: research
when: comparing numbers across multiple sources
anchors:
  - a part never exceeds its whole
  - units are converted before comparison
version: 1
origin: commanded
---

1. List every figure and its source.
2. Verify each against its source before trusting it.`;

describe("buildSkillAuthorQuestion", () => {
  it("frames the request as data and asks for the file only", () => {
    const q = buildSkillAuthorQuestion("write a skill for cross-checking figures");
    expect(q).toContain("write a skill for cross-checking figures");
    expect(q.toLowerCase()).toContain("reference data");
    expect(q.toLowerCase()).toContain("complete skill markdown file");
  });

  it("on refine, includes the current skill and asks to improve in place + bump version", () => {
    const q = buildSkillAuthorQuestion("make it cover currencies too", VALID_FILE);
    expect(q).toContain("ALREADY EXISTS");
    expect(q).toContain("increment `version`");
    expect(q).toContain("cross-check-figures");
  });
});

describe("parseAuthoredSkill", () => {
  it("parses a valid author output", () => {
    const result = parseAuthoredSkill(VALID_FILE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.name).toBe("cross-check-figures");
      expect(result.skill.scope).toBe("research");
      expect(result.skill.meta.anchors).toHaveLength(2);
      expect(result.skill.body).toContain("List every figure");
    }
  });

  it("strips a wrapping code fence the model may have added", () => {
    const fenced = "```markdown\n" + VALID_FILE + "\n```";
    const result = parseAuthoredSkill(fenced);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.file.startsWith("---")).toBe(true);
  });

  it("returns a structured failure on malformed output (never throws)", () => {
    expect(parseAuthoredSkill("sorry, I cannot do that").ok).toBe(false);
    expect(parseAuthoredSkill("").ok).toBe(false);
    expect(parseAuthoredSkill("---\nname: x\n---\nbody").ok).toBe(false); // missing scope/when
  });
});
