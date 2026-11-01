#!/usr/bin/env node
// Live gate — decision ladder remainder R3, intake.bare_ack (locked) + intake.steer_or_queue (spec 2026-11-01 R3 §7; plan Task 5).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-remainder-r3.mjs [--live-db <path>]
// Eight lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all eight PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. Only counts, booleans, codes and run labels are printed, never message text or any id of the live DB.
// The live DB is opened read-only, once, by VACUUM INTO a temp copy under /tmp/hg-s4d-*, removed on every exit path (finally,
// SIGINT, SIGTERM, SIGHUP). No env file is loaded (HOUGE_ENV_FILE only locates the DB); there is no real omp child (a fake session over the
// dist PlannerSupervisor, and tests/fixtures/fake-omp.mjs for line 6) and no Telegram client at all, so nothing leaves the machine. Safety pins,
// set before any store opens and restored on exit:
//   HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root (P2: nothing here intakes `kill`, but the pin makes it unable to stop the LIVE daemon),
//   HOUGE_TELEGRAM_CHAT_ID = -1003 (P3: a numeric id that is not a real chat; line 7's decision_record_failed alerts must not page Paco),
//   the omp, scheduler, radar, media variables deleted (an armed ambient flag sends unrelated operator alerts).
// Clock: no counting clock anywhere; every intake gets the wall clock. Every run is its own actor, notify chat -1003.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, canon, cleanupTemp, initTemp, loadDist, redactForPrint } from "./stage4-diff-lib.mjs";
import { countingRecorder } from "./stage4-sender-fixture.mjs";
import { cleanup, fakeSession, heldSession, mkSupervisor, req, sink, until, untilState } from "./stage4-supervisor-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const FAKE_OMP = resolve(new URL("../tests/fixtures/fake-omp.mjs", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const STUB_CHAT = "-1003"; // numeric (CoreWorker refuses a non-numeric chat id before submit), not a real chat
const SQ = "intake.steer_or_queue"; const BA = "intake.bare_ack";
const IDS = [SQ, BA];
const BIG = 1_000_000_000; // caps no real copy reaches
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES",
  "HOUGE_OMP_SANDBOX", "HOUGE_OMP_ENV_PASSTHROUGH", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"];
// Rows this gate writes before line 8 (a faulted or thrown record never lands): steer_or_queue = line 1 steer + line 3 steer + line 4 wait + line 5 wait + line 6 steer; bare_ack = line 2 nudge.
const WROTE = { [SQ]: 5, [BA]: 1 };
const out = [];
const G = { d: null, root: null, base: null, store: null, saved: null, work: null, n: 0, clean: {}, nudgeText: "" };
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
/** One fresh Telegram turn run on the copy (its own actor, notify chat -1003). `source` labels the REQUEST; the run is a Telegram turn either way (as the corpus). */
function mkRun(text) {
  G.n += 1;
  const r = gateway().intake(G.d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: `gate-r3-actor-${G.n}` },
    notify: { kind: "telegram", chat_id: STUB_CHAT }, idempotency_key: `gate-r3:${G.n}`, source_reference: `telegram:update:${G.n}:message:${G.n}` }));
  if (!r.ok) throw new Error("gate: run intake refused");
  return r.run_id;
}
const SCHED = (r) => ({ ...r, goal: "g" });
const ends = (store, run) => store.getLedgerEvents(run).filter((e) => e.event_type === "run_completed").length;
const ackEvents = (store, run) => store.getLedgerEvents(run).filter((e) => e.event_type === "ack_nudged").length;
const nudgeReplies = (run) => countOf("SELECT COUNT(*) AS n FROM chat_turns WHERE run_id = ? AND role = 'assistant' AND text = ?", run, G.nudgeText);
const outcomeOf = (o, run) => ({ done: o.done.filter((x) => x.run_id === run).length, failed: o.failed.filter((x) => x.run_id === run).length });

/**
 * drive(x): x.run(name, text) makes a run, x.mk(opts) the supervisor (recorder: the counting wrap over `recorder`, default the store recorder).
 * Returns what the scenario did: the child's prompts and steers, the R3 rows by run label, the recorder tally, per-run done/failed/run_completed/ack/nudge counts, outbox delta.
 */
async function scenario(drive, { recorder } = {}) {
  const names = new Map(); const mark = decisionMark(); const out0 = outboxN();
  const counting = countingRecorder(recorder ?? G.d.storeRecorder(G.store));
  let rig = null;
  const x = { store: G.store,
    run: (name, text) => { const id = mkRun(text); names.set(id, name); return id; },
    mk: (opts = {}) => { rig = mkSupervisor(G.d, G.store, { ...opts, recorder: counting.recorder }); return rig; } };
  try { await drive(x); } finally { await cleanup(); }
  const label = (id) => names.get(id) ?? "?";
  const rows = all(`SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ? AND entry_id IN (${IDS_SQL}) ORDER BY rowid`, mark)
    .map((r) => [r.entry_id, r.verdict, r.reason_code, label(r.run_id), r.tool_call_id]);
  const perRun = {};
  for (const [id, name] of names) perRun[name] = { ...outcomeOf(rig.outcome, id), completed: ends(G.store, id), acks: ackEvents(G.store, id), nudges: nudgeReplies(id), state: G.store.getRunState(id) };
  return { prompts: rig.session.prompts.length, steers: rig.session.steers.length, rows, calls: counting.calls, perRun, outbox: outboxN() - out0, ids: names, label };
}
const rowsFor = (s, name) => s.rows.filter((r) => r[3] === name);
/** What the run did, with nothing about the decision rows in it: the line-7 comparison between a clean run and a faulted one. */
const effects = (s) => canon({ prompts: s.prompts, steers: s.steers, perRun: s.perRun, outbox: s.outbox });

// ---- the scenarios ----
/** a is a live Telegram turn; `card`: none | awaiting; b arrives with `text`. Returns after both finished. */
const duringTurn = (card, text) => async (x) => {
  const h = heldSession(); const { sup, outcome } = x.mk({ session: h.session });
  const a = x.run("a", "push it"); const b = x.run("b", text);
  sup.submit(req(a, "push it")); await h.live(1, sup);
  if (card === "awaiting") sup.setAwaitingApprovalForTest(true);
  sup.submit(req(b, text));
  if (text === "好") await until(() => outcome.done.some((o) => o.run_id === b)); // the nudge completes b on its own
  if (card === "awaiting") sup.setAwaitingApprovalForTest(false);
  h.end(); await sup.whenIdle();
};
const steerScenario = duringTurn("none", "x");
const nudgeScenario = duringTurn("awaiting", "好");

// ---- line 1: a message during a RUNNING Telegram turn is steered ----
async function line1() {
  const s = await scenario(steerScenario); G.clean.steer = s;
  const b = rowsFor(s, "b"); const want = [[SQ, "steer", "live_turn", "b", null]];
  const ok = s.steers === 1 && s.prompts === 1 && canon(s.rows) === canon(want) && s.calls[SQ] === 2 && s.perRun.a.completed === 1 && s.perRun.b.state === "completed";
  return { ok, detail: `steers ${s.steers} (want 1) · prompts ${s.prompts} (want 1) · rows ${s.rows.length} [${s.rows.map((r) => `${r[1]}/${r[2]}@${r[3]}`)}] (want 1 [steer/live_turn@b]) · b rows ${b.length} tool_call null ${b.every((r) => r[4] === null)} · consults ${s.calls[SQ]} (want 2: idle a + steer b) · a run_completed ${s.perRun.a.completed} (want 1) · b ${s.perRun.b.state} (want completed)` };
}

// ---- line 2: bare 好 while a card waits is nudged, never steered ----
async function line2() {
  const s = await scenario(nudgeScenario); G.clean.nudge = s;
  const want = [[BA, "nudge", "ack_while_card_waits", "b", null]]; const b = s.perRun.b; const bSq = rowsFor(s, "b").filter((r) => r[0] === SQ).length;
  const ok = s.steers === 0 && s.prompts === 1 && canon(s.rows) === canon(want) && bSq === 0 && b.nudges === 1 && b.acks === 1 && b.done === 1 && b.completed === 1 && b.state === "completed" && s.calls[BA] === 1;
  return { ok, detail: `steers ${s.steers} (want 0) · prompts ${s.prompts} (want 1) · nudge replies ${b.nudges} (want 1) · ack_nudged ${b.acks} (want 1) · b done ${b.done} run_completed ${b.completed} (want 1,1) · rows ${s.rows.length} [${s.rows.map((r) => `${r[1]}/${r[2]}@${r[3]}`)}] (want 1 [nudge/ack_while_card_waits@b]) · steer_or_queue rows for b ${bSq} (want 0) · bare_ack consults ${s.calls[BA]} (want 1)` };
}

// ---- line 3: a non-ack while a card waits is steered; pass writes no row ----
async function line3() {
  const s = await scenario(duringTurn("awaiting", "why?"));
  const want = [[SQ, "steer", "live_turn", "b", null]];
  const ok = s.steers === 1 && canon(s.rows) === canon(want) && rowsFor(s, "b").filter((r) => r[0] === BA).length === 0 && s.calls[BA] === 1 && s.perRun.b.nudges === 0 && s.perRun.b.acks === 0 && s.perRun.b.state === "completed";
  return { ok, detail: `steers ${s.steers} (want 1) · rows ${s.rows.length} [${s.rows.map((r) => `${r[0]}:${r[1]}/${r[2]}@${r[3]}`)}] (want 1 [steer_or_queue:steer/live_turn@b]) · bare_ack rows ${s.rows.filter((r) => r[0] === BA).length} (want 0) · bare_ack consults ${s.calls[BA]} (want 1: the pass) · nudge replies ${s.perRun.b.nudges} (want 0) · b ${s.perRun.b.state} (want completed)` };
}

// ---- line 4: a Telegram message during a schedule-born live turn queues, row at its claim ----
async function line4() {
  let early = -1; let steersAtEnd = -1;
  const s = await scenario(async (x) => {
    const h = heldSession(); const { sup } = x.mk({ session: h.session });
    const a = x.run("a", "brief"); const m = x.run("m", "later");
    sup.submit(SCHED(req(a, "brief", "schedule"))); await h.live(1, sup);
    sup.submit(req(m, "later"));
    early = countOf(`SELECT COUNT(*) AS n FROM decisions WHERE run_id = ? AND entry_id IN (${IDS_SQL})`, m); // queued, not yet claimed: no row
    steersAtEnd = h.session.steers.length;
    h.end(); await h.live(2, sup); h.end(); await sup.whenIdle();
  });
  const want = [[SQ, "wait", "turn_schedule_born", "m", null]]; const m = s.perRun.m;
  const ok = early === 0 && steersAtEnd === 0 && s.steers === 0 && s.prompts === 2 && canon(s.rows) === canon(want) && m.done === 1 && m.completed === 1 && m.state === "completed" && s.perRun.a.completed === 1;
  return { ok, detail: `rows before the turn ended ${early} (want 0) · steers ${s.steers} (want 0) · prompts ${s.prompts} (want 2) · rows ${s.rows.length} [${s.rows.map((r) => `${r[1]}/${r[2]}@${r[3]}`)}] (want 1 [wait/turn_schedule_born@m]) · m done ${m.done} run_completed ${m.completed} (want 1,1) · m ${m.state} · a run_completed ${s.perRun.a.completed} (want 1)` };
}

// ---- line 5: idle queue writes nothing; a held start waits with turn_not_live ----
async function line5() {
  const idle = await scenario(async (x) => { const { sup } = x.mk(); const a = x.run("a", "hi"); sup.submit(req(a)); await sup.whenIdle(); });
  const held = await scenario(async (x) => {
    let release; const gate = new Promise((r) => { release = r; });
    const h = heldSession({ holdStart: gate }); const { sup } = x.mk({ session: h.session });
    const a = x.run("a", "u"); const b = x.run("b", "second");
    sup.submit(req(a)); await untilState(sup, "STARTING"); sup.submit(req(b, "second"));
    release(); await h.live(1, sup); h.end(); await h.live(2, sup); h.end(); await sup.whenIdle();
  });
  const wantHeld = [[SQ, "wait", "turn_not_live", "b", null]];
  const idleOk = idle.rows.length === 0 && idle.prompts === 1 && idle.perRun.a.done === 1 && idle.perRun.a.completed === 1 && idle.calls[SQ] === 1;
  const heldOk = canon(held.rows) === canon(wantHeld) && held.prompts === 2 && held.steers === 0 && held.perRun.b.done === 1 && held.perRun.b.completed === 1 && held.perRun.a.completed === 1 && held.perRun.b.state === "completed";
  return { ok: idleOk && heldOk, detail: `idle: rows ${idle.rows.length} (want 0) prompts ${idle.prompts} (want 1) done ${idle.perRun.a.done} run_completed ${idle.perRun.a.completed} (want 1,1) consults ${idle.calls[SQ]} (want 1) | held start: rows ${held.rows.length} [${held.rows.map((r) => `${r[1]}/${r[2]}@${r[3]}`)}] (want 1 [wait/turn_not_live@b]) prompts ${held.prompts} (want 2) steers ${held.steers} (want 0) b done ${held.perRun.b.done} run_completed ${held.perRun.b.completed} (want 1,1) a run_completed ${held.perRun.a.completed} (want 1)` };
}

// ---- line 6: the production wiring, CoreWorker.submitTurn on the fake omp ----
const SCEN = { "*": { rpcText: "both", rpcFinishOnSteer: true } };
async function line6() {
  const scenFile = join(G.root, "scenario.json"); const argvLog = join(G.root, "argv.log");
  writeFileSync(scenFile, JSON.stringify(SCEN));
  Object.assign(process.env, { HOUGE_OMP_BIN: FAKE_OMP, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG", FAKE_OMP_SCENARIO: scenFile, FAKE_OMP_ARGV_LOG: argvLog });
  const mark = decisionMark(); let worker = null;
  try {
    const stub = async () => ({ ok: true, output: { answer: "stub" } });
    const noNet = async () => { throw new Error("gate: no network"); };
    worker = new G.d.CoreWorker(G.store, join(G.work, "project"), stub, undefined, undefined, undefined, undefined, undefined, undefined, async () => null, undefined, undefined,
      { dataDir: G.work, distDir: DIST, jevFetch: noNet });
    const prompts = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l?.cmd?.type === "prompt").length;
    const parent = mkRun("first"); worker.submitTurn(parent);
    await until(() => prompts() >= 1, 20_000);
    const child = mkRun("second"); worker.submitTurn(child);
    await until(() => G.store.getRunState(parent) === "completed" && G.store.getRunState(child) === "completed", 30_000);
    const rows = all(`SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ? AND entry_id IN (${IDS_SQL}) ORDER BY rowid`, mark);
    const mine = rows.filter((r) => r.run_id === child); const got = mine.map((r) => [r.entry_id, r.verdict, r.reason_code, r.tool_call_id]);
    const ok = canon(got) === canon([[SQ, "steer", "live_turn", null]]) && rows.length === 1;
    return { ok, detail: `child rows ${mine.length} [${mine.map((r) => `${r.verdict}/${r.reason_code}`)}] (want 1 [steer/live_turn]) · all R3 rows since ${rows.length} (want 1) · tool_call null ${mine.every((r) => r.tool_call_id === null)} · parent/child ${G.store.getRunState(parent)}/${G.store.getRunState(child)} (want completed/completed)` };
  } finally {
    try { await worker?.shutdownPlanners(); } catch { /* a stopped planner is not a finding */ }
    for (const k of ["HOUGE_OMP_BIN", "HOUGE_OMP_SANDBOX", "HOUGE_OMP_ENV_PASSTHROUGH", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"]) delete process.env[k];
    process.env.HOUGE_OMP_BIN = "/nonexistent/houge-gate/omp";
  }
}

// ---- line 7: record faults never change what happens ----
const failedIncidents = () => all("SELECT subject, state FROM incidents WHERE kind = 'decision_record_failed'");
const incidentIds = () => new Set(all("SELECT incident_id FROM incidents").map((r) => r.incident_id));
const alertRows = () => all("SELECT notification_id, target_json FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'");
const incidentAlerts = () => alertRows().map((r) => String(JSON.parse(r.target_json).chat_id));
/** Runs `drive` with insertDecision faulting; returns { s, attempts, open (new open incident subjects), alerts (new alert chats) }. */
async function faulted(drive) {
  const real = G.store.insertDecision.bind(G.store); let attempts = 0;
  const ids0 = incidentIds(); const alerts0 = new Set(alertRows().map((r) => r.notification_id));
  G.store.insertDecision = () => { attempts += 1; throw new Error("gate fault: insertDecision"); };
  let s;
  try { s = (await captured(() => scenario(drive))).value; } finally { G.store.insertDecision = real; }
  // only what the fault itself added counts: incidents and alerts are scoped by id against the snapshot taken before it
  const fresh = all("SELECT incident_id, kind, subject FROM incidents").filter((i) => !ids0.has(i.incident_id));
  const alerts = alertRows().filter((r) => !alerts0.has(r.notification_id)).map((r) => String(JSON.parse(r.target_json).chat_id));
  return { s, attempts, open: fresh.length, subjects: fresh.map((i) => `${i.kind}/${i.subject}`), alerts };
}
/** Runs `drive` with a recorder that throws past the store recorder; returns the scenario, the incident/alert deltas and the log lines per entry. */
async function thrown(drive) {
  const inc0 = failedIncidents().length; const a0 = incidentAlerts().length;
  const cap = await captured(() => scenario(drive, { recorder: { record: () => { throw new Error("gate fault: record"); } } }));
  const logs = (id) => cap.seen.filter((l) => l.startsWith(`decisions: ${id} record threw past the recorder`)).length;
  return { s: cap.value, incidents: failedIncidents().length - inc0, alerts: incidentAlerts().length - a0, logs: { [SQ]: logs(SQ), [BA]: logs(BA) } };
}
async function line7() {
  const parts = []; let ok = true;
  for (const [name, drive, cleanS, subject] of [["steer", steerScenario, G.clean.steer, SQ], ["nudge", nudgeScenario, G.clean.nudge, BA]]) {
    const f = await faulted(drive);
    const sameEffects = effects({ ...f.s, outbox: f.s.outbox - 1 }) === effects(cleanS); // the one operator alert is the only outbox row more
    const fOk = f.attempts === 1 && f.open === 1 && canon(f.subjects) === canon([`decision_record_failed/${subject}`]) && f.alerts.length === 1 && f.alerts.every((c) => c === STUB_CHAT) && f.s.rows.length === 0 && sameEffects;
    const t = await thrown(drive);
    const tOk = t.incidents === 0 && t.alerts === 0 && t.s.rows.length === 0 && effects(t.s) === effects(cleanS) && t.logs[SQ] === t.s.calls[SQ] && t.logs[BA] === (t.s.calls[BA] ?? 0);
    if (!(fOk && tOk)) ok = false;
    parts.push(`${name}: insert fault: attempts ${f.attempts} (want 1) new incidents ${f.open} [${f.subjects}] (want 1 [decision_record_failed/${subject}]) alerts +${f.alerts.length} (want 1) to stub ${f.alerts.every((c) => c === STUB_CHAT)} rows ${f.s.rows.length} (want 0) effects unchanged ${sameEffects}; thrown recorder: incidents +${t.incidents} (want 0) alerts +${t.alerts} (want 0) rows ${t.s.rows.length} (want 0) effects unchanged ${effects(t.s) === effects(cleanS)} logged sq/ba ${t.logs[SQ]}/${t.logs[BA]} (want ${t.s.calls[SQ] ?? 0}/${t.s.calls[BA] ?? 0})`);
  }
  return { ok, detail: parts.join(" | ") };
}

// ---- line 8: /status and the lock ----
async function line8() {
  const sv = await import(join(DIST, "decisions/status-view.js")); const reg = await import(join(DIST, "decisions/registry.js"));
  const now = wall(); const since = new Date(Date.parse(now) - 24 * 3_600_000).toISOString(); // digest.ts decisionWindow: DIGEST_WINDOW_MS = 24 h, rows with since < created_at <= now
  const lines = sv.decisionStatusLines(G.store, now); const parts = []; let ok = true;
  for (const id of IDS) {
    const mine = lines.filter((l) => l.startsWith(`· ${id} `));
    const shown = mine.length === 1 ? Number(/^· \S+ (\d+) — /.exec(mine[0])?.[1] ?? NaN) : NaN;
    const total = idRows(id); const inWindow = G.priorAt[id].filter((t) => t > since && t <= now).length; const want = inWindow + WROTE[id];
    if (!(mine.length === 1 && shown === want && total === G.priorAt[id].length + WROTE[id])) ok = false;
    parts.push(`${id} lines ${mine.length} (want 1), count ${Number.isNaN(shown) ? "none" : shown} (want ${want}; in-window baseline ${inWindow}; all rows ${total})`);
  }
  const move = (entry_id) => G.store.insertLadderMove({ entry_id, scope: "g", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "paco", granted_via: "gate", paco_callback_id: "cb", revocable: true });
  const before = countOf("SELECT COUNT(*) AS n FROM ladder_moves WHERE entry_id = ?", BA);
  let code = "not refused";
  try { move(BA); } catch (e) { code = e?.code ?? errCode(e); }
  const after = countOf("SELECT COUNT(*) AS n FROM ladder_moves WHERE entry_id = ?", BA);
  const e = reg.entryById(BA);
  if (!(code === "locked_entry" && after === before && e?.locked === true)) ok = false;
  return { ok, detail: `${parts.join(" · ")} · insertLadderMove(${BA}) -> ${code} (want locked_entry) · ladder_moves rows ${before} -> ${after} · registry locked ${e?.locked}` };
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
  G.nudgeText = (await import(join(DIST, "omp/bare-ack.js"))).ACK_NUDGE_TEXT;
  G.store = G.d.RunStore.open(G.base, G.d.storeOptionsFor(undefined, {}));
  G.work = join(root, "work"); mkdirSync(G.work, { recursive: true });
  const pending = parkOutbox();
  // Line 8's baseline must be what /status counts: rows inside its window. One synthetic row per new id dated 2 days ago is seeded on the copy
  // so a baseline over ALL rows fails line 8; the status window ignores them.
  const reg = await import(join(DIST, "decisions/registry.js"));
  for (const [id, v, reason] of [[SQ, "wait", "turn_not_live"], [BA, "nudge", "ack_while_card_waits"]]) {
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
  const lines = [[1, "message steered into a RUNNING turn", line1], [2, "bare ack nudged while a card waits", line2], [3, "non-ack steered, pass writes no row", line3], [4, "schedule-born turn: wait, row at claim", line4],
    [5, "idle queue silent, held start waits", line5], [6, "CoreWorker wiring writes the row", line6], [7, "record faults", line7], [8, "/status and the lock", line8]];
  for (const [n, name, fn] of lines) await runLine(n, name, fn);
  const tomb = killFiles();
  if (tomb !== 0) { out.push(false); console.log(`FAIL post houge.kill — found ${tomb} (want 0)`); }
  const passed = out.filter(Boolean).length;
  note(`${passed}/8 PASS · houge.kill in cwd/main checkout ${tomb} (want 0)`);
  process.exitCode = out.length === 8 && passed === 8 ? 0 : 1;
} catch (e) {
  console.error(`setup error: ${e instanceof SetupError ? e.message : "withheld"}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  await cleanup().catch(() => undefined);
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
