import { afterEach, describe, expect, it } from "vitest";
import { LESSON_MERGE_REUSE_CAP, RunStore } from "../../src/run/run-store.js";

const NOW = "2026-07-23T12:00:00.000Z";

let stores: RunStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function openStore(): RunStore {
  const store = RunStore.openInMemory();
  stores.push(store);
  return store;
}

/** Raw db handle to set fields (reuse_value/applied_count) the public API deliberately can't. */
function db(store: RunStore): {
  prepare(sql: string): { run(...v: Array<string | number>): unknown };
} {
  return (store as unknown as { db: { prepare(sql: string): { run(...v: Array<string | number>): unknown } } }).db;
}

function setMetrics(store: RunStore, id: number, applied: number, reuse: number): void {
  db(store).prepare("UPDATE lessons SET applied_count = ?, reuse_value = ? WHERE id = ?").run(applied, reuse, id);
}

describe("applyLessonMerge (ADD-then-supersede-all)", () => {
  it("adds a NEW active row, sums applied_count, and supersedes every member reversibly", () => {
    const store = openStore();
    const a = store.addLesson({ scope: "ask", text: "be concise", source: "user_feedback", created_at: NOW });
    const b = store.addLesson({ scope: "ask", text: "keep it short", source: "user_feedback", created_at: NOW });
    const c = store.addLesson({ scope: "ask", text: "answer briefly", source: "loop", created_at: NOW });
    setMetrics(store, a, 3, 1.0);
    setMetrics(store, b, 2, 1.5);
    setMetrics(store, c, 5, 0.5);

    const result = store.applyLessonMerge({
      scope: "ask",
      memberIds: [a, b, c],
      text: "be concise; keep it short; answer briefly",
      avoid: "rambling",
      now: NOW
    });
    expect(result).toBeDefined();
    const newId = result!.new_id;

    // The merged row is the ONLY active lesson in the scope.
    const active = store.getActiveLessons("ask");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(newId);
    expect(active[0]!.text).toBe("be concise; keep it short; answer briefly");
    expect(active[0]!.avoid).toBe("rambling");
    expect(active[0]!.source).toBe("consolidation");
    // applied_count is the SUM of members; rating_history starts fresh.
    expect(active[0]!.applied_count).toBe(10);
    expect(active[0]!.rating_history).toBe("[]");

    // Every member is superseded + inactive, pointing at the new row — original text intact.
    for (const [id, text] of [[a, "be concise"], [b, "keep it short"], [c, "answer briefly"]] as const) {
      const row = store.getLesson(id)!;
      expect(row.status).toBe("superseded");
      expect(row.superseded_by).toBe(newId);
      expect(row.text).toBe(text); // reversible: original body still readable
    }
  });

  it("caps and negative-clamps the merged reuse_value (a negative member can't drag below 0)", () => {
    const store = openStore();
    const a = store.addLesson({ scope: "ask", text: "x1", source: "user_feedback", created_at: NOW });
    const b = store.addLesson({ scope: "ask", text: "x2", source: "user_feedback", created_at: NOW });
    setMetrics(store, a, 0, 0.4);
    setMetrics(store, b, 0, -3.0); // a negative member is CLAMPED to 0, not subtracted

    const result = store.applyLessonMerge({ scope: "ask", memberIds: [a, b], text: "x1; x2", avoid: null, now: NOW });
    // Σ max(0, reuse) = 0.4 + 0 = 0.4 — the negative can't drag it below 0.
    expect(store.getLesson(result!.new_id)!.reuse_value).toBeCloseTo(0.4);
  });

  it("caps a huge summed reuse_value at LESSON_MERGE_REUSE_CAP", () => {
    const store = openStore();
    const a = store.addLesson({ scope: "ask", text: "x1", source: "user_feedback", created_at: NOW });
    const b = store.addLesson({ scope: "ask", text: "x2", source: "user_feedback", created_at: NOW });
    const c = store.addLesson({ scope: "ask", text: "x3", source: "user_feedback", created_at: NOW });
    setMetrics(store, a, 0, 4);
    setMetrics(store, b, 0, 4);
    setMetrics(store, c, 0, 4); // Σ = 12, capped at 5

    const result = store.applyLessonMerge({ scope: "ask", memberIds: [a, b, c], text: "x1; x2; x3", avoid: null, now: NOW });
    expect(store.getLesson(result!.new_id)!.reuse_value).toBe(LESSON_MERGE_REUSE_CAP);
  });

  it("refuses (returns undefined, writes nothing) when a member is not an active lesson in the scope", () => {
    const store = openStore();
    const a = store.addLesson({ scope: "ask", text: "x1", source: "user_feedback", created_at: NOW });
    const foreign = store.addLesson({ scope: "research", text: "y1", source: "user_feedback", created_at: NOW });

    // Cross-scope member → refuse.
    expect(store.applyLessonMerge({ scope: "ask", memberIds: [a, foreign], text: "merged", avoid: null, now: NOW }))
      .toBeUndefined();
    // Nothing changed: both members still active, no new row.
    expect(store.getLesson(a)!.status).toBe("active");
    expect(store.getLesson(foreign)!.status).toBe("active");
    expect(store.getActiveLessons("ask")).toHaveLength(1);

    // A superseded member → refuse.
    const b = store.addLesson({ scope: "ask", text: "x2", source: "user_feedback", created_at: NOW });
    store.forgetLesson(b); // now 'pruned', not active
    expect(store.applyLessonMerge({ scope: "ask", memberIds: [a, b], text: "merged", avoid: null, now: NOW }))
      .toBeUndefined();

    // A singleton → refuse.
    expect(store.applyLessonMerge({ scope: "ask", memberIds: [a], text: "merged", avoid: null, now: NOW }))
      .toBeUndefined();
  });
});

describe("lesson consolidate markers + ledger", () => {
  it("END-stamps the last-run marker (NULL until stamped)", () => {
    const store = openStore();
    expect(store.getLessonConsolidateLastRun()).toBeNull();
    store.markLessonConsolidateRan(NOW);
    expect(store.getLessonConsolidateLastRun()).toBe(NOW);
  });

  it("records a lesson_consolidate_tick event with the id-only merges payload", () => {
    const store = openStore();
    store.recordLessonConsolidateTick({
      scopes_processed: 1,
      clusters_merged: 1,
      lessons_superseded: 3,
      merges: [{ new_id: 99, superseded_ids: [1, 2, 3] }]
    });
    const events = store.getLedgerEvents().filter((e) => e.event_type === "lesson_consolidate_tick");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.merges).toEqual([{ new_id: 99, superseded_ids: [1, 2, 3] }]);
    expect(events[0]!.payload.lessons_superseded).toBe(3);
  });

  it("rejects a lesson_consolidate_tick event missing a required payload field", () => {
    const store = openStore();
    expect(() =>
      // @ts-expect-error — deliberately omit `merges` to prove the exhaustiveness gate bites.
      store.recordLessonConsolidateTick({ scopes_processed: 1, clusters_merged: 1, lessons_superseded: 3 })
    ).toThrow(/merges/);
  });
});
