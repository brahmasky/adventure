// Slice R6 differential, model corpus (spec 2026-11-03 R6 §6). Pair: r6 (the merge-base build b0da208a) -> new. Every item drives the dist's own PlannerSupervisor
// (scripts/stage4-supervisor-fixture.mjs) on a fresh temp-file store, under a pinned env (P2: no tombstone in the cwd; P3: no chat id for a recorder alert) and a counting
// clock, with a scripted `lists` per role and a fake session whose `setModel` refuses (omp's `Model not found`, as that dist's PlannerRpcError), throws a transport
// error or is held. BOTH sides get a recorder (the old build already records R1-R5 rows, e.g. turn.retry, so only the R6 rows differ); the new side's is counting.
// Compared: the session's ORDERED call log (prompts, set_model targets), the sink's done/failed/incidents (worker ids scrubbed) and a whole-DB dump with the R6 decision rows
// removed at the dump (P16; clocks relabelled by order, ids scrubbed). REQUIRED on the new side: the exact rows [entry, rung, verdict, reason, run, tool_call] of
// turn.model / turn.retry / lookup.* in write order, the exact per-entry recorder call counts, and the behaviour facts (so a scenario that silently stopped reaching its
// branch fails too). The old build must hold no R6 row. P15: no item intakes more than 5 runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISTS, R6_IDS, NEW_ROW_IDS, canon, compare, dumpDb, mkStore, mkTemp, regularTables, extraDropFilter, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { NOW, withCountingClock, withPinnedEnv } from "../stage4-intake-fixture.mjs";
import { countingRecorder } from "../stage4-sender-fixture.mjs";
import { laneTurn, runLane } from "../stage4-lane-fixture.mjs";
import { cleanup, fakeSession, intakeRun, mkSupervisor, modelRefusal, req, until, untilState } from "../stage4-supervisor-fixture.mjs";

const A = "anthropic/claude-opus-5-5"; const B = "google-antigravity/claude-opus-4-6"; const C = "kimi-code/k3"; const F = "anthropic/claude-sonnet-5-5";
const LISTS = { default: [`${A}:medium`, `${B}:medium`, `${C}:low`], fast: [`${F}:low`], thinking: [`${A}:high`] };
const routed = (role) => ({ triage: async () => ({ kind: "fallthrough", route: { role, effort: null, verdict_id: "jv_1" } }) });
const TM = "turn.model"; const TR = "turn.retry"; const SQ = "intake.steer_or_queue"; const CG = "planner.crash_guard"; const LS = "context.lessons"; const CC = "turn.clarify_cap";
const RW = "lookup.rewrite"; const TH = "lookup.thin"; const WALL = "tool.wall"; const FAM = "reader.family";
const R = (entry, verdict, reason, rung = "rule", run = "a") => [entry, rung, verdict, reason, run, null];
const ONE = { [SQ]: 1, [CG]: 1, [LS]: 1, [CC]: 1, [TM]: 1 };
const RN = "RETRY_NOTE";

/** One turn through the supervisor, to idle. */
async function turn(x, sup, name, text = "hi") { const id = x.run(name, text); sup.submit(req(id, text)); await sup.whenIdle(); return id; }
/**
 * A child whose setModel refuses the `refuse` targets (omp's `Model not found`), throws a transport error for the `transport` ones, or never answers (`hold`); its prompts
 * fail with errors[i] (an assistant error frame) until they run out, then answer "ok" (`always`: every prompt fails with it).
 */
function child(x, o = {}) {
  let calls = 0; let s;
  const errFrame = (err) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 2 }, stopReason: "error", errorMessage: err } });
  s = fakeSession({
    setModel: async (_m, k) => {
      if (o.hold) await new Promise(() => undefined);
      if (o.refuse?.includes(k)) throw modelRefusal(x.d, k);
      if (o.transport?.includes(k)) throw new x.d.PlannerRpcError("timeout:set_model");
    },
    ...(o.errors || o.always ? { onPrompt: (_t, emit) => {
      emit({ type: "turn_start" });
      const err = o.always ?? o.errors[calls++];
      if (err) emit(errFrame(err)); else s.assistant("ok");
      emit({ type: "agent_end" });
    } } : {})
  });
  return s;
}
const solo = (o, extra = {}, lists = LISTS) => async (x) => { const { sup } = x.mk({ session: child(x, o), lists, extra }); await turn(x, sup, "a"); };
const planted = async (d, file, name, drive) => {
  let mod = null;
  try { mod = await import(join(d.dir, "decisions", "entries", file)); } catch (e) { if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e; }
  const rung = mod?.[name]?.ladder[0];
  if (d.dir === DISTS.new && !rung) throw new Error(`fault item: ${name} missing from the new dist`);
  const orig = rung?.decide;
  if (rung) rung.decide = () => { throw new Error("planted"); };
  try { await drive(); } finally { if (rung) rung.decide = orig; }
};

// first leg ---------------------------------------------------------------------------------------------------------------------------------------------------
const twoTurns = (o) => async (x) => { const { sup } = x.mk({ session: child(x, o), lists: LISTS }); await turn(x, sup, "a"); await turn(x, sup, "b"); };
/** /kill while the first pin is held: the walk ends (ENDED), so nothing is consulted. */
const heldPin = async (x) => {
  const s = child(x, { hold: true }); const { sup } = x.mk({ session: s, lists: LISTS });
  const a = x.run("a", "hi"); sup.submit(req(a, "hi")); await until(() => s.models.length === 1);
  await sup.abortAll("killed"); await sup.whenIdle();
};
const laneTurnOnly = async (x) => { const { sup } = x.mk({ lists: LISTS, extra: { triage: async () => ({ kind: "lane_reply", text: "lane text", buttons: [] }) } }); await turn(x, sup, "a"); };
/**
 * Spec §6 liveness: the warm child exits (exit(1)) while the lookup lane's rewrite is held. The triage is the dist's own runLookupLane over scripted deps (the lane fixture),
 * writing through the supervisor's recorder; the turn must go on to its lane reply, the lane rows must be written, and no planner_exit may surface.
 */
const warmExitWhileHeld = async (x) => {
  let release = () => undefined; const gate = new Promise((r) => { release = r; }); let held = false; let id = null;
  const s = child(x);
  const triage = async (i) => {
    const { result } = await runLane(x.d, { signal: i.signal, previousTelegramTurns: () => [laneTurn("look it up", 5)], input: { run_id: id, userText: "check again" }, recorder: x.laneRecorder,
      rewrite: async () => { held = true; await gate; return { ok: true, provider: "kimi-code", model: "k3", answer: "SAME" }; } });
    return result.kind === "reply" ? { kind: "lane_reply", text: result.text, buttons: [] } : { kind: "fallthrough" };
  };
  const { sup } = x.mk({ session: s, lists: LISTS, extra: { triage } });
  id = x.run("a", "check again"); sup.submit(req(id, "check again"));
  await until(() => held); await untilState(sup, "IDLE");
  s.exit(1); await untilState(sup, "STOPPED");
  x.note("state_at_release", sup.state()); release(); await sup.whenIdle();
};

const ITEMS = [
  { key: "first_head_pinned", tags: ["head"], drive: solo({}), rows: [], calls: ONE,
    facts: { done: ["a:answer"], failed: [], incidents: [], log: [`set_model:${A}`, "prompt:hi"], missing: 0, escalations: [], notes: {} } },
  { key: "first_child_already_on_head", tags: ["on_head"], drive: twoTurns({}), rows: [], calls: { [SQ]: 2, [CG]: 1, [LS]: 1, [CC]: 2, [TM]: 2 },
    facts: { done: ["a:answer", "b:answer"], failed: [], incidents: [], log: [`set_model:${A}`, "prompt:hi", "prompt:hi"], missing: 0, escalations: [], notes: {} } },
  { key: "first_cached_refusal", tags: ["cached_refusal"], drive: twoTurns({ refuse: [A] }), rows: [R(TM, "fallback", "refused")], calls: { [SQ]: 2, [CG]: 1, [LS]: 1, [CC]: 2, [TM]: 2 },
    // the fake child reports anthropic/claude-opus-5-5 in its message_end, so the supervisor re-pins candidate two for turn 2 (an RPC; its own walk refuses nothing: head, no row)
    facts: { done: ["a:answer", "b:answer"], failed: [], incidents: [], log: [`set_model:${A}`, `set_model:${B}`, "prompt:hi", `set_model:${B}`, "prompt:hi"], missing: 1, escalations: [], notes: {} } },
  { key: "first_head_refused_second_pinned", tags: ["refused"], drive: solo({ refuse: [A] }), rows: [R(TM, "fallback", "refused")], calls: ONE,
    facts: { done: ["a:answer"], failed: [], incidents: [], log: [`set_model:${A}`, `set_model:${B}`, "prompt:hi"], missing: 1, escalations: [], notes: {} } },
  { key: "first_routed_fast_all_refused", tags: ["stepped_up"], drive: solo({ refuse: [F] }, routed("fast")), rows: [R(TM, "fallback", "stepped_up")], calls: ONE,
    facts: { done: ["a:answer"], failed: [], incidents: [], log: [`set_model:${F}`, `set_model:${A}`, "prompt:hi"], missing: 1, escalations: [{ from: "fast", to: "default", kind: "model_missing" }], notes: {} } },
  { key: "first_unrouted_all_refused", tags: ["no_leg"], drive: solo({ refuse: [A, B, C] }), rows: [R(TM, "none", "no_leg")], calls: ONE,
    facts: { done: [], failed: ["a:no_planner_leg:model_missing"], incidents: ["planner_no_leg"], log: [`set_model:${A}`, `set_model:${B}`, `set_model:${C}`], missing: 3, escalations: [], notes: {} } },
  { key: "first_transport_error", tags: ["pin_failed_first"], drive: solo({ transport: [A] }), rows: [R(TM, "held", "pin_failed")], calls: ONE,
    facts: { done: ["a:answer"], failed: [], incidents: ["planner_model_reset_failed"], log: [`set_model:${A}`, "prompt:hi"], missing: 0, escalations: [], notes: {} } },
  { key: "first_aborted_while_held", tags: ["aborted"], drive: heldPin, rows: [], calls: { [SQ]: 1, [CG]: 1, [LS]: 1, [CC]: 1 },
    facts: { done: [], failed: ["a:killed:killed"], incidents: [], log: [`set_model:${A}`], missing: 0, escalations: [], notes: {} } },
  { key: "retry_quota_next_leg", tags: ["next_leg"], drive: solo({ errors: ["429 quota"] }), rows: [R(TR, "retry", "quota"), R(TM, "fallback", "next_leg")], calls: { ...ONE, [TR]: 1, [TM]: 2 },
    facts: { done: ["a:ok"], failed: [], incidents: [], log: [`set_model:${A}`, "prompt:hi", `set_model:${B}`, `prompt:${RN}`], missing: 0, escalations: [], notes: {} } },
  { key: "retry_routed_chain_spent_steps_up", tags: ["retry_stepped_up"], drive: solo({ errors: ["429 quota"] }, routed("fast")), rows: [R(TR, "retry", "quota"), R(TM, "fallback", "stepped_up")], calls: { ...ONE, [TR]: 1, [TM]: 2 },
    facts: { done: ["a:ok"], failed: [], incidents: [], log: [`set_model:${F}`, "prompt:hi", `set_model:${A}`, `prompt:${RN}`], missing: 0, escalations: [{ from: "fast", to: "default", kind: "quota" }], notes: {} } },
  { key: "retry_unrouted_chain_spent", tags: ["retry_no_leg"], drive: solo({ always: "429 quota" }, {}, { ...LISTS, default: [`${A}:medium`, `${B}:medium`] }),
    rows: [R(TR, "retry", "quota"), R(TM, "fallback", "next_leg"), R(TR, "retry", "quota"), R(TM, "none", "no_leg")], calls: { ...ONE, [TR]: 2, [TM]: 3 },
    facts: { done: [], failed: ["a:no_planner_leg:quota"], incidents: ["planner_no_leg"], log: [`set_model:${A}`, "prompt:hi", `set_model:${B}`, `prompt:${RN}`], missing: 0, escalations: [], notes: {} } },
  { key: "retry_pin_throws", tags: ["retry_pin_failed"], drive: solo({ errors: ["429 quota"], transport: [B] }), rows: [R(TR, "retry", "quota"), R(TM, "none", "pin_failed")], calls: { ...ONE, [TR]: 1, [TM]: 2 },
    facts: { done: [], failed: ["a:planner_exit:retry_failed: timeout:set_model"], incidents: [], log: [`set_model:${A}`, "prompt:hi", `set_model:${B}`], missing: 0, escalations: [], notes: {} } },
  // two adjacent identical candidates: the retry's pin finds the child already on it (no set_model), and the short-circuit still counts as an iteration
  { key: "retry_child_already_on_next", tags: ["retry_short_circuit"], drive: solo({ errors: ["429 quota"] }, {}, { ...LISTS, default: [`${A}:medium`, `${A}:medium`] }),
    rows: [R(TR, "retry", "quota"), R(TM, "fallback", "next_leg")], calls: { ...ONE, [TR]: 1, [TM]: 2 },
    facts: { done: ["a:ok"], failed: [], incidents: [], log: [`set_model:${A}`, "prompt:hi", `prompt:${RN}`], missing: 0, escalations: [], notes: {} } },
  { key: "retry_after_earlier_refusal", tags: ["retry_after_refusal"], drive: solo({ errors: ["429 quota"], refuse: [A] }),
    rows: [R(TM, "fallback", "refused"), R(TR, "retry", "quota"), R(TM, "fallback", "next_leg")], calls: { ...ONE, [TR]: 1, [TM]: 2 },
    facts: { done: ["a:ok"], failed: [], incidents: [], log: [`set_model:${A}`, `set_model:${B}`, "prompt:hi", `set_model:${C}`, `prompt:${RN}`], missing: 1, escalations: [], notes: {} } },
  { key: "fault_turn_model_rule", tags: ["fault"], plant: ["turn-model.js", "TURN_MODEL"], drive: solo({}), rows: [R(TM, "head", null, "fail")], calls: ONE,
    facts: { done: ["a:answer"], failed: [], incidents: [], log: [`set_model:${A}`, "prompt:hi"], missing: 0, escalations: [], notes: {} } },
  { key: "none_lane_turn", tags: ["lane_none"], drive: laneTurnOnly, rows: [], calls: { [SQ]: 1, [CG]: 1, [LS]: 1 },
    facts: { done: ["a:lane text"], failed: [], incidents: [], log: [], missing: 0, escalations: [], notes: {} } },
  { key: "lane_warm_child_exits_while_rewrite_held", tags: ["lane_liveness"], drive: warmExitWhileHeld, rows: [R(WALL, "crosses", null), R(FAM, "fallback", null), R(RW, "bare", "same"), R(TH, "none", "answered")],
    calls: { [SQ]: 1, [CG]: 1, [LS]: 1, [WALL]: 1, [FAM]: 1, [RW]: 1, [TH]: 1 },
    facts: { done: ["a:Sunny tomorrow [1].\n\n来源 / Sources: https://example.test/forecast"], failed: [], incidents: [], log: [], missing: 0, escalations: [], notes: { state_at_release: "STOPPED" } } }
];
const BRANCHES = ITEMS.map((i) => i.tags[0]);

const all = (store, sql) => store.db.prepare(sql).all().map((r) => ({ ...r }));
const isClockKey = (k) => /(_at|_since|^since|^now)$/.test(k);
const idList = [...R6_IDS, "turn.retry", "tool.wall", "reader.family"].map((i) => `'${i}'`).join(",");
// P16 (R6): every row the new build records and this pair's old build cannot is dropped at the dump, so a non-default R6 row never shifts a clock label before compare strips it.
const dropIds = [...NEW_ROW_IDS.r6];
const dropList = dropIds.map((i) => `'${i}'`).join(",");

// Coverage self-test: the dump must hold, per table, exactly the rows the DB holds (minus the intentionally dropped R6 decisions rows),
// counted by SQL count(*) over the same ordinary-table rule dumpDb uses (virtual tables and their shadows left out).
function tableCounts(store) {
  const counts = {};
  for (const { name } of regularTables(store)) {
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${name === "decisions" ? ` WHERE entry_id NOT IN (${dropList})` : extraDropFilter(name)}`).get().n;
    if (n > 0) counts[name] = n;
  }
  return counts;
}
const dumpCounts = (db) => Object.fromEntries(Object.entries(db).map(([t, rows]) => [t, rows.length]));
function checkCoverage(db, want) {
  const got = dumpCounts(db);
  if (canon(got) !== canon(want)) throw new Error(`coverage self-test: dump holds ${canon(got)}, the DB holds ${canon(want)}`);
}
/** The check must itself catch a dump that lost one row of a still-populated table (or a whole table). */
function omittedRowSelfTest(db, want) {
  const t = Object.keys(db).find((k) => db[k].length > 1) ?? Object.keys(db)[0];
  if (!t) return;
  const mutated = { ...db, [t]: db[t].slice(1) };
  if (!mutated[t].length) delete mutated[t];
  try { checkCoverage(mutated, want); } catch { return; }
  throw new Error(`coverage self-test is blind: a dump missing one row of ${t} passed`);
}

const BARE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
/** Worker ids (`planner:<chat>:<uuid>`) carry a bare uuid scrubIds leaves alone: label them by first appearance. */
function scrubWorkers(v) {
  const seen = new Map();
  return JSON.parse(JSON.stringify(v).replace(BARE_UUID, (m) => { if (!seen.has(m)) seen.set(m, `uuid#${seen.size + 1}`); return seen.get(m); }));
}
const durationClass = (n) => (n === 0 ? 0 : "+");
/** The only stored copy of a turn's duration is its run_completed ledger payload (runs keeps none): it must equal what the sink was handed. */
function durationDisagreements(store, done, label) {
  return done.flatMap((c) => {
    const stored = store.getLedgerEvents(c.run_id).filter((e) => e.event_type === "run_completed").map((e) => e.payload.duration_ms);
    return stored.length === 1 && stored[0] === c.duration_ms ? [] : [{ run: label(c.run_id), sink: c.duration_ms, stored }];
  });
}
function classDurations(db) {
  return JSON.parse(JSON.stringify(db).replace(/\\"duration_ms\\":(\d+)/g, (_m, n) => `\\"duration_ms\\":\\"${durationClass(Number(n))}\\"`));
}
/** STRIP_KEYS drops every `run_id` before comparison, so ownership would be invisible: put a stable `run_label` beside each one. */
function labelRunOwners(v, ownerLabel) {
  if (Array.isArray(v)) return v.map((e) => labelRunOwners(e, ownerLabel));
  if (v === null || typeof v !== "object") return v;
  const out = {};
  for (const [k, e] of Object.entries(v)) {
    out[k] = labelRunOwners(e, ownerLabel);
    if (k === "run_id") out.run_label = typeof e === "string" ? ownerLabel(e) : e;
  }
  return out;
}

/** The ordered child log as short facts; RETRY_NOTE is named by its fixed opening. */
const RETRY_PREFIX = "(The previous model was unavailable.";
const logFacts = (d, log) => log.map(([kind, v]) => (kind === "prompt" ? `prompt:${v.startsWith(RETRY_PREFIX) ? "RETRY_NOTE" : v}` : kind === "set_model" ? `set_model:${v}` : `${kind}:${v}`));


async function project(d, item) {
  const dir = mkTemp(`model-${item.key}`);
  let store = null;
  try {
    return await withPinnedEnv(join(dir, "pin"), () => withCountingClock(NOW, async () => {
      store = mkStore(d, "bare", join(dir, "model.sqlite"));
      const isNew = d.dir === DISTS.new;
      const counting = isNew ? countingRecorder(d.storeRecorder(store)) : null;
      const recorder = counting ? counting.recorder : d.storeRecorder(store); // both builds record (the old one writes R1-R5 rows, e.g. turn.retry); only the new one has R6 entries
      const names = new Map(); const notes = {}; let rig = null;
      const x = {
        d, store, laneRecorder: recorder, note: (k, v) => { notes[k] = v; },
        run: (name, text) => { const id = intakeRun(d, store, text, name); names.set(id, name); return id; },
        mk: (opts = {}) => { rig = mkSupervisor(d, store, { ...opts, recorder }); return rig; }
      };
      const seedMax = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
      try { await (item.plant ? planted(d, item.plant[0], item.plant[1], () => item.drive(x)) : item.drive(x)); } finally { await cleanup(); }
      const label = (id) => names.get(id) ?? id;
      const order = [...names.keys()]; const foreign = new Map();
      const ownerLabel = (id) => (order.includes(id) ? `r${order.indexOf(id) + 1}` : foreign.has(id) ? foreign.get(id) : (foreign.set(id, `other#${foreign.size + 1}`), foreign.get(id)));
      const newRows = all(store, `SELECT entry_id, rung, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ${Number(seedMax)} AND entry_id IN (${idList}) ORDER BY rowid`)
        .map((r) => [r.entry_id, r.rung, r.verdict, r.reason_code, label(r.run_id), r.tool_call_id]);
      if (!isNew && newRows.some((r) => R6_IDS.includes(r[0]))) throw new Error("control failed: the old build wrote an R6 decision row");
      if (existsSync(join(process.cwd(), "houge.kill"))) throw new Error("P2 failed: a houge.kill appeared in the cwd");
      const db = dumpDb(store, { dropDecisionIds: dropIds });
      const want = tableCounts(store);
      checkCoverage(db, want);
      omittedRowSelfTest(db, want);
      const { session, outcome } = rig;
      const agreement = durationDisagreements(store, outcome.done, label);
      const seen = (list) => list.map(({ run_id, ...rest }) => ({ ...rest, ...("duration_ms" in rest ? { duration_ms: durationClass(rest.duration_ms) } : {}), run_id: label(run_id), run_label: ownerLabel(run_id) }));
      const observed = { log: session.log, done: seen(outcome.done), failed: seen(outcome.failed), incidents: outcome.incidents, db: classDurations(labelRunOwners(db, ownerLabel)) };
      const events = order.flatMap((id) => store.getLedgerEvents(id));
      const facts = { done: outcome.done.map((o) => `${label(o.run_id)}:${o.text}`), failed: outcome.failed.map((o) => `${label(o.run_id)}:${o.error_type}:${o.error_ref}`), incidents: outcome.incidents.map((i) => i.k),
        log: logFacts(d, session.log), missing: events.filter((e) => e.event_type === "llm_attempt" && e.payload.error_kind === "model_missing").length,
        escalations: events.filter((e) => e.event_type === "routed_escalation").map((e) => e.payload), notes };
      return { ...scrubWorkers(scrubIds(relabelClocks(observed, isClockKey))), newRows, calls: counting?.calls ?? {}, agreement, facts, __strip: ["newRows", "calls", "agreement", "facts"] };
    }));
  } finally { try { store?.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  requireNew(corpus, item, "emitted duration_ms equals the stored run_completed payload (exact)", proj.agreement.length === 0, `disagreements ${canon(proj.agreement)}`);
  requireNew(corpus, item, "turn.model / turn.retry / lookup.* / tool.wall rows (exact: entry, rung, verdict, reason, the consulting run, tool_call null, in write order)", canon(proj.newRows) === canon(item.rows), `got ${canon(proj.newRows)}, want ${canon(item.rows)}`);
  requireNew(corpus, item, "recorder calls per entry (exact)", canon(proj.calls) === canon(item.calls), `got ${canon(proj.calls)}, want ${canon(item.calls)}`);
  requireNew(corpus, item, "behaviour facts (sink calls, incidents, ordered child log, model_missing rows, escalations, drive notes: exact)", canon(proj.facts) === canon(item.facts), `got ${canon(proj.facts)}, want ${canon(item.facts)}`);
}

// Determinism self-test: the same item twice on the new build must project identically, or the old/new comparison would flag its own noise.
async function load(ctx) {
  const first = ITEMS.find((i) => i.key === "retry_after_earlier_refusal");
  const [a, b] = [await project(ctx.dists.new, first), await project(ctx.dists.new, first)];
  const diff = compare(corpus, first, a, b, corpus.pairs[0]);
  if (diff) throw new Error(`determinism self-test: two runs of one item project differently: ${diff.diff}`);
  return ITEMS;
}

const corpus = { name: "model", pairs: [["r6", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required };
export default corpus;
