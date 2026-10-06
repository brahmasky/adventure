import { describe, expect, it } from "vitest";
import { memoryInformNote, memoryLaneCard } from "../../src/core/memory-lane-card.js";

// Spec §5.6: the card is code-owned, carries Undo + Ask Houge anyway, and callback data stays ≤ 64 bytes.
describe("memoryLaneCard", () => {
  const base = { lesson_id: 51, theme: "hygiene", text: "Never end a reply with a sign-off.", avoid: "祝好", verb: "update" as const, superseded_id: 44,
    change_id: "lc_12345678-1234-1234-1234-123456789abc", run_id: "run_12345678-1234-1234-1234-123456789abc" };
  it("renders header, lesson, AVOID and two buttons", () => {
    const c = memoryLaneCard(base);
    expect(c.text.split("\n")[0]).toBe("📒 Saved lesson #51 · hygiene (updated #44)");
    expect(c.text).toContain("Never end a reply with a sign-off.");
    expect(c.text).toContain("AVOID: ");
    expect(c.buttons).toEqual([{ text: "↩️ Undo", data: `memlane:undo:${base.change_id}` }, { text: "↪ Ask Houge anyway", data: `memlane:ask:${base.run_id}` }]);
    for (const b of c.buttons) expect(Buffer.byteLength(b.data, "utf8")).toBeLessThanOrEqual(64);
  });
  it("an add has no parenthetical; markdown-sensitive characters in the lesson are neutralised", () => {
    const { superseded_id: _s, avoid: _a, ...bare } = base;
    const c = memoryLaneCard({ ...bare, verb: "add", text: "Use *short* [lists]" });
    expect(c.text.split("\n")[0]).toBe("📒 Saved lesson #51 · hygiene");
    expect(c.text).not.toContain("AVOID");
    expect(c.text).not.toMatch(/[*[\]]/);
  });
  it("the inform note names the lesson and forbids a second save", () => {
    expect(memoryInformNote(51, "format")).toBe("[memory] Lesson #51 (format) was just saved from this message; do not save it again.");
  });
});
