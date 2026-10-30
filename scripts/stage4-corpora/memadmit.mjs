// Stage 4C differential, memory-save admit corpus (spec 2026-10-30 §3.1, §4.1, §6). Pair: s4b -> new. Two levels:
//  adapter: createMemoryWriteAdapter from each dist over stubs (llm, save, srcContains); compared: the tool result, the plan the save received,
//           the llm call count and the srcContains call count (pins "no grep on an early return").
//  worker:  runMemoryWrite on the dist's own CoreWorker over a temp store, once as source "loop" and once as "lane"; compared: result, ledger
//           events, lessons / episodic_facts / memory_changes rows and decisions (memory.kind included).
// memory.lesson_admit rows are filtered by the harness (NEW_ROW_IDS.s4b) and instead REQUIRED on the new side (item.expect); the old side
// must hold none (checked in project). No Date override here: wall-clock columns are compared by presence only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISTS, mkStore, mkTemp, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { adminWorker } from "../stage4-admit-fixture.mjs";

const CHAT = "555";
const OPINION = "I think the south side noodle shop is better than the north one";
const PRIOR = "Want me to remember that?"; // a lesson that only restates the prior reply is refused by the backstop
const INSTR = "please remember this about the south side noodle shop";
const OWNED = 'change the "Zebra Quartz Label" wording please'; // quoted phrase; planted in <project>/src/x.ts for the worker items
const OWNED_THREAD = 'the "Zebra Quartz Label" wording looks odd'; // the same phrase, only in an earlier turn
const FACT = "Paco prefers the south side noodle shop";
const EV = { line: 1, quote: "south side noodle shop is better" };
// The worker reads only recent turns, so the earlier exchange is stamped relative to now (the stamp itself is a stripped column).
const later = (ms) => new Date(Date.now() + ms).toISOString();
const D = (o) => JSON.stringify(o);
const RULE = D({ kind: "rule", lesson: "keep answers short" });
const FACT_ONLY = D({ kind: "fact", fact: FACT, evidence: EV });
const BOTH = D({ kind: "both", lesson: "keep answers short", fact: FACT, evidence: EV });
const LESSON_REFUSED_FACT_OK = D({ kind: "both", lesson: PRIOR, fact: FACT, evidence: EV });
const FACT_NO_EVIDENCE_LESSON_OK = D({ kind: "both", lesson: "keep answers short", fact: "Paco owns a red bicycle", evidence: { line: 1, quote: "completely unrelated quotation here" } });
const BOTH_REFUSED = D({ kind: "both", lesson: PRIOR, fact: PRIOR, evidence: EV });
const FACT_REFUSED = D({ kind: "fact", fact: PRIOR, evidence: EV });
const NONE = D({ kind: "none" });
const A = (reason) => ["refuse", reason];

// Adapter items. over: scheduledRun / alreadySaved / srcHit (what srcContains answers for a phrase) / abort ("before" | "after" the distill call).
const ITEMS_ADAPTER = [
  { key: "a:scheduled", tags: ["adapter", "scheduled"], over: { scheduledRun: true }, srcHit: () => true, expect: [A("scheduled_run")] },
  ...[["lesson", { lesson_id: 7 }], ["fact", { fact_id: 8 }], ["both", { lesson_id: 7, fact_id: 8 }]].map(([n, ids]) => (
    { key: `a:saved_${n}`, tags: ["adapter", "saved"], over: { alreadySaved: ids }, srcHit: () => true, expect: [A("already_saved")] })),
  { key: "a:owned_instruction", tags: ["adapter", "owned"], instruction: OWNED, srcHit: (p) => p === "Zebra Quartz Label", expect: [A("code_owned")] },
  { key: "a:owned_thread", tags: ["adapter", "owned"], threadUserTexts: [OWNED_THREAD], srcHit: (p) => p === "Zebra Quartz Label", expect: [A("code_owned")] },
  { key: "a:owned_miss", tags: ["adapter", "owned"], instruction: OWNED, srcHit: () => false, distill: RULE, expect: [] },
  { key: "a:owned_scope_note", tags: ["adapter", "owned"], instruction: OWNED, input: { scope: "bogus" }, srcHit: () => true, expect: [A("code_owned")] },
  { key: "a:empty_instruction", tags: ["adapter", "empty"], instruction: "   ", srcHit: () => true, expect: [] },
  { key: "a:backstop_lesson", tags: ["adapter", "backstop"], distill: LESSON_REFUSED_FACT_OK, prior: PRIOR, expect: [A("lesson_backstop")] },
  { key: "a:backstop_fact_no_evidence", tags: ["adapter", "backstop"], distill: FACT_NO_EVIDENCE_LESSON_OK, expect: [A("fact_no_evidence")] },
  { key: "a:backstop_both", tags: ["adapter", "backstop"], distill: BOTH_REFUSED, prior: PRIOR, expect: [A("lesson_backstop"), A("fact_backstop")] },
  { key: "a:backstop_fact", tags: ["adapter", "backstop"], distill: FACT_REFUSED, prior: PRIOR, expect: [A("fact_backstop")] },
  { key: "a:clean_lesson", tags: ["adapter", "clean"], distill: RULE, expect: [] },
  { key: "a:clean_fact", tags: ["adapter", "clean"], distill: FACT_ONLY, expect: [] },
  { key: "a:clean_both", tags: ["adapter", "clean"], distill: BOTH, expect: [] },
  { key: "a:nothing_to_save", tags: ["adapter", "clean"], distill: NONE, expect: [] },
  { key: "a:abort_before", tags: ["adapter", "abort"], distill: LESSON_REFUSED_FACT_OK, prior: PRIOR, abort: "before", expect: [] },
  { key: "a:abort_after", tags: ["adapter", "abort"], distill: LESSON_REFUSED_FACT_OK, prior: PRIOR, abort: "after", expect: [] }
];

// Worker items. run: "turn" (a Paco turn) | "schedule" (a schedule-born run). hook: fires inside the save, when the fact side is embedded.
// Each item runs twice, with source "loop" and "lane".
const ITEMS_WORKER_BASE = [
  { name: "scheduled", tags: ["scheduled"], run: "schedule", distill: LESSON_REFUSED_FACT_OK, expect: [A("scheduled_run")] },
  { name: "saved", tags: ["saved"], distill: LESSON_REFUSED_FACT_OK, hook: "prior_save", expect: [A("already_saved")] },
  { name: "owned_instruction", tags: ["owned"], goal: OWNED, plant: true, distill: LESSON_REFUSED_FACT_OK, expect: [A("code_owned")] },
  { name: "owned_thread", tags: ["owned"], earlier: OWNED_THREAD, plant: true, distill: LESSON_REFUSED_FACT_OK, expect: [A("code_owned")] },
  { name: "backstop", tags: ["backstop"], distill: LESSON_REFUSED_FACT_OK, expect: [A("lesson_backstop")] },
  { name: "abort", tags: ["abort"], distill: LESSON_REFUSED_FACT_OK, hook: "abort", expect: [] },
  { name: "replaced", tags: ["replaced"], distill: LESSON_REFUSED_FACT_OK, hook: "replace", expect: [] },
  { name: "race", tags: ["race"], distill: LESSON_REFUSED_FACT_OK, hook: "race", reason: "already_saved_this_turn", expect: [A("lesson_backstop")] }
];
const ITEMS_WORKER = ITEMS_WORKER_BASE.flatMap((b) => ["loop", "lane"].map((source) => (
  { ...b, key: `w:${b.name}:${source}`, tags: ["worker", source, ...b.tags], source })));
const ITEMS = [...ITEMS_ADAPTER.map((i) => ({ ...i, level: "adapter" })), ...ITEMS_WORKER.map((i) => ({ ...i, level: "worker" }))];
const BRANCHES = ["adapter", "worker", "loop", "lane", "scheduled", "saved", "owned", "empty", "backstop", "clean", "abort", "replaced", "race"];

const rows = (store, sql) => store.db.prepare(sql).all();
const CLOCK = /(_at|^valid_from|^valid_until|^last_seen)$/;
/** Wall-clock instants vary per run: relabelClocks keeps their order and equality (t#1, t#2, ...), not the values (see its doc). */
const isClock = (k) => /(_at|^valid_from|^valid_until|^last_seen)$/.test(k);
const DEC_SQL = "SELECT entry_id, tool_call_id, stage, rung, verdict, reason_code, armed_mode, fallback_reason FROM decisions ORDER BY rowid";

// ---- adapter level ----
function makeSources(d, item) {
  const own = { run_id: "r", turn_id: null, text: item.instruction ?? INSTR };
  const recent = [{ turn_id: "t1", run_id: "e", text: OPINION }];
  const input = { own, steered: [], quoted: null, recent, prior: item.prior ?? "" };
  if (d.memorySources) return d.memorySources(input);
  throw new Error(`${d.dir} has no memorySources`);
}

async function projectAdapter(d, item) {
  const calls = { llm: 0, src: 0 };
  const admit = [];
  const plans = [];
  const cfg = {
    sources: makeSources(d, item), allowedScopes: ["ask", "research"], defaultScope: "ask", recorder: { record: () => null },
    admitRecorder: { record: (e, r) => { admit.push({ entry_id: e.id, verdict: r.verdict, reason_code: r.reason }); return null; } },
    run_id: "r", runSource: () => "telegram",
    llm: async () => { calls.llm += 1; return { ok: true, output: { answer: item.distill ?? RULE } }; },
    save: async (plan) => {
      plans.push(plan);
      return { ...(plan.lesson ? { lesson: { verb: "add", id: 1, lesson: plan.lesson.text, prunedIds: [] } } : {}),
        ...(plan.fact ? { fact: { verb: "add", id: 2, fact: plan.fact.text } } : {}) };
    },
    srcContains: (p) => { calls.src += 1; return (item.srcHit ?? (() => false))(p); },
    ...(item.threadUserTexts ? { threadUserTexts: item.threadUserTexts } : {}),
    ...(item.abort ? { aborted: () => item.abort === "before" || calls.llm > 0 } : {}),
    ...item.over
  };
  const result = await d.createMemoryWriteAdapter(cfg)(item.input ?? {});
  if (d.dir !== DISTS.new && admit.length) throw new Error("control failed: the old build recorded memory.lesson_admit rows");
  return { result, plans, llm_calls: calls.llm, src_calls: calls.src, decisions: admit };
}

// ---- worker level ----
const seat = (distill) => async (input) => {
  const system = String(input.system ?? "");
  const answer = /durable/i.test(system) ? distill : /verdict/i.test(system) ? '{"verdict":"ADD"}' : '{"verdict":"ADD","theme":"format"}';
  return { ok: true, output: { answer } };
};

function intake(d, store, ev) {
  const r = new d.Gateway(store).intake(d.buildTypedTaskEvent(ev));
  if (!r.ok) throw new Error(`memadmit intake failed: ${JSON.stringify(r)}`);
  return r.run_id;
}
const base = { type: "turn", program: "turn", notify: { kind: "telegram", chat_id: CHAT } };

/** Seeds the earlier Paco exchange, then the live run (a Paco turn, or a schedule-born run). */
function seedRuns(d, store, item) {
  const text = item.earlier ?? OPINION;
  const earlier = intake(d, store, { ...base, source: "telegram", goal: text, requested_by: { kind: "user", id: "paco" },
    idempotency_key: "memadmit:earlier", source_reference: "telegram:update:1:message:1" });
  store.recordChatTurn({ chat_id: CHAT, run_id: earlier, role: "user", text, created_at: later(-60_000) });
  store.recordChatTurn({ chat_id: CHAT, run_id: earlier, role: "assistant", text: PRIOR, created_at: later(-59_000) });
  const live = item.run === "schedule"
    ? intake(d, store, { ...base, source: "schedule", goal: "daily brief: synthetic goal", requested_by: { kind: "schedule", id: "sch_t" },
      idempotency_key: "memadmit:schedule", source_reference: "scheduled_tasks.sch_t" })
    : intake(d, store, { ...base, source: "telegram", goal: item.goal ?? "remember it", requested_by: { kind: "user", id: "paco" },
      idempotency_key: "memadmit:live", source_reference: "telegram:update:2:message:1" });
  return live;
}

async function projectWorker(d, item) {
  const root = mkTemp(`memadmit-${item.key}`);
  const store = mkStore(d, "bare", join(root, "memadmit.sqlite"));
  try {
    if (item.plant) { mkdirSync(join(root, "project", "src"), { recursive: true }); writeFileSync(join(root, "project", "src", "x.ts"), `export const LABEL = "Zebra Quartz Label";\n`); }
    const hooks = { n: 0, fire: () => undefined };
    const worker = adminWorker(d, root, store, { llm: seat(item.distill), embed: async () => { hooks.fire(); return new Float32Array([0.1, 0.2]); } });
    const run_id = seedRuns(d, store, item);
    const claim = store.claimRun(run_id, "w", 120);
    if (!claim) throw new Error("memadmit claim failed");
    worker.buildOmpTools(claim, CHAT);
    const turns = worker.ompTurns;
    const ac = new AbortController();
    if (item.hook === "prior_save") turns.get(run_id).memorySavedThisTurn = { lesson: { id: 5 } };
    if (item.hook === "abort") hooks.fire = () => { hooks.n += 1; ac.abort(); };
    if (item.hook === "replace") hooks.fire = () => { hooks.n += 1; turns.set(run_id, { ...turns.get(run_id) }); };
    if (item.hook === "race") hooks.fire = () => { hooks.n += 1; turns.get(run_id).memorySavedThisTurn = { fact: { id: 99 } }; };
    const out = await worker.runMemoryWrite(claim, CHAT, {}, { source: item.source, signal: ac.signal });
    const decisions = rows(store, DEC_SQL);
    if (d.dir !== DISTS.new && decisions.some((r) => r.entry_id === "memory.lesson_admit")) throw new Error("control failed: the old build wrote memory.lesson_admit rows");
    const view = { result: out.result, committed: out.committed, saved: out.saved ?? null,
      ledger: rows(store, "SELECT event_type, actor, sequence, payload_json FROM ledger_events ORDER BY rowid"),
      lessons: rows(store, "SELECT * FROM lessons ORDER BY rowid"),
      episodic_facts: rows(store, "SELECT * FROM episodic_facts ORDER BY id"),
      memory_changes: rows(store, "SELECT * FROM memory_changes ORDER BY rowid"), decisions, hook_fired: hooks.n };
    // per-side check for required(): every new row sits on this item's own run (outside the compared view, listed in __strip)
    return { ...scrubIds(relabelClocks(view, isClock), [root]), run_ok: store.db.prepare("SELECT run_id FROM decisions WHERE entry_id = ?").all("memory.lesson_admit").every((r) => r.run_id === run_id), __strip: ["run_ok"] };
  } finally { try { store.close(); } catch { /* closed */ } }
}

const project = (d, item) => (item.level === "adapter" ? projectAdapter(d, item) : projectWorker(d, item));

function required(d, item, proj) {
  const got = proj.decisions.filter((r) => r.entry_id === "memory.lesson_admit").map((r) => [r.verdict, r.reason_code]);
  requireNew(corpus, item, "memory.lesson_admit rows", JSON.stringify(got) === JSON.stringify(item.expect), `got ${JSON.stringify(got)}, want ${JSON.stringify(item.expect)}`);
  if (item.level === "adapter") return;
  requireNew(corpus, item, "memory.lesson_admit rows attached to the item's own run", proj.run_ok === true);
  if (["abort", "replace", "race"].includes(item.hook)) requireNew(corpus, item, "the hook fired inside the save", proj.hook_fired > 0, `fired ${proj.hook_fired}`);
  if (item.reason) requireNew(corpus, item, "result reason", proj.result?.output?.reason === item.reason, `got ${proj.result?.output?.reason}`);
  const other = proj.decisions.filter((r) => r.entry_id !== "memory.lesson_admit" && r.entry_id !== "memory.kind");
  requireNew(corpus, item, "no other decision rows", other.length === 0, [...new Set(other.map((r) => r.entry_id))].join(","));
}

const corpus = { name: "memadmit", pairs: [["s4b", "new"]], min: { items: 35, branches: BRANCHES }, async load() { return ITEMS; }, project, required };
export default corpus;
