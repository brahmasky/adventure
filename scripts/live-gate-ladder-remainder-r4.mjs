#!/usr/bin/env node
// Live gate — decision ladder remainder R4, planner.crash_guard + turn.retry (spec 2026-11-01 R4 §7; plan Task 5).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/live-gate-ladder-remainder-r4.mjs [--live-db <path>]
// Eight lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all eight PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. Only counts, booleans, codes and run labels are printed, never message text or any id of the live DB.
// The live DB is opened read-only, once, by VACUUM INTO a temp copy under /tmp/hg-s4d-*, removed on every exit path (finally,
// SIGINT, SIGTERM, SIGHUP). No env file is loaded (HOUGE_ENV_FILE only locates the DB); there is no real omp child (a fake session over the
// dist PlannerSupervisor, and tests/fixtures/fake-omp.mjs for line 6) and no Telegram client at all, so nothing leaves the machine. Safety pins,
// set before any store opens and restored on exit:
//   HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root (P2: nothing here intakes `kill`, but the pin makes it unable to stop the LIVE daemon),
//   HOUGE_TELEGRAM_CHAT_ID = -1003 (P3: a numeric id that is not a real chat; line 7's decision_record_failed alerts must not page Paco),
//   the omp, scheduler, radar, media variables deleted (an armed ambient flag sends unrelated operator alerts).
// Clock: no counting clock anywhere; every intake gets the wall clock. Every run is its own actor (P20: the gateway admits 5 Telegram runs per actor per minute) except line 4's chain: its first five runs share one synthetic actor, the sixth and seventh a second. Notify chat -1003.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, canon, cleanupTemp, initTemp, loadDist, redactForPrint } from "./stage4-diff-lib.mjs";
import { countingRecorder } from "./stage4-sender-fixture.mjs";
import { cleanup, fakeSession, mkSupervisor, req } from "./stage4-supervisor-fixture.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const FAKE_OMP = resolve(new URL("../tests/fixtures/fake-omp.mjs", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const STUB_CHAT = "-1003"; // numeric (CoreWorker refuses a non-numeric chat id before submit), not a real chat
const CG = "planner.crash_guard"; const TR = "turn.retry";
const IDS = [CG, TR];
const BIG = 1_000_000_000; // caps no real copy reaches
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES",
  "HOUGE_OMP_SANDBOX", "HOUGE_OMP_ENV_PASSTHROUGH", "HOUGE_MODEL_ROLES", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"];
// Rows this gate writes before line 8 (a faulted or thrown record never lands; line 7 writes none):
//   turn.retry = line 1 quota (1) + line 2 refusal (1) + line 3 other x2 (2) + line 6 quota (1); planner.crash_guard = line 4 (limit_reached, latched) + line 6 (limit_reached).
const WROTE = { [TR]: 5, [CG]: 3 };
const out = [];
const G = { d: null, root: null, base: null, store: null, saved: null, work: null, n: 0, clean: {}, priorAt: {} };
const note = (s) => console.error(`# ${s}`);
const wall = () => new Date().toISOString();
const countOf = (sql, ...args) => G.store.db.prepare(sql).get(...args).n;
const all = (sql, ...args) => G.store.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const idRows = (id) => countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", id);
const decisionMark = () => G.store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
const outboxN = () => countOf("SELECT COUNT(*) AS n FROM notification_outbox");
const gateway = () => new G.d.Gateway(G.store, { ...G.d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG });
const IDS_SQL = IDS.map((i) => `'${i}'`).join(",");

function verdict(n, name, ok, detail) {
  out.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${name} — ${redactForPrint(detail)}`);
}
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError"]);
/** A thrown value prints as its standard class name only, never its message. */
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");
async function runLine(n, name, fn) {
  try { const r = await fn(); verdict(n, name, r.ok, r.detail); } catch (e) { verdict(n, name, false, `threw: ${errCode(e)}`); }
}
/** console.error captured (not printed) while `fn` runs; the lines are returned for counting, never echoed. */
async function captured(fn) {
  const real = console.error; const seen = [];
  console.error = (...a) => { seen.push(a.map(String).join(" ")); };
  try { return { value: await fn(), seen }; } finally { console.error = real; }
}

// ---- the live-DB copy ----
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** VACUUM INTO `to` from `from` (read-only source). The daemon writes the live DB: a lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
/** Marks every non-final outbox row of the COPY failed_terminal (the copy is disposable); returns how many. */
const parkOutbox = () => G.store.db.prepare("UPDATE notification_outbox SET state = 'failed_terminal' WHERE state NOT IN ('delivered', 'failed_terminal')").run().changes;

// ---- a supervisor scenario over the copy ----
const ROLES = { default: ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium"], fast: ["anthropic/claude-sonnet-5-5:low"], thinking: ["anthropic/claude-opus-5-5:high"] };
const routed = (role) => ({ triage: async () => ({ kind: "fallthrough", route: { role, effort: null, verdict_id: "jv_1" } }) });
const RETRY_PREFIX = "(The previous model was unavailable.";
const OPUS = "set_model:anthropic/claude-opus-5-5"; const ALT = "set_model:google-antigravity/claude-opus-4-6";
/** One fresh Telegram turn run on the copy. `actor` defaults to its own (the gateway admits 5 per actor per minute); notify chat -1003. */
function mkRun(text, actor) {
  G.n += 1;
  const r = gateway().intake(G.d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: actor ?? `gate-r4-actor-${G.n}` },
    notify: { kind: "telegram", chat_id: STUB_CHAT }, idempotency_key: `gate-r4:${G.n}`, source_reference: `telegram:update:${G.n}:message:${G.n}` }));
  if (!r.ok) throw new Error("gate: run intake refused");
  return r.run_id;
}
/** A child whose prompts answer with errors[i] (an assistant error frame), then "ok"; `pre(emit)` runs first in every prompt (a tool frame). */
function failing(errors, { pre } = {}) {
  let calls = 0; let s;
  s = fakeSession({ onPrompt: (_t, emit) => {
    emit({ type: "turn_start" }); pre?.(emit);
    const err = errors[calls++];
    if (err) emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 2 }, stopReason: "error", errorMessage: err } });
    else s.assistant("ok");
    emit({ type: "agent_end" });
  } });
  return s;
}
const logFacts = (log) => log.map(([k, v]) => (k === "prompt" ? `prompt:${v.startsWith(RETRY_PREFIX) ? "RETRY_NOTE" : v}` : `${k}:${v}`));

/**
 * drive(x): x.run(name, text, actor?) makes a run, x.mk(opts) the supervisor (recorder: the counting wrap over `recorder`, default the store recorder).
 * Returns what the scenario did: the child's ordered log, the sink's done/failed/incident kinds, the R4 rows by run label, the recorder tally, per-run state, outbox delta.
 */
async function scenario(drive, { recorder } = {}) {
  const names = new Map(); const mark = decisionMark(); const out0 = outboxN();
  const counting = countingRecorder(recorder ?? G.d.storeRecorder(G.store));
  let rig = null;
  const x = { store: G.store,
    run: (name, text, actor) => { const id = mkRun(text, actor); names.set(id, name); return id; },
    mk: (opts = {}) => { rig = mkSupervisor(G.d, G.store, { ...opts, recorder: counting.recorder }); return rig; },
    resetCrashGuard: () => rig.sup.resetCrashGuard() };
  try { await drive(x); } finally { await cleanup(); }
  const label = (id) => names.get(id) ?? "?";
  const rows = all(`SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ? AND entry_id IN (${IDS_SQL}) ORDER BY rowid`, mark)
    .map((r) => [r.entry_id, r.verdict, r.reason_code, label(r.run_id), r.tool_call_id]);
  const perRun = {};
  for (const [id, name] of names) perRun[name] = { completed: G.store.getLedgerEvents(id).filter((e) => e.event_type === "run_completed").length, state: G.store.getRunState(id) };
  const o = rig.outcome;
  return { log: logFacts(rig.session.log), done: o.done.map((c) => `${label(c.run_id)}:${c.text}`), failed: o.failed.map((c) => `${label(c.run_id)}:${c.error_type}:${c.error_ref}`),
    incidents: o.incidents.map((i) => i.k), rows, calls: counting.calls, perRun, outbox: outboxN() - out0, label };
}
/** `run:error_type` of each failed run: the error_ref is never printed. */
const failedCodes = (s) => s.failed.map((f) => f.split(":").slice(0, 2).join(":")).join(",");
const strs = (rows) => rows.map((r) => `${r[0] === CG ? "cg" : "tr"}:${r[1]}/${r[2]}@${r[3]}`);
const rowsOf = (s, id) => s.rows.filter((r) => r[0] === id);
const count = (arr, v) => arr.filter((x) => x === v).length;
const toolCallNull = (s) => s.rows.every((r) => r[4] === null);
/** What the run did, with nothing about the decision rows in it: the line-7 comparison between a clean run and a faulted one. */
const effects = (s) => canon({ log: s.log, done: s.done, failed: s.failed, incidents: s.incidents, perRun: s.perRun, outbox: s.outbox });

// ---- the scenarios ----
const turn = async (x, sup, name, text = "hi", actor) => { const id = x.run(name, text, actor); sup.submit(req(id, text)); await sup.whenIdle(); return id; };
const quotaScenario = async (x) => { const { sup } = x.mk({ roles: ROLES, session: failing(["429 quota"]) }); await turn(x, sup, "a"); };
const refusalScenario = async (x) => { const { sup } = x.mk({ roles: ROLES, session: failing(["model refusal"]) }); await turn(x, sup, "a"); };
const otherTwiceScenario = async (x) => { const { sup } = x.mk({ roles: ROLES, session: failing(["something odd", "something odd"]), extra: routed("default") }); await turn(x, sup, "a"); };
const cleanScenario = async (x) => { const { sup } = x.mk({ roles: ROLES }); await turn(x, sup, "a"); };
/** Three failed starts, the 4th run is halted (limit_reached, one incident), the 5th is latched, then a reset and two turns spawn: 7 runs, the 6th and 7th under a second actor (P20). */
const chainScenario = (prefix) => async (x) => {
  const script = { failStart: true }; const { sup } = x.mk({ session: fakeSession(script) });
  const A = `${prefix}-a`; const B = `${prefix}-b`;
  for (const n of ["t1", "t2", "t3", "d", "e"]) await turn(x, sup, n, "hi", A);
  x.resetCrashGuard(); script.failStart = false;
  await turn(x, sup, "f", "hi", B); await turn(x, sup, "g", "hi", B);
};
const FAILED_START = "t1:planner_exit:start_failed: fixture start failed";
const failedStartsOf = (n) => ["t1", "t2", "t3"].slice(0, n).map((t) => FAILED_START.replace("t1", t));

// ---- line 1: quota -> one retry/quota row, RETRY_NOTE once, completed once ----
async function line1() {
  const s = await scenario(quotaScenario); G.clean.quota = s;
  const want = [[TR, "retry", "quota", "a", null]];
  const ok = canon(s.rows) === canon(want) && count(s.log, "prompt:RETRY_NOTE") === 1 && canon(s.log) === canon([OPUS, "prompt:hi", ALT, "prompt:RETRY_NOTE"]) && canon(s.done) === canon(["a:ok"]) && s.failed.length === 0
    && s.perRun.a.completed === 1 && s.perRun.a.state === "completed" && s.calls[TR] === 1 && s.calls[CG] === 1 && toolCallNull(s);
  return { ok, detail: `rows ${s.rows.length} [${strs(s.rows)}] (want 1 [tr:retry/quota@a]) · RETRY_NOTE prompts ${count(s.log, "prompt:RETRY_NOTE")} (want 1) · child log ${s.log.length} entries (want 4: set_model, prompt, set_model, RETRY_NOTE) exact ${canon(s.log) === canon([OPUS, "prompt:hi", ALT, "prompt:RETRY_NOTE"])} · done ${s.done.length} (want 1) failed ${s.failed.length} (want 0) · run_completed ${s.perRun.a.completed} (want 1) state ${s.perRun.a.state} · consults retry ${s.calls[TR]} (want 1) crash_guard ${s.calls[CG]} (want 1) · tool_call null ${toolCallNull(s)}` };
}

// ---- line 2: model_refusal is final ----
async function line2() {
  const s = await scenario(refusalScenario);
  const want = [[TR, "final", "model_refusal", "a", null]];
  const ok = canon(s.rows) === canon(want) && canon(s.failed) === canon(["a:model_error:model_refusal"]) && s.done.length === 0 && canon(s.log) === canon([OPUS, "prompt:hi"]) && s.perRun.a.state === "failed" && s.calls[TR] === 1;
  return { ok, detail: `rows ${s.rows.length} [${strs(s.rows)}] (want 1 [tr:final/model_refusal@a]) · failed ${failedCodes(s)} (want a:model_error) · done ${s.done.length} (want 0) · prompts ${count(s.log, "prompt:hi")} + RETRY_NOTE ${count(s.log, "prompt:RETRY_NOTE")} (want 1 + 0) · a ${s.perRun.a.state} (want failed) · consults ${s.calls[TR]} (want 1)` };
}

// ---- line 3: a routed 'other' error retries once, then is final ----
async function line3() {
  const s = await scenario(otherTwiceScenario);
  const want = [[TR, "retry", "other_once", "a", null], [TR, "final", "other_retried", "a", null]];
  const ok = canon(s.rows) === canon(want) && canon(s.failed) === canon(["a:model_error:other"]) && s.done.length === 0 && canon(s.log) === canon([OPUS, "prompt:hi", ALT, "prompt:RETRY_NOTE"]) && s.calls[TR] === 2 && s.perRun.a.state === "failed";
  return { ok, detail: `rows ${s.rows.length} [${strs(s.rows)}] (want 2 [tr:retry/other_once@a, tr:final/other_retried@a]) · failed ${failedCodes(s)} (want a:model_error) · RETRY_NOTE prompts ${count(s.log, "prompt:RETRY_NOTE")} (want 1) · child log exact ${canon(s.log) === canon([OPUS, "prompt:hi", ALT, "prompt:RETRY_NOTE"])} · consults ${s.calls[TR]} (want 2) · a ${s.perRun.a.state} (want failed)` };
}

// ---- line 4: the crash chain: halt/limit_reached once, halt/latched, a reset, zero new rows ----
async function line4() {
  const s = await scenario(chainScenario("gate-r4-l4")); G.clean.chain = s;
  const want = [[CG, "halt", "limit_reached", "d", null], [CG, "halt", "latched", "e", null]];
  const wantFailed = [...failedStartsOf(3), "d:planner_exit:crash_loop", "e:planner_exit:crash_loop"];
  const wantIncidents = ["planner_start_failed", "planner_start_failed", "planner_start_failed", "planner_crash_loop"];
  const ok = canon(s.rows) === canon(want) && canon(s.failed) === canon(wantFailed) && canon(s.incidents) === canon(wantIncidents) && count(s.incidents, "planner_crash_loop") === 1
    && canon(s.done) === canon(["f:answer", "g:answer"]) && canon(s.log) === canon([OPUS, "prompt:hi", "prompt:hi"]) && s.calls[CG] === 6 && s.calls[TR] === undefined
    && s.perRun.f.state === "completed" && s.perRun.g.state === "completed" && rowsOf(s, CG).every((r) => !["f", "g"].includes(r[3])) && toolCallNull(s);
  return { ok, detail: `rows ${s.rows.length} [${strs(s.rows)}] (want 2 [cg:halt/limit_reached@d, cg:halt/latched@e]) · planner_crash_loop incidents ${count(s.incidents, "planner_crash_loop")} (want 1) of ${s.incidents.length} (want 4) · failed ${s.failed.length} (want 5: three failed starts, d, e) exact ${canon(s.failed) === canon(wantFailed)} · after reset f,g done ${s.done.length} (want 2) states ${s.perRun.f.state}/${s.perRun.g.state} (want completed/completed) · rows for f,g ${s.rows.filter((r) => ["f", "g"].includes(r[3])).length} (want 0) · child log exact ${canon(s.log) === canon([OPUS, "prompt:hi", "prompt:hi"])} (one spawn, two prompts) · consults crash_guard ${s.calls[CG]} (want 6: t1 t2 t3 d e f; g finds the child ready) retry ${s.calls[TR] ?? 0} (want 0) · runs ${s.label ? Object.keys(s.perRun).length : 0} (want 7)` };
}

// ---- line 5: a clean turn writes nothing for either id ----
async function line5() {
  const s = await scenario(cleanScenario);
  const ok = s.rows.length === 0 && canon(s.done) === canon(["a:answer"]) && s.failed.length === 0 && canon(s.log) === canon([OPUS, "prompt:hi"]) && s.calls[CG] === 1 && s.calls[TR] === undefined && s.perRun.a.completed === 1;
  return { ok, detail: `rows for ${CG} ${rowsOf(s, CG).length} and ${TR} ${rowsOf(s, TR).length} (want 0, 0) · consults crash_guard ${s.calls[CG]} (want 1: the spawn) retry ${s.calls[TR] ?? 0} (want 0) · done ${s.done.length} (want 1) failed ${s.failed.length} (want 0) · run_completed ${s.perRun.a.completed} (want 1) · child log exact ${canon(s.log) === canon([OPUS, "prompt:hi"])}` };
}

// ---- line 6: the production wiring, CoreWorker.submitTurn on the fake omp ----
const argvPrompts = (argvLog) => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l?.cmd?.type === "prompt").length;
/** One CoreWorker (fresh planner) on the fake omp with `scenario`; `body(worker, rowsSince)` drives it; the env is restored after. */
async function withWorker(scenarioObj, tag, body) {
  const scenFile = join(G.root, `scenario-${tag}.json`); const argvLog = join(G.root, `argv-${tag}.log`);
  writeFileSync(scenFile, JSON.stringify(scenarioObj));
  Object.assign(process.env, { HOUGE_OMP_BIN: FAKE_OMP, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG", FAKE_OMP_SCENARIO: scenFile, FAKE_OMP_ARGV_LOG: argvLog });
  const mark = decisionMark(); let worker = null;
  try {
    const stub = async () => ({ ok: true, output: { answer: "stub" } });
    const noNet = async () => { throw new Error("gate: no network"); };
    worker = new G.d.CoreWorker(G.store, join(G.work, "project"), stub, undefined, undefined, undefined, undefined, undefined, undefined, async () => null, undefined, undefined,
      { dataDir: G.work, distDir: DIST, jevFetch: noNet });
    const rowsNow = () => all(`SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ? AND entry_id IN (${IDS_SQL}) ORDER BY rowid`, mark);
    return await body(worker, rowsNow, () => argvPrompts(argvLog));
  } finally {
    try { await worker?.shutdownPlanners(); } catch { /* a stopped planner is not a finding */ }
    for (const k of ["HOUGE_OMP_BIN", "HOUGE_OMP_SANDBOX", "HOUGE_OMP_ENV_PASSTHROUGH", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"]) delete process.env[k];
    process.env.HOUGE_OMP_BIN = "/nonexistent/houge-gate/omp";
  }
}
const waitState = async (run, state, ms = 30_000) => { const end = Date.now() + ms; while (G.store.getRunState(run) !== state) { if (Date.now() > end) throw new Error("gate: run state not reached"); await new Promise((r) => setTimeout(r, 20)); } };
async function line6() {
  const quota = await withWorker({ "anthropic/claude-opus-5-5": { rpcErrorText: "429 usage limit reached" }, "*": { rpcText: "ok" } }, "quota", async (worker, rowsNow, prompts) => {
    const run = mkRun("first"); worker.submitTurn(run); await waitState(run, "completed");
    return { rows: rowsNow(), run, state: G.store.getRunState(run), prompts: prompts() };
  });
  const crash = await withWorker({ rpcStderrAtStart: "synthetic start failure", "*": { rpcText: "ok" } }, "crash", async (worker, rowsNow) => {
    const runs = [];
    for (let i = 0; i < 4; i++) { const run = mkRun(`t${i}`); runs.push(run); worker.submitTurn(run); await waitState(run, "failed"); }
    const failure = G.store.getLedgerEvents(runs[3]).find((e) => e.event_type === "run_failed")?.payload;
    return { rows: rowsNow(), runs, failure };
  });
  const qMine = quota.rows.filter((r) => r.run_id === quota.run).map((r) => [r.entry_id, r.verdict, r.reason_code, r.tool_call_id]);
  const cMine = crash.rows.filter((r) => r.run_id === crash.runs[3]).map((r) => [r.entry_id, r.verdict, r.reason_code, r.tool_call_id]);
  const ok = canon(qMine) === canon([[TR, "retry", "quota", null]]) && quota.rows.length === 1 && quota.state === "completed" && quota.prompts === 2
    && canon(cMine) === canon([[CG, "halt", "limit_reached", null]]) && crash.rows.length === 1 && crash.failure?.error_type === "planner_exit" && crash.failure?.error_ref === "crash_loop";
  return { ok, detail: `quota run: rows ${quota.rows.length} [${qMine.map((r) => `${r[1]}/${r[2]}`)}] (want 1 [retry/quota]) state ${quota.state} (want completed) prompts to the child ${quota.prompts} (want 2: first + RETRY_NOTE) · crash run: rows ${crash.rows.length} [${cMine.map((r) => `${r[1]}/${r[2]}`)}] (want 1 [halt/limit_reached] on the 4th run) first three runs' rows ${crash.rows.filter((r) => crash.runs.slice(0, 3).includes(r.run_id)).length} (want 0) failure error_type/error_ref ${crash.failure?.error_type === "planner_exit" && crash.failure?.error_ref === "crash_loop" ? "match" : "mismatch"} (want match) · tool_call null ${[...quota.rows, ...crash.rows].every((r) => r.tool_call_id === null)}` };
}

// ---- line 7: record faults never change what happens ----
const failedIncidents = () => all("SELECT subject, state FROM incidents WHERE kind = 'decision_record_failed'");
const incidentIds = () => new Set(all("SELECT incident_id FROM incidents").map((r) => r.incident_id));
const alertRows = () => all("SELECT notification_id, target_json FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'");
const incidentAlerts = () => alertRows().map((r) => String(JSON.parse(r.target_json).chat_id));
// 2026-11-03 §5.3: decision_record_failed is a log kind: its opened notice is a change_log row (topic incident_log), never an outbox row
const logRows = () => all("SELECT change_id FROM change_log WHERE topic = 'incident_log' AND idempotency_key LIKE 'incident_opened:%'");
/** Runs `drive` with insertDecision faulting; returns { s, attempts, open (new incidents), subjects, alerts (new alert chats) }. */
async function faulted(drive) {
  const real = G.store.insertDecision.bind(G.store); let attempts = 0;
  const ids0 = incidentIds(); const alerts0 = new Set(alertRows().map((r) => r.notification_id)); const logs0 = new Set(logRows().map((r) => r.change_id));
  // R6: the retry path also consults turn.model; this gate's fault is scoped to its own two entries (the R6 gate faults turn.model)
  G.store.insertDecision = (row) => { if (!IDS.includes(row.entry_id)) return real(row); attempts += 1; throw new Error("gate fault: insertDecision"); };
  let s;
  try { s = (await captured(() => scenario(drive))).value; } finally { G.store.insertDecision = real; }
  // only what the fault itself added counts: incidents and alerts are scoped by id against the snapshot taken before it
  const fresh = all("SELECT incident_id, kind, subject FROM incidents").filter((i) => !ids0.has(i.incident_id));
  const alerts = alertRows().filter((r) => !alerts0.has(r.notification_id)).map((r) => String(JSON.parse(r.target_json).chat_id));
  const logged = logRows().filter((r) => !logs0.has(r.change_id)).length;
  return { s, attempts, open: fresh.length, subjects: fresh.map((i) => `${i.kind}/${i.subject}`), alerts, logged };
}
/** Runs `drive` with a recorder that throws past the store recorder; returns the scenario, the incident/alert deltas and the log lines per entry. */
async function thrown(drive) {
  const inc0 = failedIncidents().length; const a0 = incidentAlerts().length; const l0 = logRows().length;
  const cap = await captured(() => scenario(drive, { recorder: { record: () => { throw new Error("gate fault: record"); } } }));
  const logs = (id) => cap.seen.filter((l) => l.startsWith(`decisions: ${id} record threw past the recorder`)).length;
  return { s: cap.value, incidents: failedIncidents().length - inc0, alerts: incidentAlerts().length - a0, logged: logRows().length - l0, logs: { [CG]: logs(CG), [TR]: logs(TR) } };
}
async function line7() {
  const parts = []; let ok = true;
  const cases = [["quota", quotaScenario, G.clean.quota, TR, 1], ["chain", chainScenario("gate-r4-l7"), G.clean.chain, CG, 2]];
  for (const [name, drive, cleanS, subject, rowsLost] of cases) {
    const f = await faulted(name === "chain" ? chainScenario("gate-r4-l7f") : drive);
    const sameEffects = effects(f.s) === effects(cleanS); // the fault adds no outbox row: the notice is a change_log row
    const fOk = f.attempts === rowsLost && f.open === 1 && canon(f.subjects) === canon([`decision_record_failed/${subject}`]) && f.alerts.length === 0 && f.logged === 1 && f.s.rows.length === 0 && sameEffects;
    const t = await thrown(name === "chain" ? chainScenario("gate-r4-l7t") : drive);
    const crashOpened = name !== "chain" || count(t.s.incidents, "planner_crash_loop") === 1; // P16: the raw behaviour still opens the incident
    const tOk = t.incidents === 0 && t.alerts === 0 && t.logged === 0 && t.s.rows.length === 0 && effects(t.s) === effects(cleanS) && crashOpened && t.logs[CG] === (t.s.calls[CG] ?? 0) && t.logs[TR] === (t.s.calls[TR] ?? 0);
    if (!(fOk && tOk)) ok = false;
    parts.push(`${name}: insert fault: attempts ${f.attempts} (want ${rowsLost}) new incidents ${f.open} [${f.subjects}] (want 1 [decision_record_failed/${subject}]) outbox alerts +${f.alerts.length} (want 0) change_log +${f.logged} (want 1) rows ${f.s.rows.length} (want 0) effects unchanged ${sameEffects} planner_crash_loop ${count(f.s.incidents, "planner_crash_loop")}; thrown recorder: decision_record_failed +${t.incidents} (want 0) alerts +${t.alerts} (want 0) change_log +${t.logged} (want 0) rows ${t.s.rows.length} (want 0) effects unchanged ${effects(t.s) === effects(cleanS)} planner_crash_loop ${count(t.s.incidents, "planner_crash_loop")} logged cg/tr ${t.logs[CG]}/${t.logs[TR]} (want ${t.s.calls[CG] ?? 0}/${t.s.calls[TR] ?? 0})`);
  }
  return { ok, detail: parts.join(" | ") };
}

// ---- line 8: /status and the registry ----
async function line8() {
  const sv = await import(join(DIST, "decisions/status-view.js")); const reg = await import(join(DIST, "decisions/registry.js"));
  const now = wall(); const since = new Date(Date.parse(now) - 24 * 3_600_000).toISOString(); // digest.ts decisionWindow: DIGEST_WINDOW_MS = 24 h, rows with since < created_at <= now
  const lines = sv.decisionStatusLines(G.store, now); const parts = []; let ok = true;
  for (const id of IDS) {
    const mine = lines.filter((l) => l.startsWith(`· ${id} `));
    const shown = mine.length === 1 ? Number(/^· \S+ (\d+) — /.exec(mine[0])?.[1] ?? NaN) : NaN;
    const inWindow = countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ?", id, since, now); // the store's own listDecisionsBetween predicate, which /status reads
    const total = idRows(id); const baseline = G.priorAt[id].filter((t) => t > since && t <= now).length; const want = baseline + WROTE[id];
    if (!(mine.length === 1 && shown === want && inWindow === want && total === G.priorAt[id].length + WROTE[id])) ok = false;
    parts.push(`${id} lines ${mine.length} (want 1), count ${Number.isNaN(shown) ? "none" : shown} (want ${want}; in-window baseline ${baseline} + wrote ${WROTE[id]}; SQL in window ${inWindow}; all rows ${total})`);
  }
  const e = IDS.map((id) => reg.entryById(id));
  if (!e.every((x) => x && x.locked !== true && x.stage === "supervision")) ok = false;
  return { ok, detail: `${parts.join(" · ")} · registry stage/locked ${e.map((x) => `${x?.stage}/${x?.locked === true}`)} (want supervision/false x2)` };
}

// ---- main ----
function pinEnv(root) {
  G.saved = Object.fromEntries([...SET_PINS, ...DELETE_PINS, ...Object.keys(process.env).filter((k) => k.startsWith("HOUGE_OMP_"))].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(G.saved)) delete process.env[k];
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-gate/omp" });
}
function restoreEnv() {
  if (!G.saved) return;
  for (const k of ["HOUGE_OMP_BIN", "HOUGE_OMP_SANDBOX", "HOUGE_OMP_ENV_PASSTHROUGH", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"]) delete process.env[k];
  for (const [k, v] of Object.entries(G.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  G.saved = null;
}
const killFiles = () => [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
async function setup() {
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  if (killFiles() !== 0) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  const root = initTemp(false); G.root = root;
  pinEnv(root);
  G.base = join(root, "houge.sqlite");
  vacuumInto(liveDb, G.base);
  G.d = await loadDist(DIST);
  for (const k of ["storeOptionsFor", "RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "storeRecorder", "PlannerSupervisor", "CoreWorker", "lessonSetFingerprint", "ToolRegistry", "parseModelString", "selectorKey", "resolveOmpConfig"]) if (!G.d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  G.store = G.d.RunStore.open(G.base, G.d.storeOptionsFor(undefined, {}));
  G.work = join(root, "work"); mkdirSync(G.work, { recursive: true });
  const pending = parkOutbox();
  // Line 8's baseline must be what /status counts: rows inside its window. One synthetic row per new id dated 2 days ago is seeded on the copy
  // so a baseline over ALL rows fails line 8; the status window ignores them.
  const reg = await import(join(DIST, "decisions/registry.js"));
  for (const [id, v, reason] of [[CG, "halt", "limit_reached"], [TR, "final", "other_unrouted"]]) {
    const e = reg.entryById(id);
    G.store.insertDecision({ entry_id: id, entry_version: e.version, run_id: null, tool_call_id: null, stage: e.stage, rung: "rule", verdict: v, p: null, reason_code: reason,
      fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0, created_at: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString() });
  }
  G.priorAt = Object.fromEntries(IDS.map((id) => [id, all("SELECT created_at FROM decisions WHERE entry_id = ?", id).map((r) => r.created_at)]));
  note(`copy: ${pending} non-final outbox row(s) parked on the copy; prior rows of the new ids ${IDS.map((id) => G.priorAt[id].length).join(",")}`);
}
function closeAll() { try { G.store?.close(); } catch { /* a closed handle is not a finding */ } G.store = null; }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });

try {
  await setup();
  const lines = [[1, "quota retries once, completes", line1], [2, "model_refusal is final", line2], [3, "routed other retried once then final", line3], [4, "crash chain: halt, latched, reset, no rows", line4],
    [5, "clean turn writes no row", line5], [6, "CoreWorker wiring writes the rows", line6], [7, "record faults", line7], [8, "/status and the registry", line8]];
  for (const [n, name, fn] of lines) await runLine(n, name, fn);
  const tomb = killFiles();
  if (tomb !== 0) { out.push(false); console.log(`FAIL post houge.kill — found ${tomb} (want 0)`); }
  const passed = out.filter(Boolean).length;
  note(`${passed}/8 PASS · houge.kill in cwd/main checkout ${tomb} (want 0)`);
  process.exitCode = out.length === 8 && passed === 8 ? 0 : 1;
} catch (e) {
  console.error("setup_failed");
  process.exitCode = 2;
} finally {
  const root = G.root;
  await cleanup().catch(() => undefined);
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
