import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunStore } from "../../src/run/run-store.js";
import { cat, HEAVY, jevDown, picks, scriptedLlm, SHADOW, treeSays, triageHarness, webOk, type Says } from "../helpers/triage-harness.js";

// ADR 0030 / spec §5.3: every turn.handler decision is one `decisions` row, and each jev_verdicts row and each jev_decisions
// row of the turn links to it — the outcome trail a digest tap or a later correction follows. Plan ruling 14 (codex B1):
// the row is written with the verdict, so a lost turn writes none and a rolled-back save takes its row with it. turn.gear
// records the role the route carries and must equal it on every path (the planner pins route.role in stage 1). A broken
// ledger must not change what Paco gets.
const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };
const handlerRow = (store: RunStore, run_id: string) => store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "turn.handler");
const gearRow = (store: RunStore, run_id: string) => store.listDecisionsForRun(run_id).find((d) => d.entry_id === "turn.gear");

function expectLinked(store: RunStore, run_id: string): string {
  const rows = handlerRow(store, run_id);
  expect(rows).toHaveLength(1);
  const id = rows[0]!.decision_id;
  expect(store.getJevVerdictForRun(run_id)?.decision_id).toBe(id);
  const jd = store.listJevDecisions(run_id);
  expect(jd.length).toBeGreaterThan(0);
  expect(jd.every((r) => r.ladder_decision_id === id)).toBe(true);
  return id;
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("turn.handler decisions link to what triage persisted", () => {
  it("a routed planner turn: rung system_one, p = the category's top probability, reason routed; verdict and six rows linked", async () => {
    const h = triageHarness(treeSays({ category: cat({ research: 0.9 }), breadth: HEAVY, reasoning: HEAVY, actions: HEAVY }));
    const t = h.turn("帮我比较三款 NAS");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "system_one", verdict: "planner", p: 0.9, reason_code: "routed", armed_mode: "on", stage: "pre_model" });
    expect(gearRow(h.store, t.run_id)).toMatchObject({ rung: "system_one", verdict: "thinking" });
    expect(h.store.getJevVerdictForRun(t.run_id)?.role).toBe("thinking");
    h.store.close();
  });
  it("the ack rule: rung rule, reason ack_rule; the skipped row and the verdict linked; gear fast by rule", async () => {
    const h = triageHarness(treeSays());
    h.store.recordChatTurn({ chat_id: "555", run_id: "run_seed_ack", role: "assistant", text: "明天悉尼晴，最高 22 度。", intent: "loop" });
    const t = h.turn("谢谢");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "rule", reason_code: "ack_rule", verdict: "planner" });
    expect(gearRow(h.store, t.run_id)).toMatchObject({ rung: "rule", verdict: "fast", reason_code: "gear_not_applied" });
    h.store.close();
  });
  it("a Jev outage: rung fail, fallback_reason outage on the system_one rung, reason transport", async () => {
    const h = triageHarness(jevDown());
    const t = h.turn("以后回复短一点");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "fail", fallback_reason: "outage", fallback_rung: "system_one", reason_code: "transport" });
    h.store.close();
  });
  it("a cascade pick: rung model, reason cascade", async () => {
    const h = triageHarness(treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }), { llm: scriptedLlm({ cascade: picks("lookup") }) });
    const t = h.turn("这个周末去哪玩");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "model", reason_code: "cascade", verdict: "planner" });
    h.store.close();
  });
  it("a cascade with no pick: rung fail, reason cascade_failed, the model rung's outage (not a Jev skip)", async () => {
    const h = triageHarness(treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }));
    const t = h.turn("这个周末去哪玩");
    await h.worker.triageTurn(t.input);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "fail", reason_code: "cascade_failed", fallback_reason: "outage", fallback_rung: "model" });
    h.store.close();
  });
  it("configured shadow: armed_mode shadow, rung fail, the Jev rows say shadow", async () => {
    const h = triageHarness(treeSays(RULE), { env: SHADOW });
    const t = h.turn("以后回复短一点");
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "fail", armed_mode: "shadow", fallback_reason: null });
    expect(h.store.listJevDecisions(t.run_id).every((r) => r.decision === "shadow")).toBe(true);
    h.store.close();
  });
  it("a memory lane save links inside the save's transaction too", async () => {
    const h = triageHarness(treeSays(RULE));
    const t = h.turn("从现在起，回复请控制在三句话以内。");
    expect((await h.worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expectLinked(h.store, t.run_id);
    h.store.close();
  });
});

describe("a lost turn writes no decisions row (ruling 14, codex B1)", () => {
  it("killed while Jev answers: no decisions row, no verdict, no Jev row", async () => {
    const ctl = new AbortController();
    const says = treeSays(RULE);
    const h = triageHarness(vi.fn(async (u: unknown, i: unknown) => { ctl.abort(); return says(u, i); }));
    const t = h.turn("从现在起，回复请控制在三句话以内。", { signal: ctl.signal });
    await h.worker.triageTurn(t.input);
    expect([h.store.listDecisionsForRun(t.run_id), h.store.getJevVerdictForRun(t.run_id), h.store.listJevDecisions(t.run_id)]).toEqual([[], undefined, []]);
    h.store.close();
  });
  it("killed while the cascade answers: no decisions row, no verdict", async () => {
    const ctl = new AbortController();
    const cascade = async () => { ctl.abort(); return { ok: true as const, output: { answer: "lookup" } }; };
    const h = triageHarness(treeSays({ category: cat({ answer: 0.45, lookup: 0.4 }) }), { llm: scriptedLlm({ cascade }) });
    const t = h.turn("这个周末去哪玩", { signal: ctl.signal });
    await h.worker.triageTurn(t.input);
    expect([h.store.listDecisionsForRun(t.run_id), h.store.getJevVerdictForRun(t.run_id)]).toEqual([[], undefined]);
    h.store.close();
  });
  it("a lane save that rolls back takes its row with it; the fallback settle writes exactly one of each, linked", async () => {
    const h = triageHarness(treeSays(RULE));
    const t = h.turn("从现在起，回复请控制在三句话以内。");
    h.worker.breakLaneFinalizeOnceForTest();
    await h.worker.triageTurn(t.input);
    expectLinked(h.store, t.run_id);
    // ruling D5: the gear is armed and the tree decided, so its row is recorded once — not zero (lost), not two (rewritten)
    expect(h.store.listDecisionsForRun(t.run_id).filter((d) => d.entry_id === "turn.gear")).toHaveLength(1);
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ route_outcome: "fallback" });
    h.store.close();
  });
});

describe("turn.gear equals the role on the verdict row (the route's role) on every path", () => {
  const cases: Array<[string, Says | "down", string]> = [
    ["research heavy", { category: cat({ research: 0.9 }), breadth: HEAVY, reasoning: HEAVY, actions: HEAVY }, "帮我比较三款 NAS"],
    ["other light", { category: cat({ other: 0.9 }) }, "帮我整理一下这周的待办"],
    ["answer lane", { category: cat({ answer: 0.9 }) }, "你觉得 NAS 放在客厅还是书房更好？"],
    ["think harder", { category: cat({ answer: 0.9 }) }, "认真想：你觉得呢？"],
    ["outage + think harder", "down", "认真想：这个怎么办"]
  ];
  for (const [name, says, text] of cases) {
    it(name, async () => {
      const h = triageHarness(says === "down" ? jevDown() : treeSays(says), { web: webOk() });
      const t = h.turn(text);
      await h.worker.triageTurn(t.input);
      const role = h.store.getJevVerdictForRun(t.run_id)!.role;
      expect(gearRow(h.store, t.run_id)?.verdict ?? "default").toBe(role); // no row = the default verdict "default"
      h.store.close();
    });
  }

  // Ruling 6: turn.gear's own rung bound is 1 s, but its answer derives from the shared tree call, so a slow (1.0–1.5 s)
  // yet successful Jev answer must still record the tree's role with no fallback, never a gear timeout of its own.
  it("a slow but successful shared Jev call (1.2 s): the gear still records the tree's role, no fallback", async () => {
    const says = treeSays({ category: cat({ research: 0.9 }), breadth: HEAVY, reasoning: HEAVY, actions: HEAVY });
    const h = triageHarness(vi.fn(async (u: unknown, i: unknown) => { await new Promise((r) => setTimeout(r, 1_200)); return says(u, i); }));
    const t = h.turn("帮我比较三款 NAS");
    await h.worker.triageTurn(t.input);
    expect(handlerRow(h.store, t.run_id)[0]).toMatchObject({ rung: "system_one", reason_code: "routed", fallback_reason: null });
    expect(gearRow(h.store, t.run_id)).toMatchObject({ rung: "system_one", verdict: "thinking", fallback_reason: null, fallback_rung: null });
    expect(h.store.getJevVerdictForRun(t.run_id)?.role).toBe("thinking");
    h.store.close();
  }, 10_000);
});

describe("recording never changes a decision (spec §4.1)", () => {
  it("a failing decisions write: the same route and verdict row, decision_id null, decision_record_failed open", async () => {
    const h = triageHarness(treeSays({ category: cat({ research: 0.9 }) }));
    vi.spyOn(h.store, "insertDecision").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    const t = h.turn("帮我比较三款 NAS");
    const out = await h.worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "fallthrough", route: { role: "thinking" } });
    expect(h.store.getJevVerdictForRun(t.run_id)).toMatchObject({ lane: "planner", role: "thinking", decision_id: null });
    expect(h.store.listOpenIncidents().map((i) => i.kind)).toContain("decision_record_failed");
    h.store.close();
  });
});
