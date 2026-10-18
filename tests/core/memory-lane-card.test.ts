import { describe, expect, it } from "vitest";
import { memoryInformNote, memoryLaneCard } from "../../src/core/memory-lane-card.js";

// Spec §5.6 + stage B §6: the card is code-owned, carries Undo + Dig deeper, and callback data stays ≤ 64 bytes.
describe("memoryLaneCard", () => {
  const base = { lesson_id: 51, theme: "hygiene", text: "Never end a reply with a sign-off.", avoid: "祝好", verb: "update" as const, superseded_id: 44,
    change_id: "lc_12345678-1234-1234-1234-123456789abc", run_id: "run_12345678-1234-1234-1234-123456789abc" };
  it("renders header, lesson, AVOID and two buttons", () => {
    const { run_id: _r, ...lessonOf } = base;
    const c = memoryLaneCard({ run_id: base.run_id, lesson: lessonOf });
    expect(c.text.split("\n")[0]).toBe("📒 Saved lesson #51 · hygiene (updated #44)");
    expect(c.text).toContain("Never end a reply with a sign-off.");
    expect(c.text).toContain("AVOID: ");
    expect(c.buttons).toEqual([{ text: "↩️ Undo", data: `memlane:undo:${base.change_id}` }, { text: "🔍 Dig deeper", data: `lane:ask:${base.run_id}` }]);
    for (const b of c.buttons) expect(Buffer.byteLength(b.data, "utf8")).toBeLessThanOrEqual(64);
  });
  it("an add has no parenthetical; markdown-sensitive characters in the lesson are neutralised", () => {
    const { superseded_id: _s, avoid: _a, ...bare } = base;
    const { run_id, ...lessonBare } = bare;
    const c = memoryLaneCard({ run_id, lesson: { ...lessonBare, verb: "add", text: "Use *short* [lists]" } });
    expect(c.text.split("\n")[0]).toBe("📒 Saved lesson #51 · hygiene");
    expect(c.text).not.toContain("AVOID");
    expect(c.text).not.toMatch(/[*[\]]/);
  });
  it("the inform note names the lesson and forbids a second save", () => {
    expect(memoryInformNote({ lesson: { id: 51, theme: "format" } })).toBe("[memory] Lesson #51 (format) was just saved from this message; do not save it again.");
  });
});

// Spec §8-§9: a fact save is announced on the same card with its own Undo (memory:undo:<change_id>, the memory_correct
// Undo path). With two items each Undo names its kind, so Paco can take back one without the other. A lesson-only card
// is byte-identical to the stage-1 card (the pins depend on it).
describe("memoryLaneCard with a fact", () => {
  const fact = { fact_id: 198, text: "Paco prefers the *south* side noodle shop", verb: "add" as const, change_id: "mc_12345678-1234-1234-1234-123456789abc" };
  const lesson = { lesson_id: 51, theme: "format", text: "Lead with the result.", verb: "add" as const, change_id: "lc_12345678-1234-1234-1234-123456789abc" };
  const run_id = "run_12345678-1234-1234-1234-123456789abc";
  it("a fact-only card: the 事实 line, the fact inert, one plain Undo on memory:undo, then Dig deeper", () => {
    const c = memoryLaneCard({ run_id, fact });
    expect(c.text.split("\n")[0]).toBe("🧠 Saved fact (事实) #198");
    expect(c.text).not.toMatch(/\*south\*/);
    expect(c.buttons).toEqual([{ text: "↩️ Undo", data: `memory:undo:${fact.change_id}` }, { text: "🔍 Dig deeper", data: `lane:ask:${run_id}` }]);
  });
  it("a both card: the lesson lines, then the fact lines; each Undo names its kind", () => {
    const c = memoryLaneCard({ run_id, lesson, fact: { ...fact, verb: "supersede", superseded_id: 120 } });
    expect(c.text.split("\n")).toEqual(["📒 Saved lesson #51 · format", "`Lead with the result.`", "🧠 Saved fact (事实) #198 (replaced #120)", expect.stringContaining("south")]);
    expect(c.buttons.map((b) => b.text)).toEqual(["↩️ Undo 规则", "↩️ Undo 事实", "🔍 Dig deeper"]);
    for (const b of c.buttons) expect(Buffer.byteLength(b.data, "utf8")).toBeLessThanOrEqual(64);
  });
  it("the inform note names each saved item and forbids a second save", () => {
    expect(memoryInformNote({ fact: { id: 198 } })).toBe("[memory] Fact #198 was just saved from this message; do not save it again.");
    expect(memoryInformNote({ lesson: { id: 51, theme: "format" }, fact: { id: 198 } }))
      .toBe("[memory] Lesson #51 (format) and fact #198 were just saved from this message; do not save them again.");
  });
});
