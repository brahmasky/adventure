import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { acceptJevModel, acceptJevModelCli, formatJevModels, requestJevCheck } from "../../src/decisions/jev-version-controls.js";
import { RunStore, type JevAnchorRow } from "../../src/run/run-store.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";

// Jev version check spec §2.6: Paco's CLI controls. Requests always name the alias, so a check can only test the model
// the alias serves now: asking to check another one must refuse with a message, never queue a check that cannot run.
const NOW = "2026-10-22T05:00:00.000Z";

function withAttempts(models: string[]): RunStore {
  const path = join(mkdtempSync(join(tmpdir(), "hjvc-")), "h.sqlite");
  RunStore.open(path).close();
  const db = new DatabaseSync(path);
  models.forEach((model, k) => db.prepare(`INSERT INTO ledger_events (event_id, run_id, correlation_id, event_type, occurred_at, actor, sequence, payload_json)
    VALUES (?, NULL, 'c', 'llm_attempt', ?, 'capability_runner', 1, ?)`).run(`e${k}`, NOW, JSON.stringify({ provider: "jev", model, outcome: "ok" })));
  db.close();
  return RunStore.open(path);
}

describe("houge jev check [model]", () => {
  it("refuses a model the alias does not serve now, naming the one it does", () => {
    const s = withAttempts(["jev-a", "jev-b"]);
    s.noteJevModel("jev-a", NOW);
    const r = requestJevCheck(s, "jev-a", NOW);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("jev-b");
    expect(r.message).toContain(`as of ${NOW}`); // the served model is the newest ledger row: say how old
    expect(s.getJevModel("jev-a")?.state).toBe("checking"); // untouched
    s.close();
  });

  it("with no model: queues the served model; a terminal state moves back to checking with its detail cleared", () => {
    const s = withAttempts(["jev-b"]);
    s.noteJevModel("jev-b", NOW);
    s.setJevModelState("jev-b", "checking", "drifted", JSON.stringify({ failed_questions: ["category"], route_failed: false, lanes_disarmed: [] }), NOW);
    const r = requestJevCheck(s, undefined, NOW);
    expect(r).toMatchObject({ ok: true });
    expect(s.getJevModel("jev-b")).toMatchObject({ state: "checking", detail_json: "{}" });
    s.close();
  });

  it("refuses when no Jev answer was ever recorded", () => {
    const s = withAttempts([]);
    expect(requestJevCheck(s, undefined, NOW).ok).toBe(false);
    s.close();
  });
});

describe("houge jev accept <model> and houge jev models", () => {
  it("accepts a drifted model and lists every model with its state", () => {
    const s = withAttempts([]);
    s.noteJevModel("jev-b", NOW);
    s.setJevModelState("jev-b", "checking", "drifted", JSON.stringify({ failed_questions: [], route_failed: true, lanes_disarmed: [], margins: { route: { a: null, b: -0.1 } } }), NOW);
    expect(formatJevModels(s)).toMatch(/jev-b\s+drifted/);
    expect(formatJevModels(s)).toMatch(/n\/a/); // a null margin renders as n/a
    expect(acceptJevModelCli(s, "jev-b", NOW).ok).toBe(true);
    expect(s.getJevModel("jev-b")?.state).toBe("accepted");
    expect(acceptJevModelCli(s, "jev-unknown", NOW).ok).toBe(false);
    s.close();
  });
});

// Final fix C (adversarial 1, controller ruling): Paco's Accept on a drifted or insufficient model makes it the reference
// the next version is compared with. Without it every later id drifts against October 2026 and Accept becomes a weekly
// rubber stamp. His labels stay the absolute anchor; a model that passed its own check never re-anchors (no silent ratchet).
describe("Accept re-anchors (final fix C)", () => {
  const ANCHOR = "jev-anchor"; const CAND = "jev-cand";
  const TURNS = ["t1", "t2", "t3"];
  function seeded(): RunStore {
    const s = withAttempts([]);
    const rows: JevAnchorRow[] = TURNS.flatMap((turn_id) => (["A", "B"] as const).flatMap((run) =>
      Object.entries(treeAnswers({ category: "research" })).map(([question_id, a]) => ({ turn_id, lang: "zh", question_id, criteria_hash: `c-${question_id}-${run}`, run, answer_json: JSON.stringify(a), model: ANCHOR }))));
    s.importAnchor({ rows, states: TURNS.map((turn_id) => ({ turn_id, lang: "zh", state_json: "{}", state_hash: "h" })),
      labels: [{ turn_id: "t1", category: "memory", by: "paco", at: NOW }], meta: { baseline: "{}" }, trustedModel: ANCHOR, now: NOW });
    s.noteJevModel(CAND, NOW);
    const g = s.bumpJevModelGeneration(CAND);
    for (const turn of ["t1", "t2"]) for (const run of ["A", "A2", "B"]) {
      s.recordJevCheckRun({ model: CAND, generation: g, entry_id: "tree", run: `${run}:${turn}`, outcome: "answered", created_at: NOW, detail_json: JSON.stringify(treeAnswers({ category: run === "B" ? "lookup" : "memory" })) });
    }
    s.recordJevCheckRun({ model: CAND, generation: g, entry_id: "tree", run: "A:t3", outcome: "failed", created_at: NOW, detail_json: "{}" }); // t3: not answered
    s.setJevModelState(CAND, "checking", "drifted", JSON.stringify({ failed_questions: ["category"], route_failed: false, lanes_disarmed: [], card_chat: "555", generation: g }), NOW);
    return s;
  }
  const answer = (s: RunStore, run: "A" | "B", turn: string) => s.anchorAnswers(run).find((r) => r.turn_id === turn && r.question_id === "category")!;

  it("Accept on a drifted model puts its current-generation run A and B answers in place of the anchor's (same turns, hashes kept), labels untouched", () => {
    const s = seeded();
    const r = acceptJevModelCli(s, CAND, NOW);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/2 anchor turns now hold its answers/);
    expect(s.getJevModel(CAND)?.state).toBe("accepted");
    expect(JSON.parse(answer(s, "A", "t1").answer_json).choice).toBe("memory");
    expect(answer(s, "A", "t1")).toMatchObject({ model: CAND, criteria_hash: "c-category-A" });
    expect(JSON.parse(answer(s, "B", "t2").answer_json).choice).toBe("lookup");
    expect(answer(s, "B", "t2").model).toBe(CAND);
    expect(answer(s, "A", "t3")).toMatchObject({ model: ANCHOR }); // the candidate did not answer t3: its anchor rows stay
    expect(JSON.parse(answer(s, "A", "t3").answer_json).choice).toBe("research");
    expect(s.listAnchorTurns()).toEqual(TURNS);
    expect(s.anchorLabels()).toEqual([{ turn_id: "t1", category: "memory", by: "paco", at: NOW }]);
    expect(JSON.parse(s.getAnchorMeta("anchor_model")!)).toMatchObject({ model: CAND, via: "cli" });
    s.close();
  });

  it("the tap path (insufficient → accepted) re-anchors too", () => {
    const s = seeded();
    const row = s.getJevModel(CAND)!;
    s.setJevModelState(CAND, "drifted", "insufficient", row.detail_json!, NOW);
    expect(acceptJevModel(s, s.getJevModel(CAND)!, ["drifted", "insufficient"], "tap", NOW)).toBe(true);
    expect(answer(s, "A", "t1").model).toBe(CAND);
    expect(JSON.parse(s.getAnchorMeta("anchor_model")!)).toMatchObject({ model: CAND, via: "tap" });
    s.close();
  });

  it("a fenced Accept (the state moved meanwhile) writes nothing to the anchor", () => {
    const s = seeded();
    const stale = s.getJevModel(CAND)!;
    s.setJevModelState(CAND, "drifted", "checking", "{}", NOW);
    expect(acceptJevModel(s, stale, ["drifted"], "tap", NOW)).toBe(false);
    expect(answer(s, "A", "t1").model).toBe(ANCHOR);
    expect(s.getAnchorMeta("anchor_model")).toBeUndefined();
    s.close();
  });

  it("a trusted model never re-anchors, and Accept from checking (CLI) arms without re-anchoring", () => {
    const s = seeded();
    s.setJevModelState(CAND, "drifted", "trusted", "{}", NOW);
    expect(acceptJevModelCli(s, CAND, NOW).message).toMatch(/already trusted/);
    s.setJevModelState(CAND, "trusted", "checking", "{}", NOW);
    expect(acceptJevModelCli(s, CAND, NOW).ok).toBe(true);
    expect(s.getJevModel(CAND)?.state).toBe("accepted");
    expect(answer(s, "A", "t1").model).toBe(ANCHOR);
    expect(s.getAnchorMeta("anchor_model")).toBeUndefined();
    s.close();
  });
});
