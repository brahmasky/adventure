import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TREE_ACTIONS, TREE_BREADTH, TREE_CATEGORY, TREE_REASONING } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { ARM, cat, kind, REPORTED, scriptedLlm, treeSays, triageHarness } from "../helpers/triage-harness.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Spec Rev 3 §3 test 1 and §13 test 2 through the real front door: category memory takes the lane whatever sets_rule
// says, the lane's own memory_kind call decides, memory.kind records which rung decided, a saved fact is announced as 事实.
afterEach(() => { vi.unstubAllEnvs(); });
const OPINION = "I think the south side noodle shop is better than the north one";
const FACT = JSON.stringify({ kind: "fact", fact: "Paco prefers the south side noodle shop", evidence: { line: 1, quote: "south side noodle shop is better" } });
function run(says: Parameters<typeof treeSays>[0], distill = FACT) {
  const seen: string[] = [];
  const fetch = treeSays(says);
  const h = triageHarness(fetch, { llm: scriptedLlm({ distill: async (i) => { seen.push(String(i.question)); return { ok: true, output: { answer: distill } }; } }) });
  const earlier = createQueuedTurnRun(h.store, OPINION); // a telegram run: only Paco's telegram turns are sources
  h.store.recordChatTurn({ chat_id: "555", run_id: earlier, role: "user", text: OPINION, created_at: new Date(Date.now() - 60_000).toISOString() });
  const t = h.turn("记下来吧");
  return { h, t, seen, fetch };
}
const kindRow = (h: ReturnType<typeof triageHarness>, run_id: string) => h.store.listDecisionsForRun(run_id).find((d) => d.entry_id === "memory.kind");

describe("memory lane: its own memory_kind call decides", () => {
  it("the incident: memory 0.97, no rule, memory_kind fact 0.95 → a fact saved on the lane, card says 事实, Jev decided, two Jev calls", async () => {
    const { h, t, seen, fetch } = run({ category: cat({ memory: 0.97 }), sets_rule: 0.05, memory_kind: kind({ fact: 0.95 }) });
    const out = await h.worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "lane_reply" });
    expect((out as { text: string }).text).toContain("事实");
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ lane: "memory", reason: "routed", save_outcome: "saved", handler_outcome: "lane_reply" });
    expect(kindRow(h, t.run_id)).toMatchObject({ rung: "system_one", verdict: "fact", reason_code: "jev_kind" });
    expect(seen[0]).toContain("\nKIND: fact\n");
    expect(fetch).toHaveBeenCalledTimes(2); // the tree request, then memory_kind's own
    expect(h.store.listJevDecisions(t.run_id).map((r) => r.question_id)).toHaveLength(6); // memory_kind writes no raw row (D14)
    h.store.close();
  });
  it("fix → handed to the planner (reason fix), nothing saved, no distill call; memory.kind records fix", async () => {
    const { h, t, seen } = run({ category: cat({ memory: 0.95 }), sets_rule: 0.5, memory_kind: kind({ fix: 0.9 }) });
    expect(await h.worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ lane: "planner", reason: "fix", save_outcome: "none", route_outcome: "act" });
    expect(kindRow(h, t.run_id)).toMatchObject({ rung: "system_one", verdict: "fix" });
    expect(seen).toEqual([]);
    h.store.close();
  });
  it("Jev below its bar → the distill decides on the lane", async () => {
    const { h, t, seen } = run({ category: cat({ memory: 0.95 }), sets_rule: 0.05, memory_kind: kind({ fact: 0.6 }) });
    await h.worker.triageTurn(t.input);
    expect(seen[0]).not.toContain("KIND:");
    expect(kindRow(h, t.run_id)).toMatchObject({ rung: "model", verdict: "fact" });
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ lane: "memory", save_outcome: "saved" });
    h.store.close();
  });
  it("the memory_kind call fails (no answer for it) → the distill decides, and the row names the Jev rung's failure", async () => {
    const { h, t } = run({ category: cat({ memory: 0.95 }), sets_rule: 0.05 }); // the fake answers only the six tree questions
    await h.worker.triageTurn(t.input);
    expect(kindRow(h, t.run_id)).toMatchObject({ rung: "model", verdict: "fact", fallback_rung: "system_one", fallback_reason: "parse" });
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ save_outcome: "saved" });
    h.store.close();
  });
  it("rule rows unarmed: the memory lane still runs and its memory_kind call is made (Rev 2.1 item 1)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "hmw-cal-")), "rows.json");
    writeFileSync(file, JSON.stringify(["zh", "en"].flatMap((lang) => [TREE_CATEGORY, TREE_BREADTH, TREE_REASONING, TREE_ACTIONS].map((q) =>
      ({ question_id: q.id, criteria_hash: criteriaHash(q), model: REPORTED, lang, approved: "test", evidence: "test" })))));
    const fetch = treeSays({ category: cat({ memory: 0.95 }), sets_rule: 0.05, memory_kind: kind({ fact: 0.95 }) });
    const h = triageHarness(fetch, { env: { ...ARM, HOUGE_JEV_CALIBRATION_FILE: file }, llm: scriptedLlm({ distill: async () => ({ ok: true, output: { answer: FACT } }) }) });
    const earlier = createQueuedTurnRun(h.store, OPINION);
    h.store.recordChatTurn({ chat_id: "555", run_id: earlier, role: "user", text: OPINION, created_at: new Date(Date.now() - 60_000).toISOString() });
    const t = h.turn("记下来吧");
    await h.worker.triageTurn(t.input);
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ lane: "memory", rule_scope: "ask", save_outcome: "saved" });
    expect(fetch).toHaveBeenCalledTimes(2); // the tree request and memory_kind's own
    expect(kindRow(h, t.run_id)).toMatchObject({ rung: "system_one", verdict: "fact" });
    h.store.close();
  });
  it("a fact with no evidence falls through to the planner, save_outcome not_durable (Paco still gets an answer)", async () => {
    const { h, t } = run({ category: cat({ memory: 0.95 }), memory_kind: kind({ fact: 0.95 }) }, JSON.stringify({ kind: "fact", fact: "Paco likes noodles" }));
    expect(await h.worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ lane: "memory", save_outcome: "not_durable", handler_outcome: "fallthrough:not_durable" });
    h.store.close();
  });
  it("save-first on another route: Jev's `other` abstains, so sets_rule's save still runs and the distill decides", async () => {
    const { h, t, seen } = run({ category: cat({ research: 0.9 }), sets_rule: 0.95, memory_kind: kind({ other: 0.95 }) },
      JSON.stringify({ kind: "rule", lesson: "Cite primary sources" }));
    await h.worker.triageTurn(t.input);
    expect(seen[0]).not.toContain("KIND:");
    expect(kindRow(h, t.run_id)).toMatchObject({ rung: "model", verdict: "rule" });
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ save_outcome: "saved" });
    h.store.close();
  });
});
