#!/usr/bin/env node
// Live gate — loud degradation Parts B and C (spec 2026-11-02 §9; plan Task 13): boot resolve, daily reminder, the transcript carry
// and its /fresh exit on a copy of the live DB, and a REAL omp /fresh across a restart.
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-loud-degradation.mjs [--live-db <path>] [--only <n>[,<n>]] [--dist <path>] [--debug]
// Seven lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`, then one `PASS|FAIL gate — <p>/<n> checks`; exit 0 only when all PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. Only fixed codes, counts, booleans and closed labels are printed: never message text, a model reply,
// an error text, e.message, a stack (--debug adds a class name from a closed allowlist to stderr), or any id of the live DB.
// THIS GATE SPENDS REAL SUBSCRIPTION QUOTA: line 6 starts real omp RPC children under profile `houge` (throwaway dirs under the temp root) and
// sends THREE one-line prompts ("Reply with exactly OK.") on the probe's cheapest model (pickProbeModel). Jev and every DISARM_FLAGS flag are
// off, as `live-gate-omp.mjs --smoke` sets them. Nothing talks to Telegram (no client; the outbox of the copy is the only sink).
// The live DB is opened read-only, once, by VACUUM INTO a temp copy under /tmp/hg-s4d-*, removed on every exit path (finally, SIGINT, SIGTERM, SIGHUP).
// Env, set once, in this order, before the copy is made and before any store opens: loadHougeEnv() -> smokeEnv (HOUGE_TELEGRAM_* deleted, every disarm
// flag false, tombstone / park marker / disarm path under the temp root) -> the pins (HOUGE_TELEGRAM_CHAT_ID=-1003 last). No .env value overrides a pin.
// --only <n>[,<n>]: assert only those lines (the setup always runs; line 6 alone spends quota). --sim-leak: dev seam, prints the operator chat id so line 7 must FAIL.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, canon, cleanupTemp, initTemp, loadDist, redactForPrint } from "./stage4-diff-lib.mjs";
import { cleanup, fakeSession, mkSupervisor, req } from "./stage4-supervisor-fixture.mjs";

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const DIST = resolve(arg("--dist") ?? new URL("../dist", import.meta.url).pathname);
if (!DIST.includes("/.worktrees/") || !new URL(import.meta.url).pathname.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const DEBUG = argv.includes("--debug");
const ONLY = arg("--only") ? new Set(arg("--only").split(",").map(Number)) : null;
const want = (n) => ONLY === null || ONLY.has(n);

const STUB_CHAT = "-1003"; // numeric (CoreWorker refuses a non-numeric chat id), not a real chat
const HOSTILE = "hostile_schedule_turn";
const HOSTILE_MIGRATION = "2026-11-02-hostile-schedule-event";
const REMIND_KINDS = ["role_unresolved", "static_list_stale", "model_catalog_unavailable", "planner_session_reset_failed"]; // literal, spec §5
const DAY_MS = 86_400_000;
const TURN_TIMEOUT_MS = 300_000;
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES"];
const out = []; const printed = [];
const G = { d: null, root: null, store: null, savedEnv: null, boot: null, operatorChat: null, envSecrets: [], n: 0, workers: [], copy: null, roles: null, cheap: null, storeOpts: null };
const note = (s) => console.error(`# ${s}`);

function verdict(n, name, ok, detail) {
  out.push(ok);
  const line = `${ok ? "PASS" : "FAIL"} ${n} ${name} — ${redactForPrint(detail)}`;
  printed.push(line);
  console.log(line);
}
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError"]);
/** A thrown value prints as its standard class name only, never its message (--debug adds only the class name to stderr). */
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");
async function runLine(n, name, fn) {
  if (!want(n)) return;
  try { const r = await fn(); verdict(n, name, r.ok, r.detail); } catch (e) {
    if (DEBUG) console.error(`# debug line ${n}: threw ${errCode(e)}`);
    verdict(n, name, false, `threw: ${errCode(e)}`);
  }
}

// ---- the live-DB copy ----
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** VACUUM INTO `to` from `from` (read-only source). The daemon writes the live DB: a lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
/** What the raw copy holds BEFORE RunStore.open runs the boot migrations (read-only). */
function readRaw(copy, operatorChat) {
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const has = (t) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
    const open = has("incidents") ? db.prepare("SELECT incident_id FROM incidents WHERE kind = ? AND state = 'open'").all(HOSTILE).map((r) => r.incident_id) : [];
    const applied = has("schema_migrations") && db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(HOSTILE_MIGRATION) !== undefined;
    const mark = has("ledger_events") ? db.prepare("SELECT COALESCE(MAX(sequence), 0) AS m FROM ledger_events").get().m : 0;
    let carry = null;
    if (operatorChat && has("planner_session_state")) {
      try { carry = db.prepare("SELECT transcript_trust FROM planner_session_state WHERE chat_id = ?").get(operatorChat)?.transcript_trust ?? null; } catch { carry = null; }
    }
    return { openIds: open, n0: open.length, applied, mark, carry };
  } finally { db.close(); }
}

// ---- store helpers (G.store is replaced by line 1's reopen: always read it through these) ----
const rows = (sql, ...a) => G.store.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const countOf = (sql, ...a) => G.store.db.prepare(sql).get(...a).n;
const seqMark = () => countOf("SELECT COALESCE(MAX(sequence), 0) AS n FROM ledger_events");
const eventsAfter = (type, mark) => rows("SELECT correlation_id, payload_json FROM ledger_events WHERE event_type = ? AND sequence > ? ORDER BY sequence", type, mark)
  .map((r) => ({ run: r.correlation_id, p: JSON.parse(r.payload_json) }));
const trustRows = (run) => eventsAfter("turn_trust", 0).filter((e) => e.run === run).map((e) => ({ level: e.p.level, cause: e.p.cause }));
const resetsAfter = (mark, reason) => eventsAfter("planner_session_reset", mark).filter((e) => reason === undefined || e.p.reason === reason).length;
const outboxByKey = (like) => rows("SELECT idempotency_key, target_json, payload_json FROM notification_outbox WHERE idempotency_key LIKE ? ORDER BY created_at, rowid", like)
  .map((r) => ({ key: r.idempotency_key, target: JSON.parse(r.target_json), payload: JSON.parse(r.payload_json) }));
const gateway = () => new G.d.Gateway(G.store, { ...G.d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: 1_000_000_000, tool_calls: 1_000_000_000, gated_attempts: 1_000_000_000 });
const typedEvent = (type, chat, extra = {}) => { G.n += 1; return G.d.buildTypedTaskEvent({ source: "telegram", type, requested_by: { kind: "user", id: `gate-ld-actor-${G.n}` }, notify: { kind: "telegram", chat_id: chat },
  idempotency_key: `gate-ld:${type}:${G.n}`, source_reference: `gate-ld:${type}:${G.n}:ref`, ...extra }); };
const turnEvent = (chat, text) => typedEvent("turn", chat, { program: "turn", goal: text });
function mkRun(chat, text) { const r = gateway().intake(turnEvent(chat, text)); if (!r.ok) throw new Error("gate: run intake refused"); return r.run_id; }
const intakeFresh = (chat) => gateway().intake(typedEvent("fresh", chat));

// ---- the fake-session turns of lines 3-5 (chat "42") ----
/** A fake session whose newSession calls are counted and whose prompts run `script.onPrompt` (swapped per turn). */
function countedSession(script) {
  const s = fakeSession(script); const real = s.newSession; s.resets = 0;
  s.newSession = async (...a) => { s.resets += 1; return real(...a); };
  return s;
}
async function fakeTurn(sup, text, source = "telegram") { const id = mkRun("42", text); sup.submit(req(id, text, source)); await sup.whenIdle(); return id; }
/** onPrompt that raises `cause` on the live turn's trust, then answers. */
const raising = (script, sess, getSup, cause) => { script.onPrompt = (_t, emit) => { emit({ type: "turn_start" }); getSup().activeTurnForTest().trust.raise(cause, "tc"); sess.assistant("answer"); emit({ type: "agent_end" }); }; };
const plain = (script) => { script.onPrompt = undefined; };
/** `env`: the supervisor's own env (the fixture's is empty, so a hostile turn's page would find no chat to alert). */
function mkFake(env) {
  const script = {}; const sess = countedSession(script); let sup;
  const rig = mkSupervisor(G.d, G.store, { session: sess, ...(env ? { extra: { env } } : {}) });
  sup = rig.sup;
  return { script, sess, sup, getSup: () => sup };
}

// ---- line 1: the boot resolve closes the hostile_schedule_turn rows once ----
async function line1() {
  const b = G.boot;
  const openAfter = countOf("SELECT COUNT(*) AS n FROM incidents WHERE kind = ? AND state = 'open'", HOSTILE);
  const wantResolved = b.applied ? 0 : b.n0; const wantOpen = 0; // zero open after RunStore.open, whether or not the migration had run
  const ev = eventsAfter("incident_resolved", b.mark);
  const idsOk = ev.every((e) => b.openIds.includes(e.p.incident_id));
  const versionRow = countOf("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?", HOSTILE_MIGRATION);
  // once: plant an open row of the kind, close and reopen: the migration must not run again, so the row stays open and no new incident_resolved appears
  const planted = G.store.openIncident({ kind: HOSTILE, subject: "gate-ld-plant", detail: {}, now: new Date().toISOString() });
  const mark2 = seqMark();
  G.store.close(); G.store = G.d.RunStore.open(G.copy, G.storeOpts);
  const again = eventsAfter("incident_resolved", mark2).length;
  const stays = G.store.getIncident(planted.incident_id)?.state === "open";
  G.store.resolveIncident(planted.incident_id, new Date().toISOString());
  const ok = openAfter === wantOpen && ev.length === wantResolved && idsOk && versionRow === 1 && again === 0 && stays;
  return { ok, detail: `N0=${b.n0}${b.n0 === 0 && b.applied ? " already_applied" : ""} migration_applied_before=${b.applied} open_after=${openAfter} (want ${wantOpen}) new_incident_resolved=${ev.length} (want ${wantResolved}) all_ids_among_the_N0=${idsOk} migration_row=${versionRow} (want 1) reopen_new_incident_resolved=${again} (want 0) planted_row_stays_open=${stays}` };
}

// ---- line 2: the daily reminder ----
async function line2() {
  const now = new Date().toISOString();
  rows("SELECT 1 AS x FROM incidents LIMIT 1"); // fail early on a broken copy
  const cutoff = (t) => Date.parse(t) - DAY_MS;
  const openRows = rows(`SELECT incident_id, kind, subject, first_seen_at FROM incidents WHERE state = 'open' AND kind IN (${REMIND_KINDS.map((k) => `'${k}'`).join(",")})`);
  const dueAt = (t) => openRows.filter((r) => Date.parse(r.first_seen_at) < cutoff(t));
  const due = dueAt(now); const wantJudges = due.some((r) => r.kind === "role_unresolved" && r.subject === "judges:2");
  const pre = countOf("SELECT COUNT(*) AS n FROM notification_outbox WHERE idempotency_key LIKE 'incident_remind:%'");
  G.store.db.prepare("DELETE FROM notification_outbox WHERE idempotency_key LIKE 'incident_remind:%'").run(); // the copy is disposable: start from no row
  const first = G.d.runIncidentReminder({ store: G.store, chatId: STUB_CHAT, env: process.env, now });
  const sent = outboxByKey("incident_remind:%");
  const text = sent[0]?.payload?.text;
  const date = G.d.formatInstantInZone(now, G.d.resolveDisplayZone(process.env)).slice(0, 10);
  const shape = /^incident_remind:\d{4}-\d{2}-\d{2}$/.test(sent[0]?.key ?? "") && sent[0]?.key === `incident_remind:${date}` && sent[0]?.target?.chat_id === STUB_CHAT;
  const bodyLines = typeof text === "string" ? text.split("\n").length - 1 : -1;
  const firstOk = due.length > 0
    ? first === "sent" && sent.length === 1 && shape && text === G.d.reminderText(G.store.listOpenIncidents(), now) && bodyLines === due.length
      && text.includes("role_unresolved · judges:2") === wantJudges && !text.includes("undelivered_notification")
    : first === "none" && sent.length === 0;
  const second = G.d.runIncidentReminder({ store: G.store, chatId: STUB_CHAT, env: process.env, now });
  const afterSecond = outboxByKey("incident_remind:%").length;
  const secondOk = second === (due.length > 0 ? "already" : "none") && afterSecond === sent.length;
  // the path does not depend on the roles mode: static, a fresh display date
  const savedRoles = process.env.HOUGE_MODEL_ROLES; process.env.HOUGE_MODEL_ROLES = "static";
  const now2 = new Date(Date.parse(now) + DAY_MS).toISOString(); const due2 = dueAt(now2);
  let third; let rows3;
  try { third = G.d.runIncidentReminder({ store: G.store, chatId: STUB_CHAT, env: process.env, now: now2 }); rows3 = outboxByKey("incident_remind:%"); }
  finally { if (savedRoles === undefined) delete process.env.HOUGE_MODEL_ROLES; else process.env.HOUGE_MODEL_ROLES = savedRoles; }
  const thirdOk = due2.length > 0 ? third === "sent" && rows3.length === 2 && new Set(rows3.map((r) => r.key)).size === 2 : third === "none" && rows3.length === 0;
  return { ok: firstOk && secondOk && thirdOk, detail: `due_at_now=${due.length} judges2_due=${wantJudges} first=${first} (want ${due.length > 0 ? "sent" : "none"}) rows=${sent.length} key_and_target_exact=${shape} text_equals_reminderText=${due.length > 0 ? text === G.d.reminderText(G.store.listOpenIncidents(), now) : "n/a"} lines_equal_due=${bodyLines === due.length} no_undelivered=${typeof text !== "string" || !text.includes("undelivered_notification")} second=${second} rows_after_second=${afterSecond} static_next_day=${third} rows_after_static=${rows3.length} (want ${due2.length > 0 ? 2 : 0}) pre_existing_rows_cleared=${pre}` };
}

// ---- line 3: the carry reaches a turn; /fresh clears it ----
async function line3() {
  const { sess, sup } = mkFake();
  const L = G.boot.carry; const label = L === "hostile" ? "copied" : "planted";
  G.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
  const t1 = await fakeTurn(sup, "t1");
  const r1 = trustRows(t1);
  const mark = seqMark(); const resetsBefore = sess.resets;
  const markerBefore = (() => { const g = intakeFresh("42"); return { g, set: G.store.freshRequestedAt("42") !== null }; })();
  await sup.onFreshRequested();
  const t2 = await fakeTurn(sup, "t2");
  const r2 = trustRows(t2);
  const ok = canon(r1) === canon([{ level: "hostile", cause: "carried_hostile" }]) && markerBefore.g.ok === true && markerBefore.g.status === "fresh_requested" && markerBefore.set
    && r2.length === 0 && G.store.freshRequestedAt("42") === null && G.store.getTranscriptTrust("42") === "clean" && sess.resets - resetsBefore === 1 && resetsAfter(mark, "fresh") === 1;
  return { ok, detail: `carry=${label} turn1_rows=${r1.length} exact_carried_hostile=${canon(r1) === canon([{ level: "hostile", cause: "carried_hostile" }])} fresh_intake=${markerBefore.g.status ?? "refused"} marker_set_before=${markerBefore.set} turn2_rows=${r2.length} (want 0) marker_after=${G.store.freshRequestedAt("42") === null ? "null" : "set"} stored=${G.store.getTranscriptTrust("42")} (want clean) session_resets=${sess.resets - resetsBefore} (want 1) fresh_reset_events=${resetsAfter(mark, "fresh")} (want 1)` };
}

// ---- line 4: a withhold-only turn stores untrusted ----
async function line4() {
  const { script, sess, sup, getSup } = mkFake();
  G.store.setTranscriptTrust("42", "clean", new Date().toISOString());
  raising(script, sess, getSup, "injection_withheld");
  const t3 = await fakeTurn(sup, "t3");
  const stored = G.store.getTranscriptTrust("42");
  plain(script);
  const t4 = await fakeTurn(sup, "t4");
  const r4 = trustRows(t4);
  const ok = stored === "untrusted" && canon(r4) === canon([{ level: "untrusted", cause: "carried_untrusted" }]) && t3 !== t4;
  return { ok, detail: `stored_after_withhold=${stored} (want untrusted) turn4_rows=${r4.length} (want 1) exact_carried_untrusted=${canon(r4) === canon([{ level: "untrusted", cause: "carried_untrusted" }])}` };
}

// ---- line 5: schedule-born turns (D3-A) ----
const hostileRows = (subject) => rows("SELECT incident_id, state FROM incidents WHERE kind = ? AND subject = ?", HOSTILE, subject);
async function line5() {
  const { script, sess, sup, getSup } = mkFake({ HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT });
  const total0 = countOf("SELECT COUNT(*) AS n FROM incidents WHERE kind = ?", HOSTILE);
  G.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
  const carried = await fakeTurn(sup, "carried", "schedule");
  const carriedRows = hostileRows(carried).length; const total1 = countOf("SELECT COUNT(*) AS n FROM incidents WHERE kind = ?", HOSTILE);
  G.store.setTranscriptTrust("42", "clean", new Date().toISOString());
  raising(script, sess, getSup, "unjudged_outside");
  const born = await fakeTurn(sup, "born", "schedule");
  const mine = hostileRows(born); const total2 = countOf("SELECT COUNT(*) AS n FROM incidents WHERE kind = ?", HOSTILE);
  const alerts = mine.length === 1 ? outboxByKey(`incident_opened:${mine[0].incident_id}`) : [];
  const ok = carriedRows === 0 && total1 === total0 && mine.length === 1 && mine[0].state === "resolved" && total2 === total1 + 1 && alerts.length === 1 && alerts[0].target.chat_id === STUB_CHAT;
  return { ok, detail: `carried_turn_incidents=${carriedRows} (want 0) total_delta_after_carried=${total1 - total0} (want 0) born_turn_incidents=${mine.length} (want 1) state=${mine[0]?.state ?? "none"} (want resolved) total_delta_after_born=${total2 - total1} (want 1) incident_opened_rows=${alerts.length} (want 1) to_stub_chat=${alerts[0]?.target?.chat_id === STUB_CHAT}` };
}

// ---- line 6: a real omp /fresh across a restart ----
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);
function jsonlFiles(dir) {
  const acc = [];
  const walk = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl")) acc.push(p); } };
  walk(dir);
  return acc;
}
const newest = (files) => [...files].sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs || (a < b ? -1 : 1)).at(-1);
function depthOf(dir) { let max = 0; const walk = (d, k) => { if (!existsSync(d)) return; max = Math.max(max, k); for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(join(d, e.name), k + 1); }; walk(dir, 0); return max; }
/** The roles every real worker uses: the probe's cheapest model for every seat (built per call: line 1 replaces the store). */
async function cheapRoles() {
  const d = G.d;
  const roles = new d.RoleResolver({ store: G.store, readCatalog: () => d.readOmpCatalog(d.resolveOmpCatalogConfig(process.env)) });
  if (!(await roles.refreshCatalog())) throw new SetupError("catalog unavailable");
  const cheap = d.pickProbeModel(roles);
  if (!cheap) throw new SetupError("no probe model");
  return new Proxy(roles, { get: (t, p) => (p === "candidates" ? () => [cheap] : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
}
/** The worker's projectRoot: a scratch repo under the temp root (reports land in its runs/, memory is a copy), never the live checkout. */
function scratchRepo() {
  const repo = join(G.root, "repo"); mkdirSync(repo, { recursive: true });
  if (!existsSync(join(repo, "memory"))) cpSync(join(new URL("..", import.meta.url).pathname, "memory"), join(repo, "memory"), { recursive: true });
  return repo;
}
const entriesOf = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const RUNS_DIRS = [join(MAIN_CHECKOUT, "runs"), join(new URL("..", import.meta.url).pathname, "runs")];
function newWorker() {
  const w = new G.d.CoreWorker(G.store, argv.includes("--sim-live-root") ? MAIN_CHECKOUT : scratchRepo(), ...Array(10).fill(undefined), { dataDir: G.root, distDir: DIST, roles: G.cheapRoles });
  G.workers.push(w);
  return w;
}
async function realTurn(worker) {
  const id = mkRun(STUB_CHAT, "Reply with exactly OK.");
  if (!worker.submitTurn(id)) throw new Error("gate: submitTurn refused");
  const end = Date.now() + TURN_TIMEOUT_MS;
  while (!TERMINAL.has(G.store.getRunState(id)) && Date.now() < end) await sleep(500);
  return { id, state: G.store.getRunState(id) };
}
async function line6() {
  G.cheapRoles = await cheapRoles();
  const dir = join(G.root, "omp", "sessions", `chat-${STUB_CHAT}`);
  const runsBefore = RUNS_DIRS.map(entriesOf);
  const wA = newWorker(); const a = await realTurn(wA);
  const s1 = jsonlFiles(dir); const f1 = s1.length ? newest(s1) : undefined;
  note(`layout after turn A: files=${s1.length} depth=${depthOf(dir)}`);
  const mark = seqMark();
  const fr = intakeFresh(STUB_CHAT);
  const markerSet = G.store.freshRequestedAt(STUB_CHAT) !== null;
  for (const s of wA.plannerSupervisors()) await s.onFreshRequested();
  await wA.shutdownPlanners(); // the restart
  const wB = newWorker(); const b = await realTurn(wB);
  const s2 = jsonlFiles(dir); const added = s2.filter((f) => !s1.includes(f)); const f2 = added[0];
  const bCarried = trustRows(b.id).filter((r) => String(r.cause).startsWith("carried_"));
  const freshEvents = resetsAfter(mark, "fresh");
  const afterB = seqMark();
  await wB.shutdownPlanners();
  const wC = newWorker(); const c = await realTurn(wC);
  const s3 = jsonlFiles(dir);
  await wC.shutdownPlanners();
  const runsAfter = RUNS_DIRS.map(entriesOf);
  const runsGrew = runsAfter.map((a, i) => a.filter((n) => !runsBefore[i].includes(n)).length);
  const aOk = a.state === "completed" && b.state === "completed" && c.state === "completed";
  const newTranscript = added.length === 1 && f1 !== undefined && f2 !== f1 && newest(s2) === f2 && s1.every((f) => s2.includes(f));
  const resumed = s3.length === s2.length && s3.every((f) => s2.includes(f));
  const ok = aOk && fr.ok === true && markerSet && newTranscript && freshEvents === 1 && G.store.freshRequestedAt(STUB_CHAT) === null && bCarried.length === 0 && resumed && resetsAfter(afterB) === 0 && runsGrew.every((n) => n === 0);
  return { ok, detail: `turns=${a.state}/${b.state}/${c.state} (want completed x3) S1=${s1.length} S2=${s2.length} S3=${s3.length} new_files_at_B=${added.length} (want 1) f2_differs_from_f1=${f2 !== f1} f2_is_newest=${f2 !== undefined && newest(s2) === f2} fresh_intake=${fr.status ?? "refused"} fresh_reset_events=${freshEvents} (want 1) marker_after=${G.store.freshRequestedAt(STUB_CHAT) === null ? "null" : "set"} turnB_carried_rows=${bCarried.length} (want 0) turnC_resumed_same_set=${resumed} resets_after_B=${resetsAfter(afterB)} (want 0) live_runs_dir_new_entries=${runsGrew[0]} worktree_runs_new_entries=${runsGrew[1]} (want 0, 0)` };
}

// ---- line 7: the print contract held ----
async function line7() {
  const text = printed.join("\n");
  const secretHits = G.envSecrets.filter((v) => text.includes(v)).length;
  const chatHit = G.operatorChat !== null && text.includes(G.operatorChat);
  const errRef = text.includes("error_ref");
  return { ok: secretHits === 0 && !chatHit && !errRef && G.envSecrets.length > 0, detail: `env_secret_values_checked=${G.envSecrets.length} hits=${secretHits} (want 0) operator_chat_in_output=${chatHit} (want false) error_ref_in_output=${errRef} (want false) lines_checked=${printed.length}` };
}

// ---- main ----
function smokeEnv(root, disarmFlags) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  for (const f of disarmFlags) process.env[f] = "false";
  process.env.HOUGE_EPISODIC_ENABLED = "false";
  process.env.HOUGE_TOMBSTONE_PATH = join(root, "houge.kill");
  process.env.HOUGE_PARK_MARKER_PATH = join(root, "houge.parked");
  process.env.HOUGE_DISARM_PATH = join(root, "houge.disarm");
}
/** The env file's values for secret-looking keys and the operator chat id, read directly (read-only); nothing is printed. */
function readEnvFile(file) {
  const secrets = []; let chat = null;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (/TOKEN|KEY|SECRET|PASSWORD/.test(m[1]) && v.length > 0 && !FLAG_VALUES.has(v.toLowerCase())) secrets.push(v); // every nonempty value; only a bare flag value (HOUGE_SECRETS_FIREWALL_ENABLED=true) is no secret
      if (m[1] === "HOUGE_TELEGRAM_CHAT_ID" && v) chat = v;
    }
  } catch { /* an unreadable env file leaves the checks empty, which line 7 fails on */ }
  return { secrets, chat };
}
const FLAG_VALUES = new Set(["true", "false", "on", "off", "yes", "no", "0", "1"]);
const killFiles = () => [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
async function setup() {
  const envFile = resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(envFile), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  if (killFiles() !== 0) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  const fromFile = readEnvFile(envFile); G.envSecrets = fromFile.secrets;
  G.savedEnv = { ...process.env };
  const load = (rel) => import(join(DIST, rel));
  const [{ loadHougeEnv }, { DISARM_FLAGS }, inc, sched, rr, rolesMod, cat, ocfg, probeRunner] = await Promise.all([load("config/load-env.js"), load("config/disarm-posture.js"), load("run/incident-alert.js"),
    load("run/schedule-spec.js"), load("domain/types.js"), load("omp/role-resolver.js"), load("omp/model-catalog.js"), load("omp/omp-config.js"), load("omp/omp-probe-runner.js")]);
  loadHougeEnv();
  G.operatorChat = process.env.HOUGE_TELEGRAM_CHAT_ID?.trim() || fromFile.chat;
  const root = initTemp(false); G.root = root;
  smokeEnv(root, DISARM_FLAGS);
  for (const k of DELETE_PINS) delete process.env[k];
  process.env.HOUGE_TELEGRAM_CHAT_ID = STUB_CHAT; // last: nothing after this can override a pin
  G.copy = join(root, "houge.sqlite");
  vacuumInto(liveDb, G.copy);
  G.boot = readRaw(G.copy, G.operatorChat);
  note(`boot: hostile_open=${G.boot.n0} migration_applied=${G.boot.applied} operator_carry=${G.boot.carry === "hostile" ? "hostile" : "not_hostile"}`);
  const d = await loadDist(DIST);
  Object.assign(d, { runIncidentReminder: inc.runIncidentReminder, reminderText: inc.reminderText, formatInstantInZone: sched.formatInstantInZone, resolveDisplayZone: sched.resolveDisplayZone,
    buildTypedTaskEvent: rr.buildTypedTaskEvent, RoleResolver: rolesMod.RoleResolver, readOmpCatalog: cat.readOmpCatalog, resolveOmpCatalogConfig: ocfg.resolveOmpCatalogConfig, pickProbeModel: probeRunner.pickProbeModel });
  G.d = d;
  for (const k of ["storeOptionsFor", "RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "PlannerSupervisor", "CoreWorker", "lessonSetFingerprint", "ToolRegistry", "parseModelString", "selectorKey", "resolveOmpConfig",
    "runIncidentReminder", "reminderText", "formatInstantInZone", "resolveDisplayZone", "RoleResolver", "readOmpCatalog", "resolveOmpCatalogConfig", "pickProbeModel"]) if (!d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  G.storeOpts = d.storeOptionsFor(undefined, {});
  G.store = d.RunStore.open(G.copy, G.storeOpts);
  mkdirSync(join(root, "work"), { recursive: true });
}
function closeAll() { try { G.store?.close(); } catch { /* a closed handle is not a finding */ } G.store = null; }
function restoreEnv() {
  if (!G.savedEnv) return;
  for (const k of Object.keys(process.env)) if (!(k in G.savedEnv)) delete process.env[k];
  Object.assign(process.env, G.savedEnv); G.savedEnv = null;
}
async function stopWorkers() { await Promise.race([Promise.allSettled(G.workers.splice(0).map((w) => w.shutdownPlanners())), sleep(8_000)]); }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, async () => { await stopWorkers().catch(() => undefined); await cleanup().catch(() => undefined); closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });

try {
  await setup();
  const lines = [[1, "boot_resolve", line1], [2, "reminder", line2], [3, "carry_then_fresh", line3], [4, "withhold_only", line4], [5, "schedule_turns", line5], [6, "real_fresh", line6]];
  for (const [n, name, fn] of lines) {
    try { await runLine(n, name, fn); } finally { await cleanup().catch(() => undefined); }
  }
  if (argv.includes("--sim-leak") && G.operatorChat) printed.push(`leak ${G.operatorChat}`);
  await runLine(7, "no_secret_print", line7);
  const tomb = killFiles();
  if (tomb !== 0) { out.push(false); console.log(`FAIL post houge.kill — found ${tomb} (want 0)`); }
  const expected = ONLY ? ONLY.size : 7;
  const passed = out.filter(Boolean).length;
  note(`${passed}/${out.length} PASS (${expected} expected) · houge.kill in cwd/main checkout ${tomb} (want 0)`);
  process.exitCode = out.length === expected && passed === expected ? 0 : 1;
  console.log(`${process.exitCode === 0 ? "PASS" : "FAIL"} gate — ${passed}/${expected} checks`);
} catch (e) {
  console.error(`setup_failed${e instanceof SetupError ? `: ${e.message}` : ""}`);
  if (DEBUG) console.error(`# debug: setup threw ${errCode(e)}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  await stopWorkers().catch(() => undefined);
  await cleanup().catch(() => undefined);
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
