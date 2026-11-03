// Slice R4 differential, supervision corpus (spec 2026-11-01 R4 §6). Pair: r4 (the merge-base build c6eae37) -> new. Every item drives the dist's own
// PlannerSupervisor (scripts/stage4-supervisor-fixture.mjs) on a fresh temp-file store, under a pinned env (P2: no tombstone in the cwd; P3: no chat id for a
// recorder alert) and a counting clock. The new side's supervisor gets a counting recorder over the store recorder; the old build has no `recorder` dep.
// Compared: the child's ORDERED call log (prompts, steers, set_model), the sink's done/failed/incidents (worker ids scrubbed) and a whole-DB dump with the R4
// decision rows removed (clocks relabelled by order, ids scrubbed). The R4 rows are REQUIRED EXACTLY on the new side: [entry, verdict, reason, the submitted
// run, null], plus exact per-entry recorder call counts and exact behaviour facts (so a scenario that silently stopped reaching its branch fails too). The
// old build must hold none. P15: no item intakes more than 5 runs (the gateway admits 5 per actor per minute and the counting clock cannot step one).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISTS, R4_IDS, NEW_ROW_IDS, canon, compare, dumpDb, mkStore, mkTemp, regularTables, extraDropFilter, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { NOW, withCountingClock, withPinnedEnv } from "../stage4-intake-fixture.mjs";
import { countingRecorder } from "../stage4-sender-fixture.mjs";
import { cleanup, fakeSession, intakeRun, mkSupervisor, req, until, untilState } from "../stage4-supervisor-fixture.mjs";

const ROLES = { default: ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium"], fast: ["anthropic/claude-sonnet-5-5:low"], thinking: ["anthropic/claude-opus-5-5:high"] };
const routed = (role) => ({ triage: async () => ({ kind: "fallthrough", route: { role, effort: null, verdict_id: "jv_1" } }) });

/** One turn through the supervisor, to idle. */
async function turn(x, sup, name, text = "hi") { const id = x.run(name, text); sup.submit(req(id, text)); await sup.whenIdle(); return id; }
/** A child whose prompts answer with errors[i] (an assistant error frame), then "ok"; `pre(emit)` runs first in every prompt (a tool frame). */
function failing(errors, { pre, always } = {}) {
  let calls = 0; let s;
  s = fakeSession({ onPrompt: (_t, emit) => {
    emit({ type: "turn_start" }); pre?.(emit);
    const err = always ?? errors[calls++];
    if (err) emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 2 }, stopReason: "error", errorMessage: err } });
    else s.assistant("ok");
    emit({ type: "agent_end" });
  } });
  return s;
}
const failStarts = async (x, sup, script, n, from = 1) => { for (let i = 0; i < n; i += 1) await turn(x, sup, `t${from + i}`); return script; };

// crash guard ---------------------------------------------------------------------------------------------------------------------------------------------
const crashLimit = async (x) => { const script = { failStart: true }; const { sup } = x.mk({ session: fakeSession(script) }); await failStarts(x, sup, script, 3); await turn(x, sup, "d"); };
const crashLatched = async (x) => { const script = { failStart: true }; const { sup } = x.mk({ session: fakeSession(script) }); await failStarts(x, sup, script, 3); await turn(x, sup, "d"); await turn(x, sup, "e"); };
const crashReset = async (x) => {
  const script = { failStart: true }; const { sup } = x.mk({ session: fakeSession(script) });
  await failStarts(x, sup, script, 3); await turn(x, sup, "d"); sup.resetCrashGuard(); script.failStart = false; await turn(x, sup, "e");
};
const readyExits = async (x) => {
  const session = fakeSession(); const { sup } = x.mk({ session });
  for (const n of ["a", "b", "c"]) { await turn(x, sup, n); session.exit(1); await untilState(sup, "STOPPED"); }
  await turn(x, sup, "d");
};
const laneLatched = async (x) => {
  const script = { failStart: true };
  const { sup } = x.mk({ session: fakeSession(script), extra: { triage: async (i) => (i.text === "lane" ? { kind: "lane_reply", text: "lane text", buttons: [] } : { kind: "fallthrough" }) } });
  await failStarts(x, sup, script, 3); await turn(x, sup, "d"); await turn(x, sup, "L", "lane");
};
const twoFailsThenGood = async (x) => { const script = { failStart: true }; const { sup } = x.mk({ session: fakeSession(script) }); await failStarts(x, sup, script, 2); script.failStart = false; await turn(x, sup, "c"); };
const claimedElsewhere = async (x) => {
  const { sup } = x.mk(); sup.crashLatched = true; // the latch is a plain JS property on the dist object
  const id = x.run("a", "hi"); if (!x.store.claimRun(id, "other", 120)) throw new Error("pre-claim failed");
  sup.submit(req(id, "hi")); await sup.whenIdle();
};
/** P9: the natural late consult takes over 10 s of real time and cannot latch alone; drive the seam: three recent exits seeded, ensureSession(true, a finished turn). */
const lateConsult = async (x) => {
  const { sup } = x.mk(); const t = Date.now(); sup.exits = [t, t, t];
  const r = await sup.ensureSession(true, { finished: true, req: { run_id: "late" } });
  if (r !== "crash_loop") throw new Error(`late consult returned ${r}, wanted crash_loop`);
  await turn(x, sup, "a");
};
/** The natural interleaving (spec §6), pinned as it really runs (real timers, ~20 s): lane turns A and B, A's warm start held. A's lane waits 5 s, stopSession bumps the gen, and
 *  awaitStart's `superseded` race ends that start AT ONCE although the hold is pending, so startInFlight clears: A completes, B's warm ensureSession finds nothing to join and
 *  makes its OWN consult while B is unfinished (spawn, no row), its start held and superseded the same way; releasing the hold afterwards consults nothing. No finished-turn
 *  consult occurs naturally (hence the seam item above, P9): this item pins that no row appears for B and that exactly two consults are made. */
const lateNatural = async (x) => {
  let release; const gate = new Promise((r) => { release = r; });
  const { sup, outcome } = x.mk({ session: fakeSession({ holdStart: gate }), extra: { triage: async () => ({ kind: "lane_reply", text: "lane text", buttons: [] }) } });
  const a = x.run("a", "lane a"); sup.submit(req(a, "lane a")); await until(() => outcome.done.length === 1, 30_000);
  const b = x.run("b", "lane b"); sup.submit(req(b, "lane b")); await until(() => outcome.done.length === 2, 30_000);
  release(); await sup.whenIdle();
};

// retry ---------------------------------------------------------------------------------------------------------------------------------------------------
const withRoles = (drive) => async (x) => drive({ ...x, mk: (o = {}) => x.mk({ roles: ROLES, ...o }) });
const quotaThenOk = withRoles(async (x) => { const { sup } = x.mk({ session: failing(["429 quota"]) }); await turn(x, sup, "a"); });
const timeoutExhausted = withRoles(async (x) => { const { sup } = x.mk({ session: failing([], { always: "request timed out" }) }); await turn(x, sup, "a"); });
const otherUnrouted = withRoles(async (x) => { const { sup } = x.mk({ session: failing(["something odd"]) }); await turn(x, sup, "a"); });
const otherRoutedTwice = withRoles(async (x) => { const { sup } = x.mk({ session: failing(["something odd", "something odd"]), extra: routed("default") }); await turn(x, sup, "a"); });
const otherAfterTool = withRoles(async (x) => {
  const { sup } = x.mk({ session: failing(["something odd"], { pre: (e) => e({ type: "tool_execution_start" }) }), extra: routed("fast") }); await turn(x, sup, "a");
});
const otherAfterTodo = withRoles(async (x) => {
  const { sup } = x.mk({ session: failing(["something odd"], { pre: (e) => e({ type: "tool_execution_start", toolName: "todo" }) }), extra: routed("fast") }); await turn(x, sup, "a");
});
const modelRefusal = withRoles(async (x) => { const { sup } = x.mk({ session: failing(["model refusal"]) }); await turn(x, sup, "a"); });
const asyncOnly = withRoles(async (x) => {
  const s = fakeSession({ onPrompt: (_t, emit) => {
    emit({ type: "turn_start" });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 2 }, stopReason: "error", errorMessage: "429 usage limit reached" } });
    emit({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
  } });
  const { sup } = x.mk({ session: s }); await turn(x, sup, "a");
});
const fastStepUp = withRoles(async (x) => { const { sup } = x.mk({ session: failing(["429 quota", "429 quota"]), extra: routed("fast") }); await turn(x, sup, "a"); });

const CG = "planner.crash_guard"; const SQ = "intake.steer_or_queue"; const TR = "turn.retry"; const LS = "context.lessons"; const CC = "turn.clarify_cap"; const TM = "turn.model"; // R5: one LS per spawn attempt that reaches preparePaths (none after a halt), one CC per live buildTurnPrompt (P4)
const M = (verdict, reason, run = "a") => [TM, verdict, reason, run]; // R6: turn.model rows are written only when non-default (a fallback / held / none verdict), at each pin-walk consult
const H = (reason, run) => [CG, "halt", reason, run]; const T = (verdict, reason, run = "a") => [TR, verdict, reason, run];
const RN = "RETRY_NOTE"; const OPUS = "set_model:anthropic/claude-opus-5-5";
const FAILED_START = (n) => Array(n).fill("planner_start_failed");
// facts: the behaviour the scenario must reach, exact (kinds of incidents, the sink's calls, the ordered child log with RETRY_NOTE named).
const ITEMS = [
  { key: "crash_limit", tags: ["limit"], drive: crashLimit, rows: [H("limit_reached", "d")], calls: { [CG]: 4, [SQ]: 4, [LS]: 3 },
    facts: { done: [], failed: ["t1:planner_exit:start_failed: fixture start failed", "t2:planner_exit:start_failed: fixture start failed", "t3:planner_exit:start_failed: fixture start failed", "d:planner_exit:crash_loop"], incidents: [...FAILED_START(3), "planner_crash_loop"], log: [] } },
  { key: "crash_latched", tags: ["latched"], drive: crashLatched, rows: [H("limit_reached", "d"), H("latched", "e")], calls: { [CG]: 5, [SQ]: 5, [LS]: 3 },
    facts: { done: [], failed: ["t1:planner_exit:start_failed: fixture start failed", "t2:planner_exit:start_failed: fixture start failed", "t3:planner_exit:start_failed: fixture start failed", "d:planner_exit:crash_loop", "e:planner_exit:crash_loop"], incidents: [...FAILED_START(3), "planner_crash_loop"], log: [] } },
  { key: "crash_reset", tags: ["reset"], drive: crashReset, rows: [H("limit_reached", "d")], calls: { [CG]: 5, [SQ]: 5, [LS]: 4, [CC]: 1, [TM]: 1 },
    facts: { done: ["e:answer"], failed: ["t1:planner_exit:start_failed: fixture start failed", "t2:planner_exit:start_failed: fixture start failed", "t3:planner_exit:start_failed: fixture start failed", "d:planner_exit:crash_loop"], incidents: [...FAILED_START(3), "planner_crash_loop"], log: [OPUS, "prompt:hi"] } },
  { key: "ready_exits", tags: ["ready_exit"], drive: readyExits, rows: [H("limit_reached", "d")], calls: { [CG]: 4, [SQ]: 4, [LS]: 3, [CC]: 3, [TM]: 3 },
    facts: { done: ["a:answer", "b:answer", "c:answer"], failed: ["d:planner_exit:crash_loop"], incidents: ["planner_crash_loop"], log: [OPUS, "prompt:hi", OPUS, "prompt:hi", OPUS, "prompt:hi"] } },
  { key: "lane_while_latched", tags: ["lane"], drive: laneLatched, rows: [H("limit_reached", "d"), H("latched", "L")], calls: { [CG]: 5, [SQ]: 5, [LS]: 3 },
    facts: { done: ["L:lane text"], failed: ["t1:planner_exit:start_failed: fixture start failed", "t2:planner_exit:start_failed: fixture start failed", "t3:planner_exit:start_failed: fixture start failed", "d:planner_exit:crash_loop"], incidents: [...FAILED_START(3), "planner_crash_loop"], log: [] } },
  { key: "two_fails_then_good", tags: ["below_limit"], drive: twoFailsThenGood, rows: [], calls: { [CG]: 3, [SQ]: 3, [LS]: 3, [CC]: 1, [TM]: 1 },
    facts: { done: ["c:answer"], failed: ["t1:planner_exit:start_failed: fixture start failed", "t2:planner_exit:start_failed: fixture start failed"], incidents: FAILED_START(2), log: [OPUS, "prompt:hi"] } },
  { key: "claimed_elsewhere_latched", tags: ["claimed"], drive: claimedElsewhere, rows: [], calls: {},
    facts: { done: [], failed: [], incidents: [], log: [] } },
  { key: "late_consult", tags: ["late"], drive: lateConsult, rows: [H("latched", "a")], calls: { [CG]: 1, [SQ]: 1 },
    facts: { done: [], failed: ["a:planner_exit:crash_loop"], incidents: ["planner_crash_loop"], log: [] } },
  { key: "late_consult_natural", tags: ["late_natural"], drive: lateNatural, rows: [], calls: { [CG]: 2, [SQ]: 2, [LS]: 2 },
    facts: { done: ["a:lane text", "b:lane text"], failed: [], incidents: [], log: [] } },
  { key: "quota_then_ok", tags: ["quota"], drive: quotaThenOk, rows: [T("retry", "quota"), M("fallback", "next_leg")], calls: { [CG]: 1, [SQ]: 1, [TR]: 1, [LS]: 1, [CC]: 1, [TM]: 2 },
    facts: { done: ["a:ok"], failed: [], incidents: [], log: ["set_model:anthropic/claude-opus-5-5", "prompt:hi", "set_model:google-antigravity/claude-opus-4-6", `prompt:${RN}`] } },
  { key: "timeout_every_leg", tags: ["timeout"], drive: timeoutExhausted, rows: [T("retry", "timeout"), M("fallback", "next_leg"), T("retry", "timeout"), M("none", "no_leg")], calls: { [CG]: 1, [SQ]: 1, [TR]: 2, [LS]: 1, [CC]: 1, [TM]: 3 },
    facts: { done: [], failed: ["a:no_planner_leg:timeout"], incidents: ["planner_no_leg"], log: ["set_model:anthropic/claude-opus-5-5", "prompt:hi", "set_model:google-antigravity/claude-opus-4-6", `prompt:${RN}`] } },
  { key: "other_unrouted", tags: ["other"], drive: otherUnrouted, rows: [T("final", "other_unrouted")], calls: { [CG]: 1, [SQ]: 1, [TR]: 1, [LS]: 1, [CC]: 1, [TM]: 1 },
    facts: { done: [], failed: ["a:model_error:other"], incidents: [], log: ["set_model:anthropic/claude-opus-5-5", "prompt:hi"] } },
  { key: "other_routed_twice", tags: ["other_retried"], drive: otherRoutedTwice, rows: [T("retry", "other_once"), M("fallback", "next_leg"), T("final", "other_retried")], calls: { [CG]: 1, [SQ]: 1, [TR]: 2, [LS]: 1, [CC]: 1, [TM]: 2 },
    facts: { done: [], failed: ["a:model_error:other"], incidents: [], log: ["set_model:anthropic/claude-opus-5-5", "prompt:hi", "set_model:google-antigravity/claude-opus-4-6", `prompt:${RN}`] } },
  { key: "other_after_tool", tags: ["other_tool"], drive: otherAfterTool, rows: [T("final", "other_after_tool")], calls: { [CG]: 1, [SQ]: 1, [TR]: 1, [LS]: 1, [CC]: 1, [TM]: 1 },
    facts: { done: [], failed: ["a:model_error:other"], incidents: [], log: ["set_model:anthropic/claude-sonnet-5-5", "prompt:hi"] } },
  { key: "other_after_todo", tags: ["other_todo"], drive: otherAfterTodo, rows: [T("retry", "other_once"), M("fallback", "stepped_up")], calls: { [CG]: 1, [SQ]: 1, [TR]: 1, [LS]: 1, [CC]: 1, [TM]: 2 },
    facts: { done: ["a:ok"], failed: [], incidents: [], log: ["set_model:anthropic/claude-sonnet-5-5", "prompt:hi", OPUS, `prompt:${RN}`] } },
  { key: "model_refusal", tags: ["refusal"], drive: modelRefusal, rows: [T("final", "model_refusal")], calls: { [CG]: 1, [SQ]: 1, [TR]: 1, [LS]: 1, [CC]: 1, [TM]: 1 },
    facts: { done: [], failed: ["a:model_error:model_refusal"], incidents: [], log: ["set_model:anthropic/claude-opus-5-5", "prompt:hi"] } },
  { key: "async_work_only_end", tags: ["async"], drive: asyncOnly, rows: [], calls: { [CG]: 1, [SQ]: 1, [LS]: 1, [CC]: 1, [TM]: 1 },
    facts: { done: [], failed: ["a:model_error:quota"], incidents: ["planner_async_wait"], log: ["set_model:anthropic/claude-opus-5-5", "prompt:hi"] } },
  { key: "fast_quota_step_up", tags: ["step_up"], drive: fastStepUp, rows: [T("retry", "quota"), M("fallback", "stepped_up"), T("retry", "quota"), M("fallback", "next_leg")], calls: { [CG]: 1, [SQ]: 1, [TR]: 2, [LS]: 1, [CC]: 1, [TM]: 3 },
    facts: { done: ["a:ok"], failed: [], incidents: [], log: ["set_model:anthropic/claude-sonnet-5-5", "prompt:hi", "set_model:anthropic/claude-opus-5-5", `prompt:${RN}`, "set_model:google-antigravity/claude-opus-4-6", `prompt:${RN}`] } }
];
const BRANCHES = ["limit", "latched", "reset", "ready_exit", "lane", "below_limit", "claimed", "late", "late_natural", "quota", "timeout", "other", "other_retried", "other_tool", "other_todo", "refusal", "async", "step_up"];

const all = (store, sql) => store.db.prepare(sql).all().map((r) => ({ ...r }));
const isClockKey = (k) => /(_at|_since|^since|^now)$/.test(k);
const idList = R4_IDS.map((i) => `'${i}'`).join(",");
// P16 (R6): every row the new build records and this pair's old build cannot is dropped at the dump, so a non-default R6 row never shifts a clock label before compare strips it.
const dropIds = [...NEW_ROW_IDS.r4];
const dropList = dropIds.map((i) => `'${i}'`).join(",");

// Coverage self-test: the dump must hold, per table, exactly the rows the DB holds (minus the intentionally dropped R4 decisions rows),
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
  const dir = mkTemp(`supervision-${item.key}`);
  let store = null;
  try {
    return await withPinnedEnv(join(dir, "pin"), () => withCountingClock(NOW, async () => {
      store = mkStore(d, "bare", join(dir, "supervision.sqlite"));
      const isNew = d.dir === DISTS.new;
      const names = new Map();
      const counting = isNew ? countingRecorder(d.storeRecorder(store)) : null;
      let rig = null;
      const x = {
        d, store,
        run: (name, text) => { const id = intakeRun(d, store, text, name); names.set(id, name); return id; },
        mk: (opts = {}) => { rig = mkSupervisor(d, store, { ...opts, ...(counting ? { recorder: counting.recorder } : {}) }); return rig; }
      };
      const seedMax = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
      try { await item.drive(x); } finally { await cleanup(); }
      const label = (id) => names.get(id) ?? id;
      const order = [...names.keys()]; const foreign = new Map();
      const ownerLabel = (id) => (order.includes(id) ? `r${order.indexOf(id) + 1}` : foreign.has(id) ? foreign.get(id) : (foreign.set(id, `other#${foreign.size + 1}`), foreign.get(id)));
      const newRows = all(store, `SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ${Number(seedMax)} AND entry_id IN (${idList}, 'turn.model') ORDER BY rowid`)
        .map((r) => [r.entry_id, r.verdict, r.reason_code, label(r.run_id), r.tool_call_id]);
      if (!isNew && newRows.length) throw new Error("control failed: the old build wrote planner.crash_guard / turn.retry rows");
      if (existsSync(join(process.cwd(), "houge.kill"))) throw new Error("P2 failed: a houge.kill appeared in the cwd");
      const db = dumpDb(store, { dropDecisionIds: dropIds });
      const want = tableCounts(store);
      checkCoverage(db, want);
      omittedRowSelfTest(db, want);
      const { session, outcome } = rig;
      const agreement = durationDisagreements(store, outcome.done, label);
      const seen = (list) => list.map(({ run_id, ...rest }) => ({ ...rest, ...("duration_ms" in rest ? { duration_ms: durationClass(rest.duration_ms) } : {}), run_id: label(run_id), run_label: ownerLabel(run_id) }));
      const observed = { log: session.log, done: seen(outcome.done), failed: seen(outcome.failed), incidents: outcome.incidents, db: classDurations(labelRunOwners(db, ownerLabel)) };
      const facts = { done: outcome.done.map((o) => `${label(o.run_id)}:${o.text}`), failed: outcome.failed.map((o) => `${label(o.run_id)}:${o.error_type}:${o.error_ref}`), incidents: outcome.incidents.map((i) => i.k), log: logFacts(d, session.log) };
      return { ...scrubWorkers(scrubIds(relabelClocks(observed, isClockKey))), newRows, calls: counting?.calls ?? {}, agreement, facts, __strip: ["newRows", "calls", "agreement", "facts"] };
    }));
  } finally { try { store?.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  requireNew(corpus, item, "emitted duration_ms equals the stored run_completed payload (exact)", proj.agreement.length === 0, `disagreements ${canon(proj.agreement)}`);
  const want = item.rows.map(([entry, verdict, reason, run]) => [entry, verdict, reason, run, null]);
  requireNew(corpus, item, "R4 rows and the R6 turn.model rows (exact: entry, verdict, reason, the consulting run, tool_call null)", canon(proj.newRows) === canon(want), `got ${canon(proj.newRows)}, want ${canon(want)}`);
  requireNew(corpus, item, "recorder calls per entry (exact)", canon(proj.calls) === canon(item.calls), `got ${canon(proj.calls)}, want ${canon(item.calls)}`);
  requireNew(corpus, item, "behaviour facts (sink calls, incidents, ordered child log: exact)", canon(proj.facts) === canon(item.facts), `got ${canon(proj.facts)}, want ${canon(item.facts)}`);
}

// Determinism self-test: the same item twice on the new build must project identically, or the old/new comparison would flag its own noise.
async function load(ctx) {
  const first = ITEMS.find((i) => i.key === "other_routed_twice");
  const [a, b] = [await project(ctx.dists.new, first), await project(ctx.dists.new, first)];
  const diff = compare(corpus, first, a, b, corpus.pairs[0]);
  if (diff) throw new Error(`determinism self-test: two runs of one item project differently: ${diff.diff}`);
  return ITEMS;
}

const corpus = { name: "supervision", pairs: [["r4", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required };
export default corpus;
