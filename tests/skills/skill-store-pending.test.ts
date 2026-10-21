import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillFile, setFrontmatterFields, SkillStore } from "../../src/skills/skill-store.js";

// Spec 2b-ii §5.2 promotion protocol (codex D7): ONE protocol — read the pending file, collision check on the active tree
// (refuse / replace = retire the active one with lineage / keep_both = a -2 suffix), write the active copy (registry
// regenerated), unlink the pending copy. Steps are idempotent so a crash between them is retried from the first.
const file = (name: string, when = "asked") => `---\nname: ${name}\nscope: ask\nwhen: ${when}\nanchors:\n  - a\nversion: 1\n---\n1. step\n`;
const fresh = () => new SkillStore({ root: mkdtempSync(join(tmpdir(), "hg-skills-")) });
const NOW = "2026-10-21";

describe("promotePending", () => {
  it("moves a pending draft into the active tree, regenerates the registry, removes the pending copy", () => {
    const s = fresh();
    s.writePending("ask", "weekly-report", file("weekly-report"));
    const r = s.promotePending("ask", "weekly-report", { onCollision: "refuse", now: NOW });
    expect(r).toMatchObject({ ok: true, name: "weekly-report" });
    expect(s.list().map((m) => m.name)).toEqual(["weekly-report"]);
    expect(s.listPending()).toEqual([]);
    expect(readFileSync(join(s["root"], "REGISTRY.md"), "utf8")).toContain("weekly-report");
  });
  it("refuse: a collision with an active skill writes nothing; replace: the active one retires with lineage; keep_both: the new one gets -2", () => {
    const s = fresh();
    s.writeSkill("ask", "weekly-report", file("weekly-report", "old"));
    s.writePending("ask", "weekly-report", file("weekly-report", "new"));
    expect(s.promotePending("ask", "weekly-report", { onCollision: "refuse", now: NOW })).toEqual({ ok: false, error: "collision" });
    expect(s.pendingExists("ask", "weekly-report")).toBe(true);
    expect(s.promotePending("ask", "weekly-report", { onCollision: "replace", now: NOW })).toMatchObject({ ok: true, name: "weekly-report" });
    expect(s.listRetired().map((m) => [m.name, m.retired_by, m.superseded_by])).toEqual([["weekly-report", "paco", "weekly-report"]]);
    expect(s.readSkill("ask", "weekly-report")?.meta.when).toBe("new");
    s.writePending("ask", "weekly-report", file("weekly-report", "newer"));
    expect(s.promotePending("ask", "weekly-report", { onCollision: "keep_both", now: NOW })).toMatchObject({ ok: true, name: "weekly-report-2" });
    expect(s.list().map((m) => m.name).sort()).toEqual(["weekly-report", "weekly-report-2"]);
  });
  it("retry after a crash: an identical active copy counts as written; a missing pending copy with the active present counts as done; a draft that never existed is not_found; keep_both takes the first free suffix", () => {
    const s = fresh();
    s.writePending("ask", "x", file("x"));
    s.writeSkill("ask", "x", file("x")); // the crash happened after the active write
    expect(s.promotePending("ask", "x", { onCollision: "refuse", now: NOW })).toMatchObject({ ok: true, name: "x" });
    expect(s.pendingExists("ask", "x")).toBe(false);
    expect(s.promotePending("ask", "x", { onCollision: "refuse", now: NOW })).toMatchObject({ ok: true, name: "x" }); // the retried step 4
    expect(s.promotePending("ask", "never", { onCollision: "refuse", now: NOW })).toEqual({ ok: false, error: "not_found" });
    s.writeSkill("ask", "x-2", file("x-2"));
    s.writePending("ask", "x", file("x", "third"));
    expect(s.promotePending("ask", "x", { onCollision: "keep_both", now: NOW })).toMatchObject({ ok: true, name: "x-3" });
    expect(s.readSkill("ask", "x-3")?.meta.name).toBe("x-3"); // the frontmatter name follows the file name
    expect(s.list().map((m) => m.name).sort()).toEqual(["x", "x-2", "x-3"]);
  });
  it("dismissPending moves the draft to _retired with the paco stamp; listPendingFiles names scope and name", () => {
    const s = fresh();
    s.writePending("ask", "y", file("y"));
    expect(s.listPendingFiles()).toEqual([{ scope: "ask", name: "y" }]);
    expect(s.dismissPending("ask", "y", NOW)).toMatchObject({ ok: true });
    expect(s.listPending()).toEqual([]);
    expect(s.listRetired().map((m) => [m.name, m.retired_by])).toEqual([["y", "paco"]]);
    expect(existsSync(join(s["root"], "_pending", "ask", "y.md"))).toBe(false);
  });
});

it("setFrontmatterFields writes name and origin, replacing an existing name line and adding a missing origin line", () => {
  const out = setFrontmatterFields(file("old"), { name: "new-name", origin: "improve_job:job_1" });
  expect(parseSkillFile(out)?.meta).toMatchObject({ name: "new-name", origin: "improve_job:job_1" });
  expect(out.match(/^name:/gm)).toHaveLength(1);
});
