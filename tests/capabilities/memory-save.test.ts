import { describe, expect, it } from "vitest";
import { saveMemoryPlan } from "../../src/capabilities/memory-save.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Spec 2b-ii §5.3 (ruling 8): an accepted lesson or fact is written exactly as a lane save writes it — the lesson row with
// source improve and its lesson_changes Undo row, the fact row with its memory_changes add row — under the origin run, so
// Undo, recordSaveUndone and the digest's Undo button work unchanged. The cap answers with LESSON_CAPPED_HINT.
const NOW = "2026-10-21T10:00:00.000Z";
describe("saveMemoryPlan", () => {
  it("saves a lesson with source improve and an Undo change; a fact with an add change and a fact_saved event", () => {
    const s = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(s, "x");
    const r = saveMemoryPlan(s, { lesson: { scope: "ask", text: "Answer in one line.", avoid: "long stories" }, fact: { text: "Paco's sister lives in Lima.", evidence: { line: 1, quote: "sister lives in lima" }, source_turn_ids: [] } },
      { run_id, chat_id: "555", source: "improve", now: NOW });
    expect(r.lesson).toMatchObject({ id: expect.any(Number), change_id: expect.stringMatching(/^lc_/) });
    expect(r.fact).toMatchObject({ id: expect.any(Number), change_id: expect.stringMatching(/^mc_/) });
    expect(s.getLesson((r.lesson as { id: number }).id)).toMatchObject({ scope: "ask", text: "Answer in one line.", avoid: "long stories", source: "improve", status: "active" });
    expect(s.getLessonChange((r.lesson as { change_id: string }).change_id)).toMatchObject({ run_id, chat_id: "555" });
    expect(s.getMemoryChange((r.fact as { change_id: string }).change_id)).toMatchObject({ kind: "fact", action: "add", run_id, chat_id: "555" });
    expect(s.getLedgerEvents(run_id).map((e) => e.event_type)).toEqual(expect.arrayContaining(["lesson_saved", "fact_saved"]));
  });
  it("a lesson over the cap is not saved: capped", () => {
    const s = RunStore.openInMemory();
    const r = saveMemoryPlan(s, { lesson: { scope: "ask", text: "x".repeat(300) } }, { run_id: createQueuedTurnRun(s, "x"), chat_id: "555", source: "improve", now: NOW });
    expect(r.lesson).toEqual({ capped: true });
  });
});
