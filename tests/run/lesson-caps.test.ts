import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LESSON_AVOID_MAX_CHARS, LESSON_MAX_CHARS } from "../../src/capabilities/distill.js";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-10-02T00:00:00.000Z";
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); delete process.env.HOUGE_LESSON_CAP_PER_SCOPE; });
afterEach(() => { store.close(); });
const ledger = (type: string) => store.getLedgerEvents().filter((e) => e.event_type === type).map((e) => e.payload);

describe("size caps on every lesson write (spec §2)", () => {
  it("the caps are 240 for text and 120 for avoid", () => {
    expect(LESSON_MAX_CHARS).toBe(240);
    expect(LESSON_AVOID_MAX_CHARS).toBe(120);
  });

  // Paco's instruction must never be lost to a merge that grew too long (2026-10-06, ADR 0005 amendment): the merge is
  // dropped, the new rule is saved on its own, and the old lesson keeps everything it said. A near-duplicate is the
  // accepted cost; a silently unsaved instruction is not.
  it("an UPDATE whose merged text is over 240 saves the new rule as its own lesson; the prior one stays untouched", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", theme: "format", source: "loop", created_at: NOW });
    const merged = "m".repeat(LESSON_MAX_CHARS + 1);
    const r = store.saveReconciledLesson({ scope: "ask", text: "short answers", theme: "format" }, { verdict: "UPDATE", id: target, text: merged }, "user_feedback", NOW);
    expect(r).toMatchObject({ verb: "add", lesson: "short answers" });
    expect(store.getLesson(r.id!)).toMatchObject({ status: "active", text: "short answers", theme: "format", supersedes: null });
    expect(store.getLesson(target)).toMatchObject({ status: "active", text: "be concise", superseded_by: null });
    expect(ledger("lesson_update_overflow")).toEqual([{ candidate: r.id, target, merged_chars: LESSON_MAX_CHARS + 1 }]);
    expect(ledger("lesson_write_capped")).toEqual([]);
  });

  it("an unthemed candidate saved this way takes the target's theme (it overlaps that rule)", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", theme: "format", source: "loop", created_at: NOW });
    const r = store.saveReconciledLesson({ scope: "ask", text: "short answers" }, { verdict: "UPDATE", id: target, text: "m".repeat(LESSON_MAX_CHARS + 1) }, "loop", NOW);
    expect(store.getLesson(r.id!)).toMatchObject({ theme: "format" });
  });

  it("an unthemed target keeps nothing it does not have: the candidate saved this way keeps its own theme", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", source: "migration", created_at: NOW });
    const r = store.saveReconciledLesson({ scope: "ask", text: "short answers", theme: "format" }, { verdict: "UPDATE", id: target, text: "m".repeat(LESSON_MAX_CHARS + 1) }, "loop", NOW);
    expect(store.getLesson(r.id!)).toMatchObject({ theme: "format", scope: "ask" });
  });

  it("the scope cap never prunes the target this fallback promised to keep, even when it ranks lowest", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", theme: "format", source: "loop", created_at: NOW });
    const other = store.addLesson({ scope: "ask", text: "cite sources", theme: "sources", source: "loop", created_at: NOW });
    store.applyRatingToLessons([other], 3, NOW); // the target now has the lowest reuse value
    const r = store.saveReconciledLesson({ scope: "ask", text: "short answers", theme: "format" }, { verdict: "UPDATE", id: target, text: "m".repeat(LESSON_MAX_CHARS + 1) }, "loop", NOW, 2);
    expect(r.prunedIds).toEqual([other]);
    expect(store.getLesson(target)!.status).toBe("active");
    expect(store.getLesson(r.id!)!.status).toBe("active");
  });

  it("a merge over cap only because of the inherited avoid saves the candidate without that avoid", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", avoid: "a".repeat(LESSON_AVOID_MAX_CHARS + 1), source: "migration", created_at: NOW });
    const r = store.saveReconciledLesson({ scope: "ask", text: "short answers" }, { verdict: "UPDATE", id: target, text: "be concise; short answers" }, "loop", NOW);
    expect(r.verb).toBe("add");
    expect(store.getLesson(r.id!)).toMatchObject({ text: "short answers", avoid: null });
    expect(store.getLesson(target)!.status).toBe("active");
  });

  it("a candidate that is itself over a cap is still refused and ledgered (nothing fits to save)", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", theme: "format", source: "loop", created_at: NOW });
    const long = "c".repeat(LESSON_MAX_CHARS + 1);
    const r = store.saveReconciledLesson({ scope: "ask", text: long, theme: "format" }, { verdict: "UPDATE", id: target, text: long }, "loop", NOW);
    expect(r).toMatchObject({ verb: "capped", cappedTargetId: target, prunedIds: [] });
    expect(store.listLessons()).toHaveLength(1);
    expect(ledger("lesson_write_capped")).toEqual([{ verdict: "UPDATE", target_id: target, chars: LESSON_MAX_CHARS + 1, avoid_chars: 0 }]);
    const a = store.saveReconciledLesson({ scope: "ask", text: "short", avoid: "a".repeat(LESSON_AVOID_MAX_CHARS + 1) }, { verdict: "UPDATE", id: target, text: "be concise, short" }, "loop", NOW);
    expect(a.verb).toBe("capped");
  });

  it("an UPDATE inherits reuse_value and applied_count, and a candidate with no theme takes the target's (not a cross-theme refusal)", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", theme: "format", source: "loop", created_at: NOW });
    store.touchApplied([target]); store.touchApplied([target]);
    store.applyRatingToLessons([target], 3, NOW); // reuse 1.25
    const r = store.saveReconciledLesson({ scope: "ask", text: "under 200 words" }, { verdict: "UPDATE", id: target, text: "be concise, under 200 words" }, "loop", NOW);
    expect(r.verb).toBe("update");
    expect(store.getLesson(r.id!)).toMatchObject({ reuse_value: 1.25, applied_count: 2, theme: "format" });
    expect(ledger("lesson_cross_theme")).toEqual([]);
  });

  it("a cross-theme UPDATE is not applied: the candidate is saved as an ADD under its own theme and ledgered", () => {
    const target = store.addLesson({ scope: "ask", text: "name the time zone", theme: "time", source: "loop", created_at: NOW });
    const r = store.saveReconciledLesson({ scope: "ask", text: "lead with the answer", theme: "format" }, { verdict: "UPDATE", id: target, text: "name the zone; lead with the answer" }, "loop", NOW);
    expect(r.verb).toBe("add");
    expect(store.getLesson(r.id!)).toMatchObject({ text: "lead with the answer", theme: "format", supersedes: null });
    expect(store.getLesson(target)).toMatchObject({ status: "active", superseded_by: null });
    expect(ledger("lesson_cross_theme")).toEqual([{ candidate: r.id, target }]);
  });
});

describe("ask and research are one rendered set: a merge may cross them (final-review B2/B3)", () => {
  it("an ask candidate that SUPERSEDEs a research lesson supersedes it in place: the new row takes the research scope", () => {
    const target = store.addLesson({ scope: "research", text: "cite two sources", theme: "sources", source: "loop", created_at: NOW });
    const r = store.saveReconciledLesson({ scope: "ask", text: "cite three sources", theme: "sources" }, { verdict: "SUPERSEDE", id: target }, "loop", NOW);
    expect(r).toMatchObject({ verb: "supersede", supersededId: target });
    expect(store.getLesson(target)).toMatchObject({ status: "superseded", superseded_by: r.id });
    expect(store.getLesson(r.id!)).toMatchObject({ scope: "research", text: "cite three sources" });
    expect(store.listLessons().map((l) => l.text)).toEqual(["cite three sources"]); // one active rule, not two
    expect(ledger("lesson_cross_scope")).toEqual([{ verdict: "SUPERSEDE", target_id: target }]);
  });

  it("a cross-scope UPDATE merges too; a scope outside the omp set still degrades to ADD", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", theme: "format", source: "loop", created_at: NOW });
    const r = store.saveReconciledLesson({ scope: "research", text: "short summaries" }, { verdict: "UPDATE", id: target, text: "be concise; short summaries" }, "loop", NOW);
    expect(store.getLesson(r.id!)).toMatchObject({ scope: "ask", text: "be concise; short summaries", supersedes: target });
    const other = store.addLesson({ scope: "code", text: "use tabs", source: "loop", created_at: NOW });
    const o = store.saveReconciledLesson({ scope: "ask", text: "use spaces" }, { verdict: "SUPERSEDE", id: other }, "loop", NOW);
    expect(o.verb).toBe("add");
    expect(store.getLesson(other)!.status).toBe("active");
  });

  it("a themed UPDATE onto an unthemed target is a merge, not a cross-theme refusal: the new row takes the candidate's theme", () => {
    const target = store.addLesson({ scope: "ask", text: "be concise", source: "migration", created_at: NOW });
    const r = store.saveReconciledLesson({ scope: "ask", text: "short answers", theme: "format" }, { verdict: "UPDATE", id: target, text: "be concise, short answers" }, "loop", NOW);
    expect(r.verb).toBe("update");
    expect(store.getLesson(r.id!)).toMatchObject({ theme: "format", supersedes: target });
    expect(store.getLesson(target)!.status).toBe("superseded");
    expect(ledger("lesson_cross_theme")).toEqual([]);
  });
});

describe("consolidation merges stay within one theme (spec §5)", () => {
  it("applyLessonMerge refuses members of different themes and keeps the theme on a same-theme merge", () => {
    const a = store.addLesson({ scope: "ask", text: "be brief", theme: "format", source: "loop" });
    const b = store.addLesson({ scope: "ask", text: "state the zone", theme: "time", source: "loop" });
    expect(store.applyLessonMerge({ scope: "ask", memberIds: [a, b], text: "be brief; state the zone", avoid: null })).toBeUndefined();
    const c = store.addLesson({ scope: "ask", text: "lead with the answer", theme: "format", source: "loop" });
    const merged = store.applyLessonMerge({ scope: "ask", memberIds: [a, c], text: "be brief, answer first", avoid: null });
    expect(store.getLesson(merged!.new_id)!.theme).toBe("format");
  });
});
