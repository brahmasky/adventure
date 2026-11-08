#!/usr/bin/env node
// Live gate — decision ladder remainder R7, attach.path at parse and send (spec 2026-11-08 R7 §7; plan Task 8).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/live-gate-ladder-remainder-r7.mjs [--live-db <path>]
// Seven lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all seven PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. Only counts, booleans, codes and run labels are printed, never message text, file paths or any id of the live DB.
// The live DB is opened read-only, twice, by VACUUM INTO two temp copies under /tmp/hg-s4d-*: A (lines 1, 3, 7) and B, cut from the untouched live DB (lines 2, 4, 5, 6).
// Every file is removed on every exit path (finally, SIGINT, SIGTERM, SIGHUP, SIGQUIT, uncaughtException, unhandledRejection). The recorder-less reference of each send
// line runs on a third, throwaway store: a fresh empty one under the same root (no live data), whose dispatcher is built without `recorder`.
// No env file is loaded (HOUGE_ENV_FILE only locates the DB). No real omp child (tests/fixtures/fake-omp.mjs under CoreWorker.submitTurn), no real Telegram (a fake client),
// no subscription call. Synthetic text only. Safety pins, set before any store opens and restored on exit: HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root,
//   HOUGE_TELEGRAM_CHAT_ID = -1003 (a stub), every HOUGE_*_ENABLED flag and the omp, model-roles and embed variables deleted (tests/telegram/sender-decision-wiring.test.ts:11).
// Before seeding, every non-final outbox row of each copy is parked (failed_terminal), so dispatchOnce can only claim the seeded row; each line asserts that row was the one delivered.
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, canon, cleanupTemp, initTemp, loadDist, redactForPrint } from "./stage4-diff-lib.mjs";
import { cleanup, cleanupSettled, removeDataDirsSync } from "./stage4-supervisor-fixture.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const FAKE_OMP = resolve(new URL("../tests/fixtures/fake-omp.mjs", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const STUB_CHAT = "-1003"; // HOUGE_TELEGRAM_CHAT_ID: a stub, never a real chat
const CHAT = "555"; // the notify chat of every seeded run; its workspace is <data>/omp/workspace/chat-555
const AP = "attach.path";
const MIB = 1024 * 1024;
const BIG = 1_000_000_000;
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_DAEMON_TMP_DIR"];
const DELETE_PINS = ["HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES", "HOUGE_MODEL_ROLES", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG",
  "HOUGE_EMBED_URL", "HOUGE_EMBED_MODEL", "HOUGE_EMBED_TIMEOUT_MS", "HOUGE_MAX_CONSECUTIVE_CLARIFY", "HOUGE_LESSON_CAP_PER_SCOPE", "HOUGE_CHAT_CONTEXT_TURNS"];
const FAKE_VARS = ["HOUGE_OMP_BIN", "HOUGE_OMP_SANDBOX", "HOUGE_OMP_ENV_PASSTHROUGH", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"];
const out = [];
const G = { d: null, root: null, A: null, B: null, T: null, saved: null, n: 0, seq: 0, mods: null };
const note = (s) => console.error(`# ${s}`);
const wall = () => new Date().toISOString();
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const all = (store, sql, ...args) => store.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const countOf = (store, sql, ...args) => store.db.prepare(sql).get(...args).n;

function verdict(n, name, ok, detail) {
  out.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${name} — ${redactForPrint(detail)}`);
  // redactForPrint caps a print at 200 chars: the whole detail goes to stderr too, one redacted segment per line, so a FAIL always shows its cause
  for (const seg of String(detail).split(" · ")) for (let i = 0; i < seg.length; i += 190) note(`  ${n}: ${redactForPrint(seg.slice(i, i + 190))}`);
}
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError"]);
/** A thrown value prints as its standard class name only, never its message. */
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");
/** A thrown message, only when it is one of this gate's own fixed strings or a Node errno code (never an fs message, which carries paths, or anything from the DB). */
const closedMsg = (e) => {
  const m = e instanceof Error ? e.message : "";
  if (/^gate(?: fault)?: [a-zA-Z .]{1,60}$/.test(m)) return `(${m})`; // only a strict match prints the message
  return /^[A-Z][A-Z0-9_]{2,20}$/.test(e?.code ?? "") ? `(${e.code})` : "";
};
async function runLine(n, name, fn) {
  try { const r = await fn(); verdict(n, name, r.ok, r.detail); } catch (e) { verdict(n, name, false, `threw: ${errCode(e)} ${closedMsg(e)}`); }
}
/** console.error captured (not printed) while `fn` runs; the lines are returned for counting, never echoed. */
async function captured(fn) {
  const real = console.error; const seen = [];
  console.error = (...a) => { seen.push(a.map(String).join(" ")); };
  try { return { value: await fn(), seen }; } finally { console.error = real; }
}

// ---- the live-DB copies ----
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
const NON_FINAL = "state NOT IN ('delivered', 'failed_terminal')";
/** Marks every non-final outbox row of `store` failed_terminal (the copy is disposable); returns how many. */
const parkOutbox = (store) => store.db.prepare(`UPDATE notification_outbox SET state = 'failed_terminal' WHERE ${NON_FINAL}`).run().changes;
/** The same, sparing `id`. */
const parkExcept = (store, id) => store.db.prepare(`UPDATE notification_outbox SET state = 'failed_terminal' WHERE ${NON_FINAL} AND notification_id != ?`).run(id).changes;

// ---- a data dir, files, a seeded final_report ----
/** A fresh data dir whose chat-555 workspace is a real directory chain (verifiedWorkspace passes). Short names: a bridge socket path must fit sun_path. */
function mkData(tag) {
  G.seq += 1;
  const data = join(G.root, `${tag}${G.seq}`); const ws = G.d.chatWorkspace(data, CHAT);
  mkdirSync(ws, { recursive: true });
  return { data, ws };
}
/** The six-path corpus of line 1: [small (1 KiB), big (21 MiB sparse), hard link, symlink out, f5, f6]. Absolute paths, in order. */
function sixFiles(data, ws) {
  const w = (n, c) => { const p = join(ws, n); writeFileSync(p, c); return p; };
  const small = w("small.txt", "s".repeat(1024));
  const big = w("big.bin", ""); truncateSync(big, 21 * MIB);
  const notes = join(ws, "notes.txt"); const o1 = join(data, "notes.out"); writeFileSync(o1, "outside"); linkSync(o1, notes);
  const leak = join(ws, "leak.txt"); const o2 = join(data, "leak.out"); writeFileSync(o2, "outside"); symlinkSync(o2, leak);
  return [small, big, notes, leak, w("f5.txt", "five"), w("f6.txt", "six")];
}
/** One run through Gateway.intake on chat 555, its own actor. */
function mkRun(store) {
  G.n += 1;
  const gw = new G.d.Gateway(store, { ...G.d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG });
  const r = gw.intake(G.d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "synthetic", requested_by: { kind: "user", id: `gate-r7-actor-${G.n}` },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `gate-r7:${G.n}`, source_reference: `telegram:update:${G.n}:message:${G.n}` }));
  if (!r.ok) throw new Error("gate: run intake refused");
  return r.run_id;
}
/** A run and its final_report row carrying `paths`. */
function seedReport(store, paths) {
  const run = mkRun(store);
  store.enqueueFinalReportNotification(run, { text: "here you go", report_path: "r.md", attachments: paths });
  const id = all(store, "SELECT notification_id FROM notification_outbox WHERE run_id = ? AND intent_type = 'final_report'", run)[0]?.notification_id;
  if (!id) throw new Error("gate: seeded final_report row missing");
  return { run, id };
}
/** The fake Telegram client: every sendMessage and sendDocument call, in order. */
function mkClient() {
  const log = [];
  return { log, client: {
    sendMessage: async (m) => { log.push(["msg", m.text.startsWith("⚠") ? m.text : sha(m.text)]); return { message_id: log.length }; },
    sendDocument: async (doc) => { log.push(["doc", doc.filename, doc.content.length, sha(Buffer.from(doc.content))]); }
  } };
}
/** What must be byte-equal with and without the recorder: the uploads and the "⚠ Not attached" follow-up text. */
const uploadsOf = (log) => log.filter((e) => e[0] === "doc").map((e) => e.slice(1));
const followOf = (log) => log.filter((e) => e[0] === "msg" && e[1].startsWith("⚠")).map((e) => e[1]);
const viewOf = (log) => canon({ uploads: uploadsOf(log), follow: followOf(log) });
const attachRows = (store, run) => all(store, "SELECT verdict, reason_code, rung, run_id, tool_call_id FROM decisions WHERE entry_id = ? AND run_id = ? ORDER BY rowid", AP, run);
const rowsStr = (rows) => rows.map((r) => `${r.verdict}/${r.reason_code}`);
const localAdapter = () => new G.mods.Local(() => undefined);

/** The recorder-less run of `seed(data, ws)`: the T store, a dispatcher built without `recorder`. Returns the client log, the dispatch result, the T attach.path row count. */
async function recorderLess(seed) {
  const { data, ws } = mkData("t"); const paths = seed(data, ws); const { id } = seedReport(G.T, paths);
  parkExcept(G.T, id);
  const { client, log } = mkClient();
  const d = new G.d.NotificationDispatcher(new G.d.NotificationOutbox(G.T), { local: localAdapter(), telegram: G.d.workspaceTelegramAdapter(client, data) }, {});
  const res = await d.dispatchOnce("gate-ref");
  return { log, delivered: res.status === "delivered" && res.notification_id === id, attachN: countOf(G.T, "SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", AP) };
}
const stateOf = (store, id) => store.getNotification(id)?.state;

// ---- the window-aware prior (R6 precedent): /status counts the last 24 h, so a baseline over all rows would drift ----
const WINDOW_MS = 24 * 3_600_000;
/** attach.path rows of `store` inside the renderer's window, bucketed as the suffix does (rung fail -> failed, marker_outside -> parse, other refusals -> send). */
function priorWindow(store, now = wall()) {
  const since = new Date(Date.parse(now) - WINDOW_MS).toISOString();
  const rows = all(store, "SELECT rung, verdict, reason_code FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ?", AP, since, now);
  const refused = rows.filter((r) => r.verdict === "refuse"); const failed = refused.filter((r) => r.rung === "fail").length;
  const parse = refused.filter((r) => r.rung !== "fail" && r.reason_code === "marker_outside").length;
  return { total: rows.length, rows, code: rows.filter((r) => r.rung === "rule").length, parse, send: refused.length - failed - parse, failed };
}
const RUNG_ORDER = ["rule", "system_one", "model", "paco", "fail"]; const RUNG_LABEL = { rule: "code", system_one: "Jev", model: "model", paco: "you", fail: "fallback" };
/** The `/status` base count line for a set of rows (digest.ts countLines order), so a prior in-window row of any rung is expected, not refused. */
function rungLine(rows) {
  const m = new Map(); for (const r of rows) m.set(r.rung, (m.get(r.rung) ?? 0) + 1);
  const known = RUNG_ORDER.filter((k) => m.has(k)).map((k) => `${RUNG_LABEL[k]} ${m.get(k)}`);
  const other = [...m.keys()].filter((k) => !RUNG_ORDER.includes(k)).sort().map((k) => `${k} ${m.get(k)}`);
  return `· ${AP} ${rows.length} — ${[...known, ...other].join(" · ")}`;
}
const allRows = (store) => countOf(store, "SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", AP);
/** One synthetic 2-day-old refusal, so a baseline taken over ALL rows (not the window) fails line 7. */
function plantOld(store) {
  store.insertDecision({ entry_id: AP, entry_version: G.d.ATTACH_PATH.version, run_id: null, tool_call_id: null, stage: G.d.ATTACH_PATH.stage, rung: "rule", verdict: "refuse", p: null,
    reason_code: "too_large", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0, created_at: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString() });
}

// ---- line 1 ----
const WANT_FOLLOW = "⚠ Not attached: big.bin (over 20 MB)\n⚠ Not attached: notes.txt (a hard-linked file)\n⚠ Not attached: leak.txt (outside my workspace)\n⚠ Not attached: f6.txt (more than 5 files)";
const WANT_ROWS = ["refuse/too_large", "refuse/linked", "refuse/outside_workspace", "refuse/over_count"];
async function line1() {
  const ref = await recorderLess(sixFiles);
  const { data, ws } = mkData("a"); const paths = sixFiles(data, ws); const { run, id } = seedReport(G.A, paths);
  parkExcept(G.A, id);
  // ordering (Rev 1.1): every attach.path insert reads the seeded row's state first; a timestamp cannot prove order (both can share a millisecond)
  const seen = []; const real = G.A.insertDecision.bind(G.A);
  G.A.insertDecision = (row) => { if (row.entry_id === AP) seen.push(stateOf(G.A, id)); return real(row); };
  const { client, log } = mkClient(); let res;
  try { res = await G.mods.createOutboxDispatcher(G.A, { local: localAdapter(), telegram: G.d.workspaceTelegramAdapter(client, data) }).dispatchOnce("gate-1"); }
  finally { G.A.insertDecision = real; }
  const rows = attachRows(G.A, run); const up = uploadsOf(log); const follow = followOf(log);
  const ok = res.status === "delivered" && res.notification_id === id && stateOf(G.A, id) === "delivered" && ref.delivered && ref.attachN === 0
    && canon(up.map((u) => u[0])) === canon(["small.txt", "f5.txt"]) && up[0][1] === 1024 && viewOf(log) === viewOf(ref.log)
    && canon(follow) === canon([WANT_FOLLOW]) && canon(rowsStr(rows)) === canon(WANT_ROWS) && rows.every((r) => r.run_id === run && r.tool_call_id === null && r.rung === "rule")
    && countOf(G.A, "SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ? AND verdict = 'send'", AP) === 0
    && seen.length === 4 && seen.every((s) => s === "delivered");
  return { ok, detail: `dispatch ${res.status} seeded row delivered ${stateOf(G.A, id) === "delivered"} · sendDocument ${up.length} (want 2: ${up.map((u) => u[0])}) small bytes ${up[0]?.[1]} (want 1024) · follow-ups ${follow.length} (want 1) byte-equal to want ${canon(follow) === canon([WANT_FOLLOW])} to recorder-less ${viewOf(log) === viewOf(ref.log)} · rows [${rowsStr(rows)}] (want ${WANT_ROWS}) with the run id ${rows.every((r) => r.run_id === run)} · accepted/send rows 0 · state at each record call [${seen}] (want 4 x delivered) · recorder-less rows ${ref.attachN} (want 0)` };
}

// ---- line 2 ----
async function line2() {
  const ref = await recorderLess(sixFiles);
  const { data, ws } = mkData("b"); const paths = sixFiles(data, ws); const { run, id } = seedReport(G.B, paths);
  parkExcept(G.B, id);
  const { client, log } = mkClient(); const project = join(G.root, `p${G.seq}`); mkdirSync(project, { recursive: true });
  const res = await G.d.runTelegramPollOnce({ store: G.B, projectRoot: project, omp: { dataDir: data, distDir: DIST },
    allowlist: { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 555, label: "p", allowed_identity_ids: ["paco"] }] },
    telegramClient: { getUpdates: async () => [], ...client } });
  const rows = attachRows(G.B, run); const total = countOf(G.B, "SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", AP);
  const ok = stateOf(G.B, id) === "delivered" && ref.delivered && viewOf(log) === viewOf(ref.log) && canon(rowsStr(rows)) === canon(WANT_ROWS)
    && rows.every((r) => r.run_id === run) && total === G.priorAllB + 4 && res.dispatch_results.some((r) => r.status === "delivered" && r.notification_id === id);
  return { ok, detail: `poll cycle processed ${res.processed_updates} updates, ${res.dispatch_results.filter((r) => r.status === "delivered").length} delivered · seeded row delivered ${stateOf(G.B, id) === "delivered"} · uploads and follow-up byte-equal to recorder-less ${viewOf(log) === viewOf(ref.log)} (uploads ${uploadsOf(log).length}) · rows [${rowsStr(rows)}] (want ${WANT_ROWS}) run_id equals the outbox row's ${rows.every((r) => r.run_id === run)} · poll dispatch_results delivered the seeded id ${res.dispatch_results.some((r) => r.status === "delivered" && r.notification_id === id)} · attach.path rows on the copy ${total} (want ${G.priorAllB} prior + 4)` };
}

// ---- a CoreWorker turn on the fake omp (copy store `store`, chat 555) ----
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
async function waitTerminal(store, run, ms = 30_000) {
  const end = Date.now() + ms;
  while (!TERMINAL.has(store.getRunState(run))) { if (Date.now() > end) throw new Error("gate: run did not finish"); await new Promise((r) => setTimeout(r, 20)); }
}
const TEXT = "ok\n[[attach: in.txt]]\n[[attach: ../outside.txt]]";
/** One CoreWorker (production deps) over `store` with the fake omp answering `scenario`; `beforeSubmit(work, project)` runs after the worker is built. Returns { run, state, ws }. */
async function workerTurn(store, scenario, beforeSubmit = () => undefined) {
  const { data: work, ws } = mkData("w"); writeFileSync(join(ws, "in.txt"), "inside");
  const scenFile = join(G.root, `scenario-${G.seq}.json`);
  writeFileSync(scenFile, JSON.stringify(scenario));
  Object.assign(process.env, { HOUGE_OMP_BIN: FAKE_OMP, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG", FAKE_OMP_SCENARIO: scenFile, FAKE_OMP_ARGV_LOG: join(G.root, `argv-${G.seq}.log`) });
  const project = join(work, "project"); let worker = null;
  try {
    worker = new G.d.CoreWorker(store, project, async () => ({ ok: true, output: { answer: "stub" } }), undefined, undefined, undefined, undefined, undefined, undefined,
      async () => null, undefined, undefined, { dataDir: work, distDir: DIST, jevFetch: async () => { throw new Error("gate: no network"); } });
    beforeSubmit(project);
    const run = mkRun(store);
    worker.submitTurn(run); await waitTerminal(store, run);
    return { run, state: store.getRunState(run), ws, work };
  } finally {
    try { await worker?.shutdownPlanners(); } catch { /* a stopped planner is not a finding */ }
    for (const k of FAKE_VARS) delete process.env[k];
    process.env.HOUGE_OMP_BIN = "/nonexistent/houge-gate/omp";
  }
}
const finalReportOf = (store, run) => all(store, "SELECT notification_id, payload_json FROM notification_outbox WHERE run_id = ? AND idempotency_key = ?", run, `${run}:final_report`);
const assistantText = (store, run) => all(store, "SELECT text FROM chat_turns WHERE run_id = ? AND role = 'assistant'", run);

// ---- line 3 ----
async function line3() {
  const t = await workerTurn(G.A, { "*": { rpcText: TEXT } });
  const rows = attachRows(G.A, t.run); const fr = finalReportOf(G.A, t.run); const payload = fr.length === 1 ? JSON.parse(fr[0].payload_json) : {};
  const turns = assistantText(G.A, t.run);
  const ok = t.state === "completed" && canon(payload.attachments) === canon([join(t.ws, "in.txt")]) && canon(rowsStr(rows)) === canon(["refuse/marker_outside"]) && rows[0].run_id === t.run
    && turns.length === 1 && !turns[0].text.includes("[[attach:");
  return { ok, detail: `state ${t.state} (want completed) · final_report rows ${fr.length} (want 1) attachments ${canon(payload.attachments) === canon([join(t.ws, "in.txt")])} (want the inside file only) · rows [${rowsStr(rows)}] (want refuse/marker_outside) run id ${rows[0]?.run_id === t.run} · stored assistant turns ${turns.length} (want 1) marker-free ${turns.length === 1 && !turns[0].text.includes("[[attach:")}` };
}

// ---- line 4 ----
async function line4() {
  const lost = await workerTurn(G.B, { "*": { rpcText: TEXT, rpcAbortAfterText: true } });
  const lostRows = attachRows(G.B, lost.run);
  const reportFile = await workerTurn(G.B, { "*": { rpcText: TEXT } }, (project) => { rmSync(join(project, "runs"), { recursive: true, force: true }); mkdirSync(project, { recursive: true }); writeFileSync(join(project, "runs"), "a file where the runs directory should be"); });
  const rows = attachRows(G.B, reportFile.run); const fr = finalReportOf(G.B, reportFile.run); const payload = fr.length === 1 ? JSON.parse(fr[0].payload_json) : { attachments: "x" };
  const failEvent = G.B.getLedgerEvents(reportFile.run).find((e) => e.event_type === "run_failed");
  parkExcept(G.B, fr[0]?.notification_id ?? "none");
  const { client, log } = mkClient();
  const res = await G.mods.createOutboxDispatcher(G.B, { local: localAdapter(), telegram: G.d.workspaceTelegramAdapter(client, reportFile.work) }).dispatchOnce("gate-4");
  const ok = lost.state === "failed" && lostRows.length === 0 && reportFile.state === "failed" && String(failEvent?.payload?.error_ref).startsWith("report_write_failed:")
    && canon(rowsStr(rows)) === canon(["refuse/marker_outside"]) && fr.length === 1 && !("attachments" in payload) && res.status === "delivered" && res.notification_id === fr[0].notification_id && uploadsOf(log).length === 0;
  return { ok, detail: `lost turn: state ${lost.state} (want failed) attach.path rows ${lostRows.length} (want 0) · report_write_failed: state ${reportFile.state} (want failed) error is report_write_failed ${String(failEvent?.payload?.error_ref).startsWith("report_write_failed:")} rows [${rowsStr(rows)}] (want refuse/marker_outside) final_report rows ${fr.length} (want 1, the failure notice) attachments key present ${"attachments" in payload} (want false) · dispatched ${res.status} sendDocument ${uploadsOf(log).length} (want 0)` };
}

// ---- line 5 ----
const failedIncidents = (s) => all(s, "SELECT incident_id, kind, subject FROM incidents WHERE kind = 'decision_record_failed'");
const logRows = (s) => all(s, "SELECT change_id FROM change_log WHERE topic = 'incident_log'");
const opened = (s) => all(s, "SELECT event_id FROM ledger_events WHERE event_type = 'incident_opened'");
const stubRows = (s) => all(s, "SELECT notification_id, target_json FROM notification_outbox").filter((r) => String(JSON.parse(r.target_json).chat_id) === STUB_CHAT);
const snap = (s) => ({ inc: failedIncidents(s).length, log: logRows(s).length, opened: opened(s).length, stub: stubRows(s).length });
async function line5() {
  parkOutbox(G.B);
  const ref = await recorderLess(sixFiles);
  const { data, ws } = mkData("f"); const { run, id } = seedReport(G.B, sixFiles(data, ws));
  parkExcept(G.B, id);
  const s0 = snap(G.B); const real = G.B.insertDecision.bind(G.B); let attempts = 0;
  G.B.insertDecision = (row) => { if (row.entry_id === AP) { attempts += 1; throw new Error("gate fault: insertDecision"); } return real(row); };
  const a = mkClient(); let res; let seenErr;
  try { seenErr = await captured(() => G.mods.createOutboxDispatcher(G.B, { local: localAdapter(), telegram: G.d.workspaceTelegramAdapter(a.client, data) }).dispatchOnce("gate-5a")); res = seenErr.value; }
  finally { G.B.insertDecision = real; }
  const s1 = snap(G.B); const inc = failedIncidents(G.B);
  const insertOk = attempts === 4 && s1.inc - s0.inc === 1 && inc.at(-1)?.subject === AP && s1.log - s0.log === 1 && s1.opened - s0.opened === 1 && s1.stub - s0.stub === 0
    && res.status === "delivered" && stateOf(G.B, id) === "delivered" && viewOf(a.log) === viewOf(ref.log) && attachRows(G.B, run).length === 0;
  // a recorder that throws past itself: no incident, no log row, the row delivered
  const t = mkData("g"); const seed2 = seedReport(G.B, sixFiles(t.data, t.ws)); parkExcept(G.B, seed2.id);
  const b = mkClient(); const s2 = snap(G.B);
  const disp = new G.d.NotificationDispatcher(new G.d.NotificationOutbox(G.B), { local: localAdapter(), telegram: G.d.workspaceTelegramAdapter(b.client, t.data) },
    { recorder: { record: () => { throw new Error("gate fault: record"); } } });
  const thrown = await captured(() => disp.dispatchOnce("gate-5b")); const s3 = snap(G.B);
  const logged = thrown.seen.filter((l) => l.startsWith(`decisions: ${AP} record threw past the recorder`)).length;
  const thrownOk = thrown.value.status === "delivered" && thrown.value.notification_id === seed2.id && stateOf(G.B, seed2.id) === "delivered" && s3.inc === s2.inc && s3.log === s2.log && s3.opened === s2.opened
    && s3.stub === s2.stub && viewOf(b.log) === viewOf(ref.log) && logged === 6;
  // a registry mistake (P20: a non-rule rung, so decideSync throws before any recorder): recordAttach's own catch logs it; the row stays delivered and the dispatch reports delivered
  const m = mkData("h"); const seed3 = seedReport(G.B, sixFiles(m.data, m.ws)); parkExcept(G.B, seed3.id);
  const c = mkClient(); const s4 = snap(G.B); const ladder = G.d.ATTACH_PATH.ladder;
  G.d.ATTACH_PATH.ladder = [{ kind: "system_one", name: "x", questions: [], bars: { kind: "provisional", question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "t" }, timeoutMs: 1 }];
  let mistake;
  try { mistake = await captured(() => G.mods.createOutboxDispatcher(G.B, { local: localAdapter(), telegram: G.d.workspaceTelegramAdapter(c.client, m.data) }).dispatchOnce("gate-5c")); }
  finally { G.d.ATTACH_PATH.ladder = ladder; }
  const s5 = snap(G.B); const mLogged = mistake.seen.filter((l) => l.startsWith("[notification-dispatcher] attach_path_record_failed for ")).length;
  const mistakeOk = mistake.value.status === "delivered" && mistake.value.notification_id === seed3.id && stateOf(G.B, seed3.id) === "delivered" && s5.inc === s4.inc && s5.log === s4.log && s5.opened === s4.opened && s5.stub === s4.stub
    && viewOf(c.log) === viewOf(ref.log) && mLogged === 1 && attachRows(G.B, seed3.run).length === 0;
  return { ok: insertOk && thrownOk && mistakeOk, detail: `insert fault: attempts ${attempts} incidents +${s1.inc - s0.inc} (want 1, subject ${inc.at(-1)?.subject}) change_log incident_log +${s1.log - s0.log} (want 1) incident_opened events +${s1.opened - s0.opened} (want 1) outbox rows to the stub chat +${s1.stub - s0.stub} (want 0) uploads and follow-up byte-equal to recorder-less ${viewOf(a.log) === viewOf(ref.log)} row delivered ${stateOf(G.B, id) === "delivered"} (dispatch ${res.status}) attach.path rows 0 · thrown recorder: dispatch ${thrown.value.status} row delivered ${stateOf(G.B, seed2.id) === "delivered"} incidents +${s3.inc - s2.inc} (want 0) change_log +${s3.log - s2.log} (want 0) incident_opened +${s3.opened - s2.opened} (want 0) uploads byte-equal ${viewOf(b.log) === viewOf(ref.log)} logged ${logged} (want 6, one per consult: five checks and the overflow, P6) · registry mistake: dispatch ${mistake.value.status} (want delivered) row delivered ${stateOf(G.B, seed3.id) === "delivered"} logged ${mLogged} (want 1) incidents +${s5.inc - s4.inc} (want 0) uploads byte-equal ${viewOf(c.log) === viewOf(ref.log)}` };
}

// ---- line 6 ----
async function line6() {
  const reg = await import(join(DIST, "decisions/registry.js")); const ids = await import(join(DIST, "decisions/entry-ids.js"));
  const e = reg.entryById(AP);
  const before = countOf(G.B, "SELECT COUNT(*) AS n FROM ladder_moves WHERE entry_id = ?", AP);
  let code = "not refused";
  try { G.B.insertLadderMove({ entry_id: AP, scope: "g", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "paco", granted_via: "gate", paco_callback_id: "cb", revocable: true }); } catch (x) { code = x?.code ?? errCode(x); }
  const after = countOf(G.B, "SELECT COUNT(*) AS n FROM ladder_moves WHERE entry_id = ?", AP);
  const kinds = e?.ladder.map((r) => r.kind); const problems = e ? reg.entryProblems(e) : ["missing"];
  const ok = ids.ENTRY_IDS.length === 40 && e?.locked === true && canon(kinds) === canon(["rule"]) && code === "locked_entry" && after === before && problems.length === 0;
  return { ok, detail: `ENTRY_IDS ${ids.ENTRY_IDS.length} (want 40) · ${AP} locked ${e?.locked} ladder [${kinds}] (want rule) · insertLadderMove -> ${code} (want locked_entry) ladder_moves rows ${before} -> ${after} · entryProblems ${problems.length} (want 0)` };
}

// ---- line 7 ----
async function line7() {
  const sv = await import(join(DIST, "decisions/status-view.js"));
  const p = G.priorA; const now = wall();
  const want = `${rungLine([...p.rows, ...Array.from({ length: 5 }, () => ({ rung: "rule" }))])} (parse ${p.parse + 1} · send ${p.send + 4} · failed ${p.failed})`;
  const lines = sv.decisionStatusLines(G.A, now).filter((l) => l.startsWith(`· ${AP} `));
  const total = allRows(G.A); const win = priorWindow(G.A, now);
  return { ok: lines.length === 1 && lines[0] === want && total === G.priorAllA + 5 && win.total === p.total + 5, detail: `lines ${lines.length} (want 1) · ${lines[0] ?? "none"} (want ${want}; in-window prior ${p.total} + line 1's four send refusals + line 3's one parse refusal) · rows on copy A ${total} (want ${G.priorAllA} prior incl. one planted 2-day-old + 5) · in-window ${win.total} (want ${p.total + 5})` };
}

// ---- main ----
function pinEnv(root) {
  const flags = Object.keys(process.env).filter((k) => /^HOUGE_[A-Z0-9_]+_ENABLED$/.test(k) || k.startsWith("HOUGE_OMP_"));
  G.saved = Object.fromEntries([...SET_PINS, ...DELETE_PINS, ...flags].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(G.saved)) delete process.env[k];
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT,
    HOUGE_OMP_BIN: "/nonexistent/houge-gate/omp", HOUGE_MODEL_ROLES: "static", HOUGE_DAEMON_TMP_DIR: join(root, "dtmp") });
}
function restoreEnv() {
  if (!G.saved) return;
  for (const k of FAKE_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(G.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  G.saved = null;
}
const killFiles = () => [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
async function loadMods() {
  G.d = await loadDist(DIST);
  for (const k of ["storeOptionsFor", "RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "CoreWorker", "NotificationOutbox", "NotificationDispatcher", "workspaceTelegramAdapter", "chatWorkspace", "runTelegramPollOnce", "ATTACH_PATH"])
    if (!G.d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  G.mods = { Local: (await import(join(DIST, "notifications/local-notification-adapter.js"))).LocalNotificationAdapter,
    createOutboxDispatcher: (await import(join(DIST, "telegram/telegram-daemon.js"))).createOutboxDispatcher };
  if (!G.mods.Local || !G.mods.createOutboxDispatcher) throw new SetupError("LocalNotificationAdapter or createOutboxDispatcher missing: rebuild");
}
const openStore = (path) => G.d.RunStore.open(path, G.d.storeOptionsFor(undefined, {}));
async function setup() {
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  if (killFiles() !== 0) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  const root = initTemp(false); G.root = root;
  pinEnv(root);
  await loadMods();
  vacuumInto(liveDb, join(root, "a.sqlite")); vacuumInto(liveDb, join(root, "b.sqlite")); // both from the untouched live DB
  G.A = openStore(join(root, "a.sqlite")); G.B = openStore(join(root, "b.sqlite")); G.T = openStore(join(root, "t.sqlite"));
  plantOld(G.A); plantOld(G.B);
  G.priorA = priorWindow(G.A); G.priorAllA = allRows(G.A); G.priorAllB = allRows(G.B);
  G.liveAttach = G.priorAllA - 1;
  note(`copies: non-final outbox rows parked A ${parkOutbox(G.A)} · B ${parkOutbox(G.B)}; attach.path rows already on the copies ${G.liveAttach}`);
}
function closeAll() { for (const k of ["A", "B", "T"]) { try { G[k]?.close(); } catch { /* a closed handle is not a finding */ } G[k] = null; } }
// PlannerSupervisor.shutdown can wait ~5 s on a draining turn before it stops the session; the bound covers that plus margin.
const SETTLE_BOUND_MS = 15_000;
/** Every exit path removes the copies: the signals (SIGKILL cannot be caught), and an exception or rejection that escapes the main try. */
function bail(code) {
  Promise.race([cleanupSettled().catch(() => undefined), new Promise((r) => setTimeout(r, SETTLE_BOUND_MS))])
    .finally(() => { removeDataDirsSync(); closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });
}
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]]) process.on(sig, () => bail(code));
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.error(`${ev}: ${errCode(e)}`); bail(2); });

try {
  await setup();
  const lines = [[1, "send on the production dispatcher", line1], [2, "wiring through the poll runner", line2], [3, "parse on the production path", line3],
    [4, "lost turn and lost run", line4], [5, "record faults", line5], [6, "registry", line6], [7, "/status", line7]];
  for (const [n, name, fn] of lines) await runLine(n, name, fn);
  const tomb = killFiles();
  if (tomb !== 0) { out.push(false); console.log(`FAIL post houge.kill — found ${tomb} (want 0)`); }
  const passed = out.filter(Boolean).length;
  note(`${passed}/7 PASS · houge.kill in cwd/main checkout ${tomb} (want 0)`);
  process.exitCode = out.length === 7 && passed === 7 ? 0 : 1;
} catch (e) {
  console.error(e instanceof SetupError ? `setup_failed: ${e.message}` : `setup_failed: ${errCode(e)}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  await cleanup().catch(() => undefined);
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
