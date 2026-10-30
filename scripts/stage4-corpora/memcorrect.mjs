// Stage 4C differential, memory_correct preflight corpus (spec 2026-10-30 §4.3, §6). Pair: s4b -> new. Each trust-limit refusal goes through
// BOTH callers (memoryWritePreflight and the gated executeMemoryCorrect) on a fresh temp-file store seeded with synthetic facts.
// Compared: each step's result, episodic_facts, memory_changes, ledger events and decisions. memory.correct_preflight rows are filtered by the
// harness (NEW_ROW_IDS.s4b) and REQUIRED on the new side, read through the dist's real storeRecorder (the default `allow` is not stored).
import { join } from "node:path";
import { DISTS, mkStore, mkTemp, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds, makeRun } from "../stage4-bind-fixture.mjs";

const CHAT = "555";
const R = (reason) => [["refuse", reason]];
const RET = { action: "retire", ids: [1] };
const COR = { action: "correct", ids: [1], correction: "synthetic corrected fact" };
const ALL = [1, 2, 3, 4, 5, 6, 7];
// step: "pre" (memoryWritePreflight) | "write" (gated executeMemoryCorrect) | "clear" (empties the turn's offered facts) | "search" (ungated-style search through the executor)
const both = (reason, setup, input) => ["pre", "write"].map((caller) => ({ key: `${reason}:${caller}`, tags: [reason, caller], offered: ALL, ...setup,
  steps: [[caller, input]], expect: R(reason) }));
const ITEMS = [
  ...both("not_operator_turn", { source: "schedule" }, RET),
  ...both("tainted_turn", { tainted: true }, RET),
  ...both("too_many", { }, { action: "retire", ids: [1, 2, 3, 4, 5, 6] }).map((i) => ({ ...i, key: i.key.replace("too_many", "too_many_ids"), tags: ["too_many_ids", ...i.tags.slice(1)] })),
  ...both("too_many", { changed: 9 }, { action: "retire", ids: [1, 2] }).map((i) => ({ ...i, key: i.key.replace("too_many", "too_many_changes"), tags: ["too_many_changes", ...i.tags.slice(1)] })),
  ...both("not_offered", { offered: [] }, RET),
  { key: "pass_retire:pre", tags: ["pass", "pre"], offered: ALL, steps: [["pre", RET]], expect: [] },
  { key: "pass_correct:pre", tags: ["pass", "pre"], offered: ALL, steps: [["pre", COR]], expect: [] },
  { key: "search:pre", tags: ["search", "pre"], offered: ALL, steps: [["pre", { action: "search", query: "synthetic" }]], expect: [] },
  { key: "bad_input:pre", tags: ["bad_input", "pre"], offered: ALL, steps: [["pre", { action: "retire", ids: [] }]], expect: [] },
  { key: "pass_retire:write", tags: ["pass", "write"], offered: ALL, steps: [["write", RET]], expect: [] },
  { key: "pass_correct:write", tags: ["pass", "write"], offered: ALL, steps: [["write", COR]], expect: [] },
  { key: "search:write", tags: ["search", "write"], offered: [], steps: [["write", { action: "search", query: "synthetic" }]], expect: [] },
  { key: "bad_input:write", tags: ["bad_input", "write"], offered: ALL, steps: [["write", { action: "retire", ids: [] }]], expect: [] },
  { key: "offered_cleared", tags: ["not_offered", "write", "cleared"], offered: ALL, steps: [["pre", RET], ["clear"], ["write", RET]], expect: R("not_offered") }
];
const BRANCHES = ["not_operator_turn", "tainted_turn", "too_many_ids", "too_many_changes", "not_offered", "pass", "search", "bad_input", "pre", "write", "cleared"];

// Full rows (SELECT *): created_at/updated_at-style columns are dropped by the harness's STRIP_KEYS; an embedding blob, if a row ever carries one,
// would need a per-item __strip (none is written here: embed returns null, so the column stays NULL). Ids are relabelled by scrubIds.
const rows = (store, sql) => store.db.prepare(sql).all();

async function runSteps(d, store, item, run_id) {
  const state = { offered: { fact: new Set(item.offered), wiki: new Set() }, changed: item.changed ?? 0 };
  const recorder = d.storeRecorder(store);
  const deps = { store, run_id, chat_id: CHAT, state, embed: async () => null, gated: true, recorder };
  const out = [];
  for (const [step, input] of item.steps) {
    if (step === "clear") { state.offered.fact.clear(); out.push({ step }); continue; }
    const result = step === "pre" ? d.memoryWritePreflight({ store, run_id, chat_id: CHAT, state, recorder }, input) : await d.executeMemoryCorrect(deps, input);
    out.push({ step, result });
  }
  return out;
}

async function project(d, item) {
  const store = mkStore(d, "bare", join(mkTemp(`memcorrect-${item.key}`), "memcorrect.sqlite"));
  try {
    for (let n = 1; n <= 7; n += 1) store.addEpisodicFact({ chat_id: CHAT, fact: `synthetic fact ${n}`, created_at: "2026-10-01T00:00:00.000Z" });
    const run_id = makeRun(d, store, item.source ?? "user", 1, false);
    if (item.tainted) store.appendRunLedgerEvent(run_id, "loop_step", "core", { step: 1, action: "x", capability: "web_fetch", ok: true, result_digest: "1 bytes" });
    const steps = await runSteps(d, store, item, run_id);
    const decisions = rows(store, `SELECT entry_id, tool_call_id, stage, rung, verdict, reason_code, armed_mode, fallback_reason FROM decisions ORDER BY rowid`);
    if (d.dir !== DISTS.new && decisions.some((r) => r.entry_id === "memory.correct_preflight")) throw new Error("control failed: the old build wrote memory.correct_preflight rows");
    return { ...scrubIds({ steps, episodic_facts: rows(store, `SELECT * FROM episodic_facts ORDER BY id`),
      memory_changes: rows(store, `SELECT * FROM memory_changes ORDER BY rowid`), ledger: rows(store, `SELECT event_type, actor, sequence, payload_json FROM ledger_events ORDER BY rowid`), decisions }),
      // valid_until / valid_from: wall-clock instants a retire/correct stamps on the superseded and the new fact; they vary per run and carry no behaviour
      __strip: ["valid_until", "valid_from"] };
  } finally { try { store.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  const got = proj.decisions.filter((r) => r.entry_id === "memory.correct_preflight").map((r) => [r.verdict, r.reason_code]);
  requireNew(corpus, item, "memory.correct_preflight rows", JSON.stringify(got) === JSON.stringify(item.expect), `got ${JSON.stringify(got)}, want ${JSON.stringify(item.expect)}`);
  const other = proj.decisions.filter((r) => r.entry_id !== "memory.correct_preflight");
  requireNew(corpus, item, "no other decision rows", other.length === 0, [...new Set(other.map((r) => r.entry_id))].join(","));
}

const corpus = { name: "memcorrect", pairs: [["s4b", "new"]], min: { items: 19, branches: BRANCHES }, async load() { return ITEMS; }, project, required };
export default corpus;
