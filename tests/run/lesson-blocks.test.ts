import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LESSON_CAP_PER_SCOPE, resolveLessonCapPerScope, RunStore } from "../../src/run/run-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};

const NOW = "2026-07-03T00:00:00.000Z";

let dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-lessons-"));
  dirs.push(dir);
  return join(dir, "test.sqlite");
}
// HERMETICITY: readLessonBlock/saveReconciledLesson read the cap from the env — pin it
// (delete = code default) so a daemon .env override can't silently change assertions.
let savedCap: string | undefined;
beforeEach(() => {
  savedCap = process.env.HOUGE_LESSON_CAP_PER_SCOPE;
  delete process.env.HOUGE_LESSON_CAP_PER_SCOPE;
});
afterEach(() => {
  if (savedCap === undefined) delete process.env.HOUGE_LESSON_CAP_PER_SCOPE;
  else process.env.HOUGE_LESSON_CAP_PER_SCOPE = savedCap;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("lessons store (⓪·3 S1 — per-lesson rows)", () => {
  it("is empty until a lesson is added", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.readLessonBlock("research")).toBeUndefined();
      expect(store.listLessons()).toEqual([]);
      expect(store.getActiveLessons("research")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("addLesson inserts an active row with defaults; readLessonBlock renders '- <text>' bullets", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addLesson({ scope: "research", text: "prefer primary sources", source: "user_feedback", created_at: NOW });
      store.addLesson({ scope: "research", text: "be concise", source: "loop", created_at: NOW });

      const row = store.getLesson(id)!;
      expect(row).toMatchObject({
        scope: "research",
        text: "prefer primary sources",
        avoid: null,
        status: "active",
        supersedes: null,
        superseded_by: null,
        applied_count: 0,
        corrected_count: 0,
        reuse_value: 1.0,
        rating_history: "[]",
        created_at: NOW,
        last_used: null,
        source: "user_feedback"
      });

      const block = store.readLessonBlock("research")!;
      expect(block).toContain("- prefer primary sources");
      expect(block).toContain("- be concise");
    } finally {
      store.close();
    }
  });

  it("renders an AVOID suffix line when set", () => {
    const store = RunStore.openInMemory();
    try {
      store.addLesson({ scope: "ask", text: "answer in the user's language", avoid: "mixing English into Chinese replies", source: "user_feedback", created_at: NOW });
      expect(store.readLessonBlock("ask")).toBe(
        "- answer in the user's language\n  AVOID: mixing English into Chinese replies"
      );
    } finally {
      store.close();
    }
  });

  it("orders active lessons by reuse_value desc, then recency (all values equal until S2 → newest first)", () => {
    const store = RunStore.openInMemory();
    try {
      const older = store.addLesson({ scope: "ask", text: "older", source: "loop", created_at: "2026-07-01T00:00:00.000Z" });
      const newer = store.addLesson({ scope: "ask", text: "newer", source: "loop", created_at: "2026-07-02T00:00:00.000Z" });
      // reuse_value is only moved by the S2 signal path; with equal values the recency
      // tiebreak governs, so the newest lesson renders first.
      expect(store.getActiveLessons("ask").map((l) => l.id)).toEqual([newer, older]);
      const capped = store.getActiveLessons("ask", 1);
      expect(capped.map((l) => l.id)).toEqual([newer]);
    } finally {
      store.close();
    }
  });

  it("caps the rendered block by row cap and by the legacy char-cap spirit", () => {
    const store = RunStore.openInMemory();
    try {
      for (let i = 0; i < 30; i += 1) {
        store.addLesson({ scope: "ask", text: `rule ${i} ${"x".repeat(100)}`, source: "loop", created_at: NOW });
      }
      const block = store.readLessonBlock("ask")!;
      expect(block.length).toBeLessThanOrEqual(1200);
      // Row cap: at most HOUGE_LESSON_CAP_PER_SCOPE rows are even considered.
      expect(block.split("\n").length).toBeLessThanOrEqual(DEFAULT_LESSON_CAP_PER_SCOPE);
    } finally {
      store.close();
    }
  });

  it("touchApplied increments applied_count + last_used; recordCorrection increments corrected_count", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addLesson({ scope: "ask", text: "be concise", source: "loop", created_at: NOW });
      store.touchApplied([id], "2026-07-03T01:00:00.000Z");
      store.touchApplied([id], "2026-07-03T02:00:00.000Z");
      store.recordCorrection(id);
      const row = store.getLesson(id)!;
      expect(row.applied_count).toBe(2);
      expect(row.last_used).toBe("2026-07-03T02:00:00.000Z");
      expect(row.corrected_count).toBe(1);
    } finally {
      store.close();
    }
  });

  it("supersedeLesson links BOTH directions and never deletes; lessonLineage walks the chain", () => {
    const store = RunStore.openInMemory();
    try {
      const v1 = store.addLesson({ scope: "ask", text: "use the Sydney timezone", source: "user_feedback", created_at: NOW });
      const v2 = store.addLesson({ scope: "ask", text: "use the Melbourne timezone", source: "user_feedback", created_at: NOW });
      store.supersedeLesson(v1, v2);
      const v3 = store.addLesson({ scope: "ask", text: "use the Perth timezone", source: "user_feedback", created_at: NOW });
      store.supersedeLesson(v2, v3);

      const old1 = store.getLesson(v1)!;
      expect(old1.status).toBe("superseded");
      expect(old1.superseded_by).toBe(v2);
      const mid = store.getLesson(v2)!;
      expect(mid).toMatchObject({ status: "superseded", supersedes: v1, superseded_by: v3 });
      expect(store.getLesson(v3)!.supersedes).toBe(v2);

      // Lineage from ANY link in the chain returns the whole chain, oldest → newest.
      for (const id of [v1, v2, v3]) {
        expect(store.lessonLineage(id).map((l) => l.id)).toEqual([v1, v2, v3]);
      }

      // Only the head is active / rendered.
      expect(store.getActiveLessons("ask").map((l) => l.id)).toEqual([v3]);
      expect(store.readLessonBlock("ask")).toBe("- use the Perth timezone");
    } finally {
      store.close();
    }
  });

  it("updateLessonText rewrites text in place (trivial merges only)", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addLesson({ scope: "ask", text: "be concise", source: "loop", created_at: NOW });
      store.updateLessonText(id, "be concise — under 200 words");
      expect(store.getLesson(id)!.text).toBe("be concise — under 200 words");
    } finally {
      store.close();
    }
  });

  it("forgetLesson / forgetScope prune reversibly (status flip, rows kept)", () => {
    const store = RunStore.openInMemory();
    try {
      const a = store.addLesson({ scope: "research", text: "a lesson", source: "loop", created_at: NOW });
      const b = store.addLesson({ scope: "research", text: "another", source: "loop", created_at: NOW });

      expect(store.forgetLesson(a)).toBe(true);
      expect(store.forgetLesson(a)).toBe(false); // already pruned — idempotent signal
      expect(store.getLesson(a)!.status).toBe("pruned"); // never deleted
      expect(store.getActiveLessons("research").map((l) => l.id)).toEqual([b]);

      store.forgetScope("research");
      expect(store.readLessonBlock("research")).toBeUndefined();
      expect(store.getLesson(b)!.status).toBe("pruned");
    } finally {
      store.close();
    }
  });

  describe("saveReconciledLesson (the verdict applier)", () => {
    it("ADD inserts a new active row", () => {
      const store = RunStore.openInMemory();
      try {
        const result = store.saveReconciledLesson(
          { scope: "ask", text: "be concise", avoid: "rambling" },
          { verdict: "ADD" },
          "loop",
          NOW
        );
        expect(result.verb).toBe("add");
        expect(result.prunedIds).toEqual([]);
        const row = store.getLesson(result.id!)!;
        expect(row).toMatchObject({ text: "be concise", avoid: "rambling", status: "active", source: "loop" });
      } finally {
        store.close();
      }
    });

    it("SUPERSEDE writes a NEW linked row and retires the old one", () => {
      const store = RunStore.openInMemory();
      try {
        const old = store.addLesson({ scope: "ask", text: "use the Sydney timezone", source: "user_feedback", created_at: NOW });
        const result = store.saveReconciledLesson(
          { scope: "ask", text: "use the Melbourne timezone" },
          { verdict: "SUPERSEDE", id: old },
          "user_feedback",
          NOW
        );
        expect(result).toMatchObject({ verb: "supersede", supersededId: old, lesson: "use the Melbourne timezone" });
        expect(store.getLesson(old)!.status).toBe("superseded");
        expect(store.getLesson(old)!.superseded_by).toBe(result.id);
        expect(store.getLesson(result.id!)!.supersedes).toBe(old);
        expect(store.getActiveLessons("ask").map((l) => l.id)).toEqual([result.id]);
      } finally {
        store.close();
      }
    });

    it("UPDATE stores the MERGED text as a new linked row and inherits the prior AVOID", () => {
      const store = RunStore.openInMemory();
      try {
        const old = store.addLesson({ scope: "ask", text: "be concise", avoid: "walls of text", source: "loop", created_at: NOW });
        const result = store.saveReconciledLesson(
          { scope: "ask", text: "keep answers under 200 words" },
          { verdict: "UPDATE", id: old, text: "be concise — keep answers under 200 words" },
          "user_feedback",
          NOW
        );
        expect(result).toMatchObject({ verb: "update", supersededId: old, lesson: "be concise — keep answers under 200 words" });
        const merged = store.getLesson(result.id!)!;
        expect(merged.text).toBe("be concise — keep answers under 200 words");
        expect(merged.avoid).toBe("walls of text"); // inherited (supplement semantics)
        expect(store.getLesson(old)!.status).toBe("superseded");
      } finally {
        store.close();
      }
    });

    it("DROP writes nothing", () => {
      const store = RunStore.openInMemory();
      try {
        store.addLesson({ scope: "ask", text: "be concise", source: "loop", created_at: NOW });
        const result = store.saveReconciledLesson(
          { scope: "ask", text: "shorter answers please" },
          { verdict: "DROP" },
          "user_feedback",
          NOW
        );
        expect(result).toEqual({ verb: "drop", lesson: "shorter answers please", prunedIds: [] });
        expect(store.getActiveLessons("ask")).toHaveLength(1);
      } finally {
        store.close();
      }
    });

    it("a SUPERSEDE/UPDATE against a missing or non-active target degrades to ADD", () => {
      const store = RunStore.openInMemory();
      try {
        const gone = store.addLesson({ scope: "ask", text: "old", source: "loop", created_at: NOW });
        store.forgetLesson(gone);
        const result = store.saveReconciledLesson(
          { scope: "ask", text: "new rule" },
          { verdict: "SUPERSEDE", id: gone },
          "loop",
          NOW
        );
        expect(result.verb).toBe("add");
        expect(result.supersededId).toBeUndefined();

        const missing = store.saveReconciledLesson(
          { scope: "ask", text: "another rule" },
          { verdict: "UPDATE", id: 99_999, text: "merged" },
          "loop",
          NOW
        );
        expect(missing.verb).toBe("add");
        expect(missing.lesson).toBe("another rule"); // the merge text is ignored without its target
      } finally {
        store.close();
      }
    });

    it("overflow beyond the per-scope cap prunes the lowest reuse_value rows, never the new row", () => {
      const store = RunStore.openInMemory();
      try {
        const a = store.addLesson({ scope: "ask", text: "a", source: "loop", created_at: "2026-07-01T00:00:00.000Z" });
        const b = store.addLesson({ scope: "ask", text: "b", source: "loop", created_at: "2026-07-02T00:00:00.000Z" });
        store.touchApplied([b], "2026-07-02T12:00:00.000Z"); // b was used more recently than a
        const result = store.saveReconciledLesson(
          { scope: "ask", text: "c" },
          { verdict: "ADD" },
          "loop",
          NOW,
          2 // cap
        );
        expect(result.verb).toBe("add");
        expect(result.prunedIds).toEqual([a]); // lowest value, least recently used
        expect(store.getLesson(a)!.status).toBe("pruned"); // reversible, not deleted
        expect(store.getActiveLessons("ask").map((l) => l.text).sort()).toEqual(["b", "c"]);
      } finally {
        store.close();
      }
    });
  });

  describe("migration (bullets → rows, one-time, idempotent)", () => {
    it("splits each legacy block's '- <lesson>' bullets into active rows (source 'migration')", () => {
      const path = tempDbPath();
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE lesson_blocks (
          scope TEXT PRIMARY KEY,
          block TEXT NOT NULL DEFAULT '',
          char_cap INTEGER NOT NULL DEFAULT 1200,
          updated_at TEXT NOT NULL
        );
        INSERT INTO lesson_blocks (scope, block, updated_at) VALUES
          ('ask', '- be concise' || char(10) || '- answer in Chinese' || char(10) || 'stray non-bullet line', '2026-06-20T00:00:00.000Z'),
          ('research', '- prefer primary sources', '2026-06-21T00:00:00.000Z');
      `);
      raw.close();

      const store = RunStore.open(path);
      try {
        const ask = store.getActiveLessons("ask");
        expect(ask.map((l) => l.text)).toEqual(
          expect.arrayContaining(["be concise", "answer in Chinese", "stray non-bullet line"])
        );
        expect(ask).toHaveLength(3);
        for (const row of ask) {
          expect(row.source).toBe("migration");
          expect(row.created_at).toBe("2026-06-20T00:00:00.000Z");
        }
        expect(store.getActiveLessons("research").map((l) => l.text)).toEqual(["prefer primary sources"]);
        // The composer read path serves the migrated rows.
        expect(store.readLessonBlock("research")).toBe("- prefer primary sources");
      } finally {
        store.close();
      }

      // Idempotent: reopening the same file does NOT re-split the (kept) legacy blocks.
      const reopened = RunStore.open(path);
      try {
        expect(reopened.getActiveLessons("ask")).toHaveLength(3);
        expect(reopened.getActiveLessons("research")).toHaveLength(1);
      } finally {
        reopened.close();
      }
    });

    it("a fresh store (no legacy blocks) migrates to an empty lessons table", () => {
      const store = RunStore.openInMemory();
      try {
        expect(store.listLessons()).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  describe("resolveLessonCapPerScope (HOUGE_LESSON_CAP_PER_SCOPE)", () => {
    it("defaults to 20 (hermetic: the env var is cleared first) and honors an override", () => {
      const saved = process.env.HOUGE_LESSON_CAP_PER_SCOPE;
      try {
        delete process.env.HOUGE_LESSON_CAP_PER_SCOPE;
        expect(resolveLessonCapPerScope(process.env)).toBe(20);
        expect(DEFAULT_LESSON_CAP_PER_SCOPE).toBe(20);

        process.env.HOUGE_LESSON_CAP_PER_SCOPE = "5";
        expect(resolveLessonCapPerScope(process.env)).toBe(5);

        process.env.HOUGE_LESSON_CAP_PER_SCOPE = "0";
        expect(resolveLessonCapPerScope(process.env)).toBe(20);
        process.env.HOUGE_LESSON_CAP_PER_SCOPE = "junk";
        expect(resolveLessonCapPerScope(process.env)).toBe(20);
      } finally {
        if (saved === undefined) delete process.env.HOUGE_LESSON_CAP_PER_SCOPE;
        else process.env.HOUGE_LESSON_CAP_PER_SCOPE = saved;
      }
    });
  });
});
