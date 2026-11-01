#!/usr/bin/env node
// Live gate — decision ladder remainder R2, intake.sender (locked) + turn.contract (spec 2026-11-01 R2 §7; plan Task 9).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-remainder-r2.mjs [--live-db <path>]
// Eight lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all eight PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. Only counts, booleans and codes are printed, never message text or any id of the live DB.
// The live DB is opened read-only, once, by VACUUM INTO a temp copy under /tmp/hg-s4d-*, removed on every exit path (finally,
// SIGINT, SIGTERM, SIGHUP). No env file is loaded (HOUGE_ENV_FILE only locates the DB) and the Telegram client is a recording stub, so
// nothing ever leaves the machine. Safety pins, set before any store opens and restored on exit:
//   HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root (P3: nothing here intakes `kill`, but the pin makes it unable to stop the LIVE daemon),
//   HOUGE_TELEGRAM_CHAT_ID = gate-stub-chat (P4: line 7's decision_record_failed alerts must not page Paco),
//   the omp, scheduler, radar, media variables deleted (P11: an armed ambient flag sends unrelated operator alerts).
// Clock: no counting clock anywhere; every intake gets the wall clock. Each line uses its own identity (chat gate-r2-chat-<n>).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, redactForPrint } from "./stage4-diff-lib.mjs";
import { intakeEvent } from "./stage4-intake-fixture.mjs";
import { CHAT, PACO, STRANGER, countingRecorder, pollItem, senderUpdate } from "./stage4-sender-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const STUB_CHAT = "gate-stub-chat";
const IDS = ["intake.sender", "turn.contract"];
const BIG = 1_000_000_000; // caps no real copy reaches
const ALLOWLIST = { users: [{ telegram_user_id: PACO, identity_id: "paco" }], chats: [{ telegram_chat_id: CHAT, label: "synthetic", allowed_identity_ids: ["paco"] }] };
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES"];
const out = [];
const G = { d: null, root: null, base: null, store: null, saved: null, work: null, nid: 0 };
const note = (s) => console.error(`# ${s}`);
const wall = () => new Date().toISOString();
const countOf = (sql, ...args) => G.store.db.prepare(sql).get(...args).n;
const all = (sql, ...args) => G.store.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const idRows = (id) => countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", id);
const decisionMark = () => G.store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
const rowsAfter = (mark, id) => all("SELECT verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ? AND entry_id = ? ORDER BY rowid", mark, id);
const pair = (r) => r.map((x) => `${x.verdict}/${x.reason_code}`).join(",");
const nullIds = (r) => r.every((x) => x.run_id === null && x.tool_call_id === null);
const outboxN = () => countOf("SELECT COUNT(*) AS n FROM notification_outbox");
const runsN = () => countOf("SELECT COUNT(*) AS n FROM runs");
const chatOutbox = (chat) => all("SELECT target_json FROM notification_outbox").filter((r) => String(JSON.parse(r.target_json).chat_id) === chat).length;
const skipCode = (id) => G.store.db.prepare("SELECT reason_code FROM skipped_telegram_updates WHERE update_id = ?").get(id)?.reason_code ?? "none";
const gateway = (caps = {}, options = {}) => new G.d.Gateway(G.store, { ...G.d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG, ...caps }, undefined, undefined, undefined, options);
const whoFor = (n) => ({ chat: `gate-r2-chat-${n}`, actor: `gate-r2-actor-${n}` });
/** A fresh update id above the copy's offset and every id this gate used. */
const nextId = () => { G.nid = Math.max(G.nid, G.store.getOffset("telegram")) + 1000; return G.nid; };

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
/** console.error captured (not printed) while `fn` runs; the lines are counted, never echoed. */
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

// ---- drivers over the copy ----
/** Marks every non-final outbox row of the COPY failed_terminal (the copy is disposable); returns how many. */
const parkOutbox = () => G.store.db.prepare("UPDATE notification_outbox SET state = 'failed_terminal' WHERE state NOT IN ('delivered', 'failed_terminal')").run().changes;
/** One runTelegramPollOnce cycle (the production constructor) with a recording stub client; returns the chats it sent to. */
async function pollRun(updates) {
  const sent = [];
  await G.d.runTelegramPollOnce({ store: G.store, projectRoot: G.work, omp: { dataDir: G.work, distDir: DIST }, allowlist: ALLOWLIST,
    telegramClient: { getUpdates: async () => structuredClone(updates), sendMessage: async ({ chat_id }) => { sent.push(String(chat_id)); return { message_id: 1 }; } } });
  return sent;
}
/** A snapshot of everything a silent denial must leave alone. */
const snap = () => ({ outbox: outboxN(), runs: runsN(), mark: decisionMark() });
const SPEC_JSON = '{"kind":"daily","at":"08:00"}';
/** A gate schedule due a minute ago (its own chat; goal synthetic). */
function dueSchedule(label) {
  return G.store.addScheduledTask({ chat_id: `gate-r2-sched-${label}`, goal: "synthetic", spec_json: SPEC_JSON, tz: "UTC", next_run_at: new Date(Date.now() - 60_000).toISOString(), created_by: "gate-r2" });
}
const STUB_WORKER = { submitTurn: () => true, executeRun: async () => ({ status: "queued" }) };
const tick = async (gw, extraEnv = {}) => (await import(join(DIST, "run/schedule-tick.js"))).maybeFireScheduledTasks({
  store: G.store, gateway: gw, worker: STUB_WORKER, now: wall(), env: { HOUGE_SCHEDULER_ENABLED: "true", HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, ...extraEnv } });
const runOf = (schedule_id) => all("SELECT run_id, contract_json FROM runs WHERE source = 'schedule' AND json_extract(requested_by_json, '$.id') = ?", schedule_id);
/** True when the run's compiled contract exists and the schedule_task action was stripped from it. */
const stripped = (r) => { try { const a = JSON.parse(r.contract_json).allowed_actions; return Array.isArray(a) && a.length > 0 && !a.includes("schedule_task"); } catch { return false; } };

// ---- line 1: a stranger ----
async function line1() {
  const id = nextId(); const s = snap();
  const sent = await pollRun([senderUpdate("message", { id, from: STRANGER })]);
  const rows = rowsAfter(s.mark, "intake.sender"); const skip = skipCode(id); const offset = G.store.getOffset("telegram");
  const ok = skip === "TELEGRAM_AUTH_DENIED" && offset === id + 1 && rows.length === 1 && pair(rows) === "deny/user_not_allowlisted" && nullIds(rows)
    && sent.length === 0 && outboxN() - s.outbox === 0 && runsN() - s.runs === 0;
  return { ok, detail: `skip ${skip} · offset = id+1 ${offset === id + 1} · rows ${rows.length} [${pair(rows)}] (want 1 [deny/user_not_allowlisted]) · run_id null ${nullIds(rows)} · sendMessage ${sent.length} (want 0) · outbox +${outboxN() - s.outbox} (want 0) · runs +${runsN() - s.runs} (want 0)` };
}

// ---- line 2: a forward and a channel post ----
async function line2() {
  const parts = []; let ok = true;
  for (const [kind, opts, want] of [["forward", { forward: "date" }, "deny/forwarded"], ["channel_post", {}, "deny/channel_post"]]) {
    const id = nextId(); const s = snap();
    const sent = await pollRun([senderUpdate(kind, { id, ...opts })]);
    const rows = rowsAfter(s.mark, "intake.sender");
    const good = rows.length === 1 && pair(rows) === want && skipCode(id) === "TELEGRAM_AUTH_DENIED" && sent.length === 0;
    if (!good) ok = false;
    parts.push(`${kind}: rows ${rows.length} [${pair(rows)}] (want 1 [${want}]) · sendMessage ${sent.length} (want 0)`);
  }
  return { ok, detail: parts.join(" | ") };
}

// ---- line 3: a stranger taps an approval ----
async function line3() {
  const who = whoFor(3);
  const intake = gateway().intake(intakeEvent(G.d, who, { key: "l3-run" }), wall());
  if (!intake.ok) throw new Error("gate: seed run refused");
  if (!G.store.claimRun(intake.run_id, "gate-r2-worker", 600)) throw new Error("gate: claim failed");
  const approval = G.store.createToolApproval({ run_id: intake.run_id, worker_id: "gate-r2-worker", tool_call_id: "tc-l3", capability: "shell_external", input_hash: "h", action_fingerprint: "f",
    requester: { kind: "user", id: "paco" }, summary: "synthetic", side_effect_level: "external_write", expires_at: "2099-01-01T00:00:00.000Z" });
  const stateOf = () => G.store.db.prepare("SELECT state FROM tool_approvals WHERE approval_id = ?").get(approval.approval_id).state;
  // The seed's own approval card is queued for the requester: park it on the copy so the poll cycle's flush sends only what the TAP causes.
  parkOutbox();
  const before = stateOf(); const id = nextId(); const s = snap();
  const update = senderUpdate("tap", { id, from: STRANGER });
  update.callback_query.data = `approval:approve:${approval.approval_id}`;
  const sent = await pollRun([update]);
  const rows = rowsAfter(s.mark, "intake.sender"); const after = stateOf();
  const ok = before === "pending" && after === "pending" && rows.length === 1 && pair(rows) === "deny/user_not_allowlisted" && skipCode(id) === "TELEGRAM_AUTH_DENIED" && sent.length === 0 && outboxN() - s.outbox === 0;
  return { ok, detail: `approval ${before} -> ${after} (want pending -> pending) · rows ${rows.length} [${pair(rows)}] (want 1 [deny/user_not_allowlisted]) · sendMessage ${sent.length} (want 0) · outbox +${outboxN() - s.outbox} (want 0)` };
}

// ---- line 4: Paco's own text is not a sender decision ----
async function line4() {
  const s = snap(); const id = nextId();
  const r = await pollItem(G.d, G.store, [senderUpdate("message", { id })], { recorder: G.d.storeRecorder(G.store) });
  const rows = rowsAfter(s.mark, "intake.sender"); const calls = r.calls["intake.sender"] ?? 0;
  const ok = r.emitted.length === 1 && calls === 0 && rows.length === 0 && r.offset === id + 1;
  return { ok, detail: `emitted ${r.emitted.length} (want 1) · intake.sender calls ${calls} (want 0) · rows ${rows.length} (want 0) · offset = id+1 ${r.offset === id + 1}` };
}

// ---- line 5: a schedule-born turn writes the strip row, once ----
async function line5() {
  // P7: only the gate's schedule may be due. cancelScheduledTask (the store's own method) disables every pre-existing schedule ON THE COPY.
  const disabled = G.store.listScheduledTasks().filter((t) => t.state === "enabled").filter((t) => G.store.cancelScheduledTask(t.schedule_id)).length;
  G.gateSchedules = []; const sch = dueSchedule("l5"); G.gateSchedules.push(sch.schedule_id);
  const s = snap(); const gw = gateway();
  const res = await tick(gw);
  const runs = runOf(sch.schedule_id); const run = runs[0];
  const rows = rowsAfter(s.mark, "turn.contract");
  const event = G.d.buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: sch.goal, requested_by: { kind: "schedule", id: sch.schedule_id }, notify: { kind: "telegram", chat_id: sch.chat_id },
    idempotency_key: `schedule:${sch.schedule_id}:${sch.next_run_at}`, source_reference: `scheduled_tasks.${sch.schedule_id}`, created_at: wall() }); // exactly as schedule-tick.ts builds it
  const dup = gw.intake(event, wall()); const rowsDup = rowsAfter(s.mark, "turn.contract");
  const ok = res.fired === 1 && runs.length === 1 && stripped(run) && rows.length === 1 && pair(rows) === "restrict/schedule_born" && rows[0].run_id === run.run_id
    && dup.ok === true && dup.status === "duplicate" && dup.run_id === run.run_id && rowsDup.length === 1 && runOf(sch.schedule_id).length === 1;
  return { ok, detail: `old schedules disabled on copy ${disabled} · fired ${res.fired} (want 1) · runs for the schedule ${runs.length} (want 1) · schedule_task stripped ${runs.length ? stripped(run) : "n/a"} · turn.contract rows ${rows.length} [${pair(rows)}] (want 1 [restrict/schedule_born]) on that run ${rows[0]?.run_id === run?.run_id} · replay ${dup.ok ? dup.status : dup.error?.code} same run ${dup.run_id === run?.run_id} rows after ${rowsDup.length} (want duplicate, 1)` };
}

// ---- line 6: no row for a fuse cycle or a compile; a refusal writes its row ----
async function line6() {
  G.store.disarmGlobalFuse(); // the copy may already be fused: the cycle below must be the 0-runs fuse, and line 7 needs it open again
  const sch = dueSchedule("l6"); G.gateSchedules.push(sch.schedule_id);
  const s = snap(); const fuseGw = gateway({ runs: 0 });
  const t1 = (await captured(() => tick(fuseGw))).value; const t2 = (await captured(() => tick(fuseGw))).value; // the tick logs the pause (with the gate's schedule id): captured, not printed
  const fuseRows = rowsAfter(s.mark, "turn.contract").length; const fuseRuns = runOf(sch.schedule_id).length;
  G.store.cancelScheduledTask(sch.schedule_id); G.store.disarmGlobalFuse();
  const counting = countingRecorder(G.d.storeRecorder(G.store)); const s2 = snap();
  const turn = gateway({}, { decisionRecorder: counting.recorder }).intake(intakeEvent(G.d, whoFor("6a"), { key: "l6-turn" }), wall());
  const turnCalls = counting.calls["turn.contract"] ?? 0; const turnRows = rowsAfter(s2.mark, "turn.contract").length;
  const s3 = snap(); const who = whoFor("6b");
  const bad = gateway().intake(intakeEvent(G.d, who, { type: "run", goal: "x", key: "l6-nosuch", extra: { program: "nosuch" } }), wall());
  const refusals = rowsAfter(s3.mark, "turn.contract");
  const replies = countOf("SELECT COUNT(*) AS n FROM notification_outbox WHERE idempotency_key = ?", "t:l6-nosuch:contract_invalid");
  const ok = t1.fired === 0 && t2.fired === 0 && fuseRows === 0 && fuseRuns === 0 && turn.ok === true && turnCalls === 1 && turnRows === 0
    && bad.ok === false && bad.error?.code === "TASK_CONTRACT_INVALID" && refusals.length === 1 && pair(refusals) === "refuse/unknown_program" && nullIds(refusals) && replies === 1;
  return { ok, detail: `fuse cycle: fired ${t1.fired},${t2.fired} (want 0,0) turn.contract rows ${fuseRows} (want 0) runs ${fuseRuns} (want 0) | telegram turn: turn.contract calls ${turnCalls} (want 1) rows ${turnRows} (want 0) | /run nosuch: ${bad.ok ? "ok" : bad.error?.code} (want TASK_CONTRACT_INVALID) rows ${refusals.length} [${pair(refusals)}] (want 1 [refuse/unknown_program]) run_id null ${nullIds(refusals)} :contract_invalid replies ${replies} (want 1)` };
}

// ---- line 7: record faults never change what happens ----
const failedIncidents = () => all("SELECT subject, state FROM incidents WHERE kind = 'decision_record_failed'");
const incidentAlerts = () => all("SELECT target_json FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'").map((r) => String(JSON.parse(r.target_json).chat_id));
async function line7() {
  const open0 = failedIncidents().filter((i) => i.state === "open").length; const out0 = outboxN(); const alerts0 = incidentAlerts().length; const c222 = chatOutbox(String(CHAT));
  const real = G.store.insertDecision.bind(G.store); let fired = 0;
  const sch = dueSchedule("l7a"); G.gateSchedules.push(sch.schedule_id); const id = nextId(); const s = snap(); let sent = []; let res;
  G.store.insertDecision = () => { fired += 1; throw new Error("gate fault: insertDecision"); };
  try {
    sent = (await captured(() => pollRun([senderUpdate("message", { id, from: STRANGER })]))).value;
    res = (await captured(() => tick(gateway()))).value;
  } finally { G.store.insertDecision = real; }
  const faultOutbox = outboxN() - out0;
  const open = failedIncidents().filter((i) => i.state === "open").map((i) => i.subject).sort(); const newAlerts = incidentAlerts().slice(alerts0);
  const runs = runOf(sch.schedule_id);
  const faultOk = fired >= 2 && open.length - open0 === 2 && open.join(",") === "intake.sender,turn.contract" && faultOutbox === 2 && newAlerts.length === 2 && newAlerts.every((t) => t === STUB_CHAT)
    && chatOutbox(String(CHAT)) - c222 === 0 && !sent.includes(String(CHAT)) && skipCode(id) === "TELEGRAM_AUTH_DENIED" && G.store.getOffset("telegram") === id + 1
    && res.fired === 1 && runs.length === 1 && stripped(runs[0]) && rowsAfter(s.mark, "turn.contract").length === 0 && rowsAfter(s.mark, "intake.sender").length === 0;
  // a recorder that throws past the store recorder (decide.ts:173): no incident, no alert, same results, the error logged
  const inc1 = failedIncidents().length; const out1 = outboxN(); const id2 = nextId(); const sch2 = dueSchedule("l7b"); G.gateSchedules.push(sch2.schedule_id);
  const thrower = { record: () => { throw new Error("gate fault: record"); } };
  const gw = gateway(); gw.recorderCache = thrower;
  const poll = await captured(() => pollItem(G.d, G.store, [senderUpdate("message", { id: id2, from: STRANGER })], { recorder: thrower }));
  const fire = await captured(() => tick(gw));
  const logSender = poll.seen.filter((l) => l.startsWith("decisions: intake.sender record threw past the recorder")).length;
  const logContract = fire.seen.filter((l) => l.startsWith("decisions: turn.contract record threw past the recorder")).length;
  const runs2 = runOf(sch2.schedule_id);
  const throwOk = failedIncidents().length - inc1 === 0 && outboxN() - out1 === 0 && poll.value.emitted.length === 0 && skipCode(id2) === "TELEGRAM_AUTH_DENIED" && poll.value.offset === id2 + 1
    && fire.value.fired === 1 && runs2.length === 1 && stripped(runs2[0]) && logSender === 1 && logContract === 1;
  return { ok: faultOk && throwOk, detail: `store fault: open incidents +${open.length - open0} [${open.join(",")}] (want 2 [intake.sender,turn.contract]) · outbox +${faultOutbox} (want 2) · alerts +${newAlerts.length} (want 2) all to ${STUB_CHAT} ${newAlerts.every((t) => t === STUB_CHAT)} · rows to chat ${CHAT} +${chatOutbox(String(CHAT)) - c222} (want 0) · skip ${skipCode(id)} · sent to ${CHAT} ${sent.includes(String(CHAT))} (want false) · fired ${fired >= 2 ? "both" : fired} · run ${runs.length} stripped ${runs.length ? stripped(runs[0]) : "n/a"} | recorder throw: incidents +${failedIncidents().length - inc1} (want 0) outbox +${outboxN() - out1} (want 0) fired ${fire.value.fired} (want 1) logged ${logSender},${logContract} (want 1,1)` };
}

// ---- line 8: /status and the lock ----
async function line8() {
  const sv = await import(join(DIST, "decisions/status-view.js")); const reg = await import(join(DIST, "decisions/registry.js"));
  const lines = sv.decisionStatusLines(G.store, wall()); const parts = []; let ok = true;
  for (const id of IDS) {
    const mine = lines.filter((l) => l.startsWith(`· ${id} `));
    const shown = mine.length === 1 ? Number(/^· \S+ (\d+) — /.exec(mine[0])?.[1] ?? NaN) : NaN;
    const total = idRows(id);
    if (!(mine.length === 1 && total > 0 && shown === total)) ok = false;
    parts.push(`${id} lines ${mine.length} (want 1), count ${Number.isNaN(shown) ? "none" : shown} (rows ${total})`);
  }
  const move = (entry_id) => G.store.insertLadderMove({ entry_id, scope: "g", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "paco", granted_via: "gate", paco_callback_id: "cb", revocable: true });
  const before = countOf("SELECT COUNT(*) AS n FROM ladder_moves WHERE entry_id = 'intake.sender'");
  let code = "not refused";
  try { move("intake.sender"); } catch (e) { code = e?.code ?? errCode(e); }
  const after = countOf("SELECT COUNT(*) AS n FROM ladder_moves WHERE entry_id = 'intake.sender'");
  const e = reg.entryById("intake.sender");
  if (!(code === "locked_entry" && after === before && e?.locked === true)) ok = false;
  return { ok, detail: `${parts.join(" · ")} · insertLadderMove(intake.sender) -> ${code} (want locked_entry) · ladder_moves rows ${before} -> ${after} · registry locked ${e?.locked}` };
}

// ---- main ----
function pinEnv(root) {
  G.saved = Object.fromEntries([...SET_PINS, ...DELETE_PINS, ...Object.keys(process.env).filter((k) => k.startsWith("HOUGE_OMP_"))].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(G.saved)) delete process.env[k];
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-gate/omp" });
}
function restoreEnv() {
  if (!G.saved) return;
  delete process.env.HOUGE_OMP_BIN;
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
  for (const k of ["storeOptionsFor", "RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "runTelegramPollOnce", "createTelegramLongPollingAdapter", "storeRecorder"]) if (!G.d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  G.store = G.d.RunStore.open(G.base, G.d.storeOptionsFor(undefined, {}));
  G.work = join(root, "work"); mkdirSync(G.work, { recursive: true });
  // The copy's outbox must not hold anything the poll cycle's dispatch flush would send through the stub (sendMessage counts are then exact).
  const pending = parkOutbox();
  const prior = IDS.map((id) => idRows(id));
  note(`copy: ${pending} non-final outbox row(s) parked on the copy; prior rows of the new ids ${prior.join(",")}`);
}
function closeAll() { try { G.store?.close(); } catch { /* a closed handle is not a finding */ } G.store = null; }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });

try {
  await setup();
  const lines = [[1, "stranger denied silently", line1], [2, "forward and channel post denied", line2], [3, "stranger tap leaves the approval", line3], [4, "Paco's text records nothing", line4],
    [5, "schedule strip row, once", line5], [6, "fuse silent, refusal recorded", line6], [7, "record faults", line7], [8, "/status and the lock", line8]];
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
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
