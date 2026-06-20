import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-06-19T00:00:00.000Z";

describe("lesson_blocks store (ADR 0010)", () => {
  it("is empty until a lesson is appended", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.readLessonBlock("research")).toBeUndefined();
      expect(store.listLessonBlocks()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("appends '- <lesson>' bullets, upserting the scope's block", async () => {
    const store = RunStore.openInMemory();
    try {
      await store.appendLessonToBlock("research", "prefer primary sources", NOW);
      await store.appendLessonToBlock("research", "be concise", NOW);
      const block = store.readLessonBlock("research")!;
      expect(block).toContain("- prefer primary sources");
      expect(block).toContain("- be concise");

      const all = store.listLessonBlocks();
      expect(all).toHaveLength(1);
      expect(all[0]!.scope).toBe("research");
      expect(all[0]!.char_cap).toBe(1200);
    } finally {
      store.close();
    }
  });

  it("ignores an empty/whitespace lesson", async () => {
    const store = RunStore.openInMemory();
    try {
      await store.appendLessonToBlock("ask", "   ", NOW);
      expect(store.readLessonBlock("ask")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("invokes the rewrite consolidation when the block exceeds char_cap (default 1200), replacing it", async () => {
    const store = RunStore.openInMemory();
    try {
      // A lesson over the 1200 default cap forces the rewrite pass on append.
      const longLesson = "x".repeat(1300);
      let rewriteSaw: string | undefined;
      await store.appendLessonToBlock("ask", longLesson, NOW, async (text) => {
        rewriteSaw = text;
        return "- consolidated";
      });
      expect(rewriteSaw).toContain("x".repeat(1300));
      expect(store.readLessonBlock("ask")).toBe("- consolidated");
    } finally {
      store.close();
    }
  });

  it("hard-truncates to char_cap as a backstop when the rewrite still overruns", async () => {
    const store = RunStore.openInMemory();
    try {
      await store.appendLessonToBlock("ask", "x".repeat(1300), NOW, async () => "y".repeat(5000));
      expect(store.readLessonBlock("ask")!.length).toBe(1200);
    } finally {
      store.close();
    }
  });

  it("keeps the appended block (then truncates) when the rewrite throws", async () => {
    const store = RunStore.openInMemory();
    try {
      await store.appendLessonToBlock("ask", "z".repeat(1300), NOW, async () => {
        throw new Error("rewrite failed");
      });
      expect(store.readLessonBlock("ask")!.length).toBe(1200);
    } finally {
      store.close();
    }
  });

  it("forgetScope clears the block", async () => {
    const store = RunStore.openInMemory();
    try {
      await store.appendLessonToBlock("research", "a lesson", NOW);
      expect(store.readLessonBlock("research")).toBeDefined();
      store.forgetScope("research");
      expect(store.readLessonBlock("research")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
