import { describe, expect, it, vi } from "vitest";
import { IMPROVE_GROUPS_PER_TICK, improveTickDue, runImproveTick, type ImproveTickDeps, type JobHooks } from "../../src/improve/tick.js";
import { SETTLE_REASON_VALUES } from "../../src/decisions/outcomes.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { SkillStore } from "../../src/skills/skill-store.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { createTelegramTurn } from "../helpers/runs.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spec 2b-ii §3.1, §3.5 (codex D3, round 2 N1): once per local date at the digest's time (also when the digest is off), the
// inbox is the only input; model calls outside transactions; one transaction per group (decision row, one outcome row per
// inbox row, proposal or queued job, consumed_at); deferred groups stay unconsumed; a crash resumes; a stop signal stops
// between model calls; improve_tick start/end events bracket every run.
const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney", HOUGE_DECISION_DIGEST_AT: "off" };
const NOW = "2026-10-21T11:00:00.000Z"; // 22:00 AEDT: past the 21:00 default even with the digest off
const EARLY = "2026-10-21T09:00:00.000Z"; // 20:00 AEDT
const jev = (probabilities: Record<string, number>) => async (req: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1,
  answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "choice" as const, choice: "x", probabilities, confidence: 0.5 }])) });
const llm = (answer: string) => vi.fn(async () => ({ ok: true as const, answer }));
const D = (o: Partial<DecisionInsert>): DecisionInsert => ({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model", rung: "system_one", verdict: "planner", p: 0.9,
  reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: "2026-10-21T01:00:00.000Z", ...o });
function deps(store: RunStore, o: Partial<ImproveTickDeps> = {}): ImproveTickDeps {
  const distill = llm('{"kind":"rule","lesson":"Answer in one line."}');
  return { store, env: ENV, now: NOW, signal: new AbortController().signal, chatId: "555", client: jev({ lesson: 0.8, nothing: 0.2 }),
    llm: { pick: llm("lesson"), distill, classify: llm("{}"), compose: llm(""), verify: llm("") }, embed: async () => Float32Array.from([1, 0]), embedModel: "m",
    skills: new SkillStore({ root: mkdtempSync(join(tmpdir(), "hg-skills-")) }), ...o };
}
/** A telegram turn the intake caps (3 queued runs, 5 commands a minute) do not count: close the run, clear the audit (tests only, raw SQL; precedent tests/improve/abandonment.test.ts). */
function turn(s: RunStore, text: string): { run_id: string; turn_id: string } {
  const t = createTelegramTurn(s, text);
  const db = (s as unknown as { db: { prepare(q: string): { run(...a: string[]): unknown } } }).db;
  db.prepare("UPDATE runs SET state = 'completed' WHERE run_id = ?").run(t.run_id);
  db.prepare("DELETE FROM telegram_command_audit").run();
  return t;
}
/** A corrected telegram turn with a verdict, and a correction row on it from a later run. */
function correction(store: RunStore, text = "please always answer in one line", category: "answer" | "lookup" = "answer"): { about: string; correcting: string } {
  const about = turn(store, "what is the capital of peru").run_id;
  store.insertJevVerdict({ run_id: about, category, breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "answer", role: "default", effort: null, cascade: null,
    save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null });
  const correcting = turn(store, text).run_id;   // Paco's words live on the CORRECTING turn
  store.insertImproveSignal({ signal: "correction", value: category, run_id: correcting, chat_id: "555", about_run_id: about, created_at: "2026-10-21T02:00:00.000Z" });
  return { about, correcting };
}
const events = (s: RunStore) => s.listLedgerEventsByTypeSince("improve_tick", "2026-01-01T00:00:00.000Z").map((e) => e.payload.phase);

describe("improveTickDue", () => {
  it("due once per local date at or after the digest time, also when the digest is off (21:00 then); not before; not twice", () => {
    const s = RunStore.openInMemory();
    expect(improveTickDue(s, ENV, EARLY)).toBeNull();
    expect(improveTickDue(s, ENV, NOW)).toBe("2026-10-21");
    expect(improveTickDue(s, { ...ENV, HOUGE_DECISION_DIGEST_AT: "20:00" }, EARLY)).toBe("2026-10-21");
    s.beginImproveTick("2026-10-21", NOW); s.finishImproveTick("2026-10-21", "done", {}, NOW);
    expect(improveTickDue(s, ENV, NOW)).toBeNull();
  });
});

describe("runImproveTick", () => {
  it("mirrors, groups, decides, and commits per group: a decision row with the group's newest run, one outcome row per inbox row, a proposal, consumed_at; events bracket it; the latch is done", async () => {
    const s = RunStore.openInMemory();
    const { about } = correction(s);
    const d = s.insertDecision(D({ run_id: about }));
    s.insertDecisionOutcome({ decision_id: d, signal: "review_bad", value: "turn.handler", source: "paco", created_at: "2026-10-21T03:00:00.000Z" }); // mirrored into its own group
    const r = await runImproveTick(deps(s));
    expect(r).toMatchObject({ ran: true, result: "done", counts: { mirrored: 1, groups: 2, decided: 2, proposals: 2, deferred: 0, stale: 0 } });
    const rows = s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").filter((x) => x.entry_id === "improve.route");
    expect(rows.map((x) => [x.verdict, x.rung, x.run_id])).toEqual([["lesson", "system_one", about], ["ladder", "rule", about]]);
    expect(s.listDecisionOutcomes(rows[0]!.decision_id).map((o) => `${o.signal}:${o.value}:${o.source}`)).toEqual(["correction:answer:code"]);
    expect(s.listOpenProposals().map((p) => [p.target, p.scope])).toEqual([["lesson", "answer"], ["ladder", "turn.handler"]]);
    expect(s.listUnconsumedSignals(10)).toEqual([]);
    expect(events(s)).toEqual(["start", "end"]);
    expect(s.getImproveTick("2026-10-21")).toMatchObject({ result: "done", detail: { groups: 2 } });
    expect(await runImproveTick(deps(s))).toEqual({ ran: false });
  });
  it("beyond 40 groups the rest stay unconsumed with no decision row and are counted deferred; the next day's tick takes them", async () => {
    const s = RunStore.openInMemory();
    // 42 distinct (signal, scope) groups: 20 settle_sent_back reasons + 20 settle_unverified reasons + 2 review_bad entry ids (scope = the value for all three)
    const pairs: Array<["settle_sent_back" | "settle_unverified" | "review_bad", string]> = [
      ...SETTLE_REASON_VALUES.map((v): ["settle_sent_back", string] => ["settle_sent_back", v]),
      ...SETTLE_REASON_VALUES.map((v): ["settle_unverified", string] => ["settle_unverified", v]),
      ["review_bad", "turn.handler"], ["review_bad", "turn.gear"]];
    expect(pairs).toHaveLength(IMPROVE_GROUPS_PER_TICK + 2);
    pairs.forEach(([signal, value], k) => s.insertImproveSignal({ signal, value, run_id: null, chat_id: "555", about_run_id: null, source_outcome_id: `do_${k}`, created_at: `2026-10-21T0${k % 10}:${String(k).padStart(2, "0")}:00.000Z` }));
    const r = await runImproveTick(deps(s));
    expect(r).toMatchObject({ ran: true, counts: { deferred: 2 } });
    expect(s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").filter((x) => x.entry_id === "improve.route")).toHaveLength(IMPROVE_GROUPS_PER_TICK);
    expect(s.listUnconsumedSignals(10)).toHaveLength(2);
    const next = await runImproveTick(deps(s, { now: "2026-10-22T11:00:00.000Z" }));
    expect(next).toMatchObject({ ran: true, counts: { groups: 2, deferred: 0 } });
    expect(s.listUnconsumedSignals(10)).toEqual([]);
  });
  it("a review_bad x3 group is decided ladder/review_bad by the rule rung (no Jev call) and yields an open ladder proposal with move retire_judge", async () => {
    const s = RunStore.openInMemory();
    const client = vi.fn(jev({ lesson: 0.9 }));
    for (const day of ["18", "19", "20"]) s.insertImproveSignal({ signal: "review_bad", value: "turn.settle", run_id: null, chat_id: "555", about_run_id: null, created_at: `2026-10-${day}T03:00:00.000Z` });
    expect(await runImproveTick(deps(s, { client }))).toMatchObject({ ran: true, counts: { groups: 1, decided: 1, proposals: 1 } });
    expect(client).not.toHaveBeenCalled();
    const row = s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").find((x) => x.entry_id === "improve.route");
    expect(row).toMatchObject({ verdict: "ladder", rung: "rule", reason_code: "review_bad" });
    const [p] = s.listOpenProposals();
    expect([p!.target, p!.scope, JSON.parse(p!.draft_json)]).toEqual(["ladder", "turn.settle", { entry_id: "turn.settle", move: "retire_judge" }]);
  });
  it("a stale row (30 days unconsumed) is consumed as nothing/stale by the rule rung with no Jev call", async () => {
    const s = RunStore.openInMemory();
    const client = vi.fn(jev({ lesson: 0.9 }));
    s.insertImproveSignal({ signal: "review_bad", value: "turn.handler", run_id: null, chat_id: "555", about_run_id: null, created_at: "2026-09-01T00:00:00.000Z" });
    const r = await runImproveTick(deps(s, { client }));
    expect(r).toMatchObject({ ran: true, counts: { stale: 1, decided: 1 } });
    expect(client).not.toHaveBeenCalled();
    const row = s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").find((x) => x.entry_id === "improve.route");
    expect(row).toMatchObject({ verdict: "nothing", rung: "rule", reason_code: "stale" });
  });
  it("a crash mid-tick resumes: the running latch is re-entered and only unconsumed rows are decided again", async () => {
    const s = RunStore.openInMemory();
    correction(s); correction(s, "find me the march invoice again", "lookup");   // two groups
    s.beginImproveTick("2026-10-21", NOW); // a previous attempt died after latching
    s.consumeSignals([1], NOW);           // and after committing the first group
    const r = await runImproveTick(deps(s));
    expect(r).toMatchObject({ ran: true, result: "done", counts: { groups: 1, decided: 1 } });   // a re-read of the consumed row would show as a second group
    expect(s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").filter((x) => x.entry_id === "improve.route")).toHaveLength(1);
    expect(s.listUnconsumedSignals(10)).toEqual([]);
  });
  it("the stop signal between groups ends the tick as stopped: the group whose calls finished commits, the rest wait; the stopped date resumes on the next cycle", async () => {
    const s = RunStore.openInMemory();
    correction(s); correction(s, "find me the march invoice again", "lookup");   // two groups: (correction, answer) and (correction, lookup)
    const ac = new AbortController();
    const client = vi.fn(async (req: JevRequest) => { ac.abort(); return jev({ lesson: 0.8 })(req); }); // the abort lands DURING the first group's call
    const r = await runImproveTick(deps(s, { signal: ac.signal, client }));
    expect(r).toMatchObject({ ran: true, result: "stopped", counts: { decided: 1 } });                  // ruling 17: a decided group always commits
    expect(s.getImproveTick("2026-10-21")?.result).toBe("stopped");
    expect(s.listUnconsumedSignals(10)).toHaveLength(1);
    expect(await runImproveTick(deps(s, { client: jev({ lesson: 0.8 }) }))).toMatchObject({ ran: true, result: "done", counts: { decided: 1 } });
    expect(s.getImproveTick("2026-10-21")?.result).toBe("done");
  });
  it("a per-cycle time budget ends the call stopped after the running group; the next cycle resumes", async () => {
    const s = RunStore.openInMemory();
    correction(s); correction(s, "find me the march invoice again", "lookup");
    let t = 0;
    const clock = () => (t += 5_000);   // every read of the clock is 5 s later: the first group fits a 10 s budget, the second does not (no real timing: flake-free)
    const r = await runImproveTick(deps(s, { budgetMs: 9_000, clock }));   // reads: 5 000 at start, 10 000 before group 1 (5 000 elapsed ≤ 9 000), 15 000 before group 2 (10 000 > 9 000 → stopped)
    expect(r).toMatchObject({ ran: true, result: "stopped", counts: { decided: 1 } });
    expect(await runImproveTick(deps(s))).toMatchObject({ ran: true, result: "done", counts: { decided: 1 } });
  });
  it("a second open proposal on one (target, scope) is not inserted: the row records nothing/already_proposed (ruling 6); a failed draft records nothing/no_text", async () => {
    const s = RunStore.openInMemory();
    correction(s); correction(s, "and once more shorter answers please");
    const r = await runImproveTick(deps(s));
    expect(r).toMatchObject({ ran: true, counts: { groups: 1, proposals: 1, already_proposed: 0 } }); // one group: same (correction, answer)
    correction(s, "a third time: one line only");                                                    // a real correcting run (not a decision id as about_run_id)
    // the five turns now embed alike (the stub vector is constant) and would form a recurrence cluster: no embedder, so this day decides only the correction group
    const next = await runImproveTick(deps(s, { now: "2026-10-22T11:00:00.000Z", embed: async () => null }));
    expect(next).toMatchObject({ ran: true, counts: { proposals: 0, already_proposed: 1 } });
    expect(s.listOpenProposals()).toHaveLength(1);
    const rows = s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").filter((x) => x.entry_id === "improve.route");
    expect(rows.at(-1)).toMatchObject({ verdict: "nothing", reason_code: "already_proposed", rung: "system_one", p: 0.8 });
    const s2 = RunStore.openInMemory();
    correction(s2);
    const noDraft = await runImproveTick(deps(s2, { llm: { ...deps(s2).llm, distill: llm("not json at all") } }));
    expect(noDraft).toMatchObject({ ran: true, counts: { proposals: 0, no_draft: 1 } });
    expect(s2.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").find((x) => x.entry_id === "improve.route")).toMatchObject({ verdict: "nothing", reason_code: "no_text" });
  });
  it("a recurrence cluster decided skill/recurrence by the rule rung queues a job through the hooks, at most 3 a day; the 4th cluster is deferred and stays unconsumed", async () => {
    const s = RunStore.openInMemory();
    const hooks: JobHooks = { reconcile: vi.fn(), reconcileAccepted: vi.fn(), runQueued: vi.fn(async () => 0),
      enqueueFromRecurrence: vi.fn((store, i) => store.insertImprovementJob({ decision_id: i.decision_id, proposal_id: null, chat_id: i.chat_id, origin_json: JSON.stringify(i.origin), idempotency_key: i.idempotency_key, created_at: i.now })) };
    const texts = ["alpha", "beta", "gamma", "delta"];
    for (const t of texts) for (let k = 0; k < 3; k += 1) {
      const run_id = turn(s, `${t} request number ${k} for the weekly thing`).run_id;
      s.insertJevVerdict({ run_id, category: "answer", breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "answer", role: "default", effort: null, cascade: null,
        save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null });
    }
    const embed = async (text: string) => Float32Array.from(texts.map((t) => (text.startsWith(t) ? 1 : 0)));
    const r = await runImproveTick(deps(s, { embed, jobs: hooks }));
    expect(r).toMatchObject({ ran: true, counts: { recurrence: 4, jobs_queued: 3, jobs_started: 0, deferred: 1 } }); // queued by the tick; started by the hook (a fake here)
    expect(s.listJobsByState(["queued"]).map((j) => j.chat_id)).toEqual(["555", "555", "555"]);
    expect(s.listUnconsumedSignals(10).map((x) => x.signal)).toEqual(["recurrence"]);
    expect(hooks.runQueued).toHaveBeenCalledWith(expect.anything(), 3);
    expect(hooks.reconcile).toHaveBeenCalledTimes(1);
  });

  it("a group whose commit throws rolls back whole (no decision row, rows unconsumed, record_failed 1) and the next group still commits; the tick is done, not failed", async () => {
    const s = RunStore.openInMemory();
    correction(s); correction(s, "find me the march invoice again", "lookup");
    const real = s.insertImprovementProposal.bind(s);
    let n = 0;
    vi.spyOn(s, "insertImprovementProposal").mockImplementation((p) => { n += 1; if (n === 1) throw new Error("boom"); return real(p); });
    const r = await runImproveTick(deps(s));
    expect(r).toMatchObject({ ran: true, result: "done", counts: { decided: 1, proposals: 1, record_failed: 1 } });
    expect(s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").filter((x) => x.entry_id === "improve.route")).toHaveLength(1);
    expect(s.listUnconsumedSignals(10)).toHaveLength(1);
    expect(s.listOpenProposals()).toHaveLength(1);
  });
  it("a decision row that cannot be written consumes nothing: no outcome rows, no proposal, record_failed 1; the next group commits", async () => {
    const s = RunStore.openInMemory();
    correction(s); correction(s, "find me the march invoice again", "lookup");
    const real = s.insertDecision.bind(s);
    let n = 0;
    vi.spyOn(s, "insertDecision").mockImplementation((x) => { if (x.entry_id === "improve.route") { n += 1; if (n === 1) throw new Error("disk"); } return real(x); });
    const r = await runImproveTick(deps(s));
    expect(r).toMatchObject({ ran: true, result: "done", counts: { decided: 1, proposals: 1, record_failed: 1 } });
    const rows = s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").filter((x) => x.entry_id === "improve.route");
    expect(rows).toHaveLength(1);
    expect(s.listDecisionOutcomes(rows[0]!.decision_id)).toHaveLength(1);
    expect(s.listOpenProposals()).toHaveLength(1);
    expect(s.listUnconsumedSignals(10)).toHaveLength(1);
  });
});
