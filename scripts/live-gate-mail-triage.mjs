#!/usr/bin/env node
// Live gate — SP2 mail triage (spec 2026-11-09 §10; plan Task 12).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/live-gate-mail-triage.mjs --token <6-12 lowercase letters> [--live-db <path>] [--no-open-check] [--wait-min 10]
// Eight lines on stdout, each `PASS`/`FAIL`/`INCONCLUSIVE <n> <name> — <detail>`; exit 0 when no line FAILs (1 FAIL, 2 setup error). Everything else is on stderr, `# `-prefixed.
//
// Before anything else the gate refuses to run while the LIVE daemon's mail is on: it reads `mail_state.enabled` from the live DB (read-only; a DB
// without the table, the pre-slice build's, counts as off) and HOUGE_MAIL_ENABLED from the daemon's env FILE; the DB switch on = refuse whatever the file says (Paco must not be
// pinged twice). The gate then enables mail in ITS OWN process env and on ITS copy of the DB (Rev 1.1 amendment), never the daemon's.
//
// What is real: Gmail (read-only, Paco's grant through the broker when the firewall is on, else the env), Jev (the daemon's client config: no retry,
// 6 s), Telegram to Paco's operator chat through the daemon's own outbox dispatcher (inside the test surface), this build's poller (runMailTick),
// triage, ladder, store. What is a copy: the DB (VACUUM INTO under /tmp/hg-s4d-*, removed on every exit path; every pre-existing undelivered outbox
// row parked so nothing old is resent). The only seams: the auth client's fetchImpl (line 6 answers one token mint with 401), the Jev client wrapped
// to capture request bodies (line 4 searches them), and the poller's deadline widened to 5 min (a first run over a day of mail takes more than the
// daemon's 90 s). The cadence gate is passed by rewinding `last_ok_at` and `last_attempt_at` on the copy before each tick (HOUGE_MAIL_POLL_MIN clamps to >= 2 min).
//
// Order (Rev 1.1): (1) one first-run tick sets the cursor (the 24 h backfill is counted, never shown); (2) "send the three mails now, then press
// Enter"; (3) ticks until all three tokens are stored or --wait-min pass, delivering only the planted mails' cards; (4) lines 1–8. The planted
// mails are found by the token in their REDACTED stored subjects and told apart by the words the spec fixes ("URGENT", "code"; the third is the
// newsletter). Line 5 re-decides the stored newsletter through the real rule path (applySenderRule / undoSenderRule) and the real ladder
// (decide(MAIL_TRIAGE) with the real Jev): a second triageOne would collide on gmail_message_id, and the spec names no fourth mail.
//
// Print contract: ids (mi_/mr_/ntf_ prefixes), counts, lanes, reason codes, verdicts and closed error codes only. Never a subject, sender, snippet,
// the token, the chat id or a secret. The six-digit code of spec §10 is searched for (DB copy, Jev requests, card payloads, this gate's own output) and never printed.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist } from "./stage4-diff-lib.mjs";
import { parseEnvText } from "./gmail-env.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k) => argv.includes(k);
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const MT = "mail.triage";
const TOKEN_RE = /^[a-z]{6,12}$/; // letters only: the redactor masks digit runs and code-shaped alphanumerics before the subject is stored
const CODE = ["48", "29", "13"].join(""); // spec §10's planted code, assembled so the literal never sits in this file or any grep of it
const TICK_DEADLINE_MS = 5 * 60_000;
const TICK_GAP_MS = 20_000;
const PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_PARK_MARKER_PATH", "HOUGE_DAEMON_TMP_DIR", "HOUGE_MAIL_ENABLED"];
const printed = [];
const out = [];
const inconclusive = [];
const G = { root: null, store: null, d: null, m: null, auth: null, inject401: false, jevReqs: [], chatId: null, pacoAddr: null, cursor0: null, planted: null, savedEnv: null, rl: null, abort: new AbortController(), dispatcher: null, hasRefresh: false, codeBaseline: 0 };
const say = (line) => { printed.push(line); console.log(line); };
const note = (s) => { printed.push(`# ${s}`); console.error(`# ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (store, sql, ...a) => store.db.prepare(sql).all(...a).map((r) => ({ ...r }));
const one = (store, sql, ...a) => store.db.prepare(sql).get(...a);
const nowIso = () => new Date().toISOString();
const short = (id) => (typeof id === "string" ? id.slice(0, 12) : String(id));

function verdict(n, name, status, detail) {
  out.push(status);
  if (status === "INCONCLUSIVE") inconclusive.push(n);
  say(`${status} ${n} ${name} — ${detail}`);
}
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError", "AbortError", "GoogleAuthError", "DecisionRejected"]);
/** A thrown value prints as its standard class name only, never its message (an error may quote mail). */
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");
async function runLine(n, name, fn) {
  try { const r = await fn(); verdict(n, name, r.status ?? (r.ok ? "PASS" : "FAIL"), r.detail); } catch (e) { verdict(n, name, "FAIL", `threw: ${errCode(e)}`); }
}

// ---- the live DB and the refusal ----
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** VACUUM INTO `to` from `from` (read-only source). The daemon writes the live DB: a lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
const onFlag = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
/** The live daemon's two mail switches, read without the store: the DB read-only (no mail_state table = the pre-slice build = off), the flag from the env file. */
function liveMailSwitches(liveDb, envFile) {
  const db = new DatabaseSync(liveDb, { readOnly: true });
  let dbOn = false;
  try {
    const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'mail_state'").get() !== undefined;
    dbOn = has && db.prepare("SELECT enabled FROM mail_state WHERE id = 1").get()?.enabled === 1;
  } finally { db.close(); }
  const fileOn = existsSync(envFile) && onFlag(parseEnvText(readFileSync(envFile, "utf8")).HOUGE_MAIL_ENABLED);
  return { dbOn, fileOn };
}

// ---- outbox: park what is not ours, deliver only the planted cards ----
const NON_FINAL = "state NOT IN ('delivered', 'failed_terminal')";
const parkExcept = (ids) => { const keep = ids.length ? ids : [""]; return G.store.db.prepare(`UPDATE notification_outbox SET state = 'failed_terminal' WHERE ${NON_FINAL} AND notification_id NOT IN (${keep.map(() => "?").join(",")})`).run(...keep).changes; };
const plantedCardIds = () => Object.values(G.planted ?? {}).filter((p) => p && p.notification_id).map((p) => p.notification_id);
/** Delivers the planted mails' cards through the daemon's own dispatcher (real Telegram); every other undelivered row is parked first (never shown). Returns [delivered, parked]. */
async function pumpPlanted() {
  const parked = parkExcept(plantedCardIds());
  let delivered = 0;
  for (let i = 0; i < 20; i++) {
    const r = await G.dispatcher.dispatchOnce("mail-gate");
    if (r.status === "idle") break;
    if (r.status === "delivered") delivered += 1;
    else { note(`dispatch failed for ${short(r.notification_id)} retryable ${r.retryable}`); break; }
  }
  return [delivered, parked];
}

// ---- the poller, as the daemon wires it ----
// Both stamps: the poller's cadence counts from the later of last_ok_at and last_attempt_at (final fix wave, 4d8c9bdd).
const rewind = () => { const t = new Date(Date.now() - 3_600_000).toISOString(); G.store.setMailState({ last_ok_at: t, last_attempt_at: t }); };
function pollDeps() {
  return { store: G.store, chatId: G.chatId, pacoAddress: G.pacoAddr, env: process.env, now: () => new Date(), brokerRedact: (s) => G.store.redactSecretValues(s),
    ask: (state) => G.m.askMail({ state, client: G.jev, store: G.store }), gmail: { deps: { fetchImpl: fetch, now: () => new Date() }, auth: G.auth },
    hasRefreshToken: G.hasRefresh, signal: G.abort.signal, deadlineMs: TICK_DEADLINE_MS };
}
const tick = async () => { rewind(); return G.m.runMailTick(pollDeps()); };
const tickText = (r) => (r.ran ? `ran stored ${r.stored} pinged ${r.pinged} cursor_advanced ${r.cursorAdvanced}${r.error ? ` error ${r.error}` : ""}` : `skipped ${r.why}`);

// ---- the planted mails ----
const ITEM_COLS = "item_id, gmail_message_id, gmail_thread_id, from_address, lane, reason_code, kind, decision_id, notification_id, subject";
/** The three planted mails by the token in their redacted subjects, told apart by the spec's words; the subject never leaves this function. */
function findPlanted() {
  const rows = q(G.store, `SELECT ${ITEM_COLS} FROM mail_items WHERE subject LIKE ? ORDER BY rowid`, `%${G.token}%`);
  const planted = { urgent: null, newsletter: null, code: null, extra: 0 };
  for (const r of rows) {
    const which = /urgent/i.test(r.subject) ? "urgent" : /code/i.test(r.subject) ? "code" : "newsletter";
    const { subject: _s, ...safe } = r;
    if (planted[which] === null) planted[which] = safe; else planted.extra += 1;
  }
  return planted;
}
const foundCount = (p) => ["urgent", "newsletter", "code"].filter((k) => p[k]).length;
const decisionOf = (p) => (p?.decision_id ? one(G.store, "SELECT rung, verdict, reason_code, fallback_reason, stage, tool_call_id FROM decisions WHERE decision_id = ?", p.decision_id) : undefined);

// ---- the code search (line 4) ----
const regularTables = () => q(G.store, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").filter((t) => !/^CREATE VIRTUAL/i.test(t.sql ?? "")).map((t) => t.name);
/** Rows of every ordinary table whose JSON holds the code; shadow tables of virtual tables are skipped by their prefix. */
function codeRowCount() {
  const virtual = q(G.store, "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'").map((t) => t.name);
  let n = 0;
  for (const t of regularTables()) {
    if (virtual.some((v) => t.startsWith(`${v}_`))) continue;
    for (const r of q(G.store, `SELECT * FROM "${t.replace(/"/g, '""')}"`)) if (JSON.stringify(r).includes(CODE)) n += 1;
  }
  return n;
}
const mailTextHits = () => q(G.store, "SELECT subject, snippet, from_name FROM mail_items").filter((r) => JSON.stringify(r).includes(CODE)).length;
const cardHits = () => q(G.store, "SELECT payload_json FROM notification_outbox WHERE idempotency_key LIKE 'mail:%'").filter((r) => r.payload_json.includes(CODE)).length;

// ---- line 5: the real rule path and the real ladder over a stored item ----
async function redecide(item_id) {
  const row = G.store.getMailItem(item_id);
  if (!row) throw new Error("gate: planted item vanished");
  const item = { item_id: row.item_id, gmail_message_id: row.gmail_message_id, thread_id: row.gmail_thread_id, from_address: row.from_address, from_name: row.from_name, known_sender: row.known_sender,
    subject: row.subject, snippet: row.snippet, labels: row.labels, important: row.important, received_at: row.received_at, thread_pinged_6h: false, backfill: false };
  const s = { item, rule: G.store.senderRule(row.from_address)?.action ?? null };
  const r = await G.m.decide(G.m.MAIL_TRIAGE, s, { run_id: null, tool_call_id: item_id, recorder: { record: () => null },
    exec: { system_one: async () => G.m.jevMailAnswer(await G.m.askMail({ state: G.m.jevStateOf(item), client: G.jev, store: G.store })) } });
  return { rule: s.rule, rung: r.rung, verdict: r.verdict, reason: r.reason, fallback: r.fallbackReason };
}

// ---- lines ----
async function line1() {
  const p = G.planted; const keys = ["urgent", "newsletter", "code"];
  const per = keys.map((k) => {
    const it = p[k]; if (!it) return { k, items: 0, decisions: 0 };
    const items = one(G.store, "SELECT COUNT(*) AS n FROM mail_items WHERE gmail_message_id = ?", it.gmail_message_id).n;
    const decisions = one(G.store, "SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ? AND tool_call_id = ?", MT, it.item_id).n;
    const linked = it.decision_id !== null && decisionOf(it)?.tool_call_id === it.item_id;
    return { k, items, decisions, linked };
  });
  const ok = per.every((x) => x.items === 1 && x.decisions === 1 && x.linked) && p.extra === 0;
  return { ok, detail: `found ${foundCount(p)}/3 · ${per.map((x) => `${x.k}: rows ${x.items} decisions ${x.decisions} linked ${x.linked ?? false}`).join(" · ")} · extra token matches ${p.extra} (want 0)` };
}
async function line2() {
  const rows = ["urgent", "newsletter", "code"].map((k) => decisionOf(G.planted[k]));
  const answered = rows.filter((r) => r && r.rung === "system_one" && r.fallback_reason === null).length;
  const rungs = rows.map((r) => (r ? `${r.rung}${r.fallback_reason ? `/${r.fallback_reason}` : ""}` : "none"));
  return { ok: answered >= 2, detail: `Jev answered ${answered}/3 (want >= 2) · rungs [${rungs.join(" ")}]` };
}
async function line3() {
  const u = G.planted.urgent; const n = G.planted.newsletter;
  const urgentPinged = u?.lane === "ping";
  const newsInbox = n?.lane === "inbox";
  const jevCall = n && /^jev_/.test(n.reason_code);
  const status = !urgentPinged ? "FAIL" : newsInbox ? "PASS" : jevCall ? "INCONCLUSIVE" : "FAIL";
  return { status, detail: `urgent lane ${u?.lane ?? "none"}/${u?.reason_code ?? "-"} (want ping) · newsletter lane ${n?.lane ?? "none"}/${n?.reason_code ?? "-"} (want inbox; Jev's call when jev_* pinged)` };
}
async function line4() {
  const dbRows = codeRowCount() - G.codeBaseline;
  const jev = G.jevReqs.filter((s) => s.includes(CODE)).length;
  const cards = cardHits(); const text = mailTextHits();
  const output = printed.filter((l) => l.includes(CODE)).length;
  return { ok: dbRows === 0 && text === 0 && jev === 0 && cards === 0 && output === 0, detail: `code in: DB rows beyond baseline ${dbRows} · mail text columns ${text} · Jev requests ${jev}/${G.jevReqs.length} · card payloads ${cards} · gate output lines ${output} (all want 0)` };
}
async function line5() {
  const n = G.planted.newsletter;
  if (!n) return { ok: false, detail: "no newsletter item" };
  const log0 = one(G.store, "SELECT COUNT(*) AS n FROM change_log").n;
  const rule = G.m.applySenderRule(G.store, n.item_id, "never", new Date());
  if (!rule.ok) return { ok: false, detail: `rule refused: ${rule.why}` };
  const a = await redecide(n.item_id);
  const undone = G.m.undoSenderRule(G.store, rule.rule_id, new Date());
  const b = await redecide(n.item_id);
  const log1 = one(G.store, "SELECT COUNT(*) AS n FROM change_log").n;
  const ruleOk = a.rule === "never" && a.rung === "rule" && a.verdict === "inbox" && a.reason === "rule_never";
  const back = b.rule === null && b.rung === "system_one" && /^jev_/.test(b.reason ?? "");
  const status = !(ruleOk && undone && log1 - log0 === 2) ? "FAIL" : back ? "PASS" : b.rung === "fail" ? "INCONCLUSIVE" : "FAIL";
  return { status, detail: `rule ${short(rule.rule_id)} never → ${a.rung}/${a.verdict}/${a.reason} (want rule/inbox/rule_never) · undo ${undone} · re-decide ${b.rung}/${b.verdict}/${b.reason}${b.fallback ? ` fallback ${b.fallback}` : ""} (want system_one/jev_*) · /changes lines +${log1 - log0} (want 2)` };
}
const authLost = () => one(G.store, "SELECT COUNT(*) AS n FROM incidents WHERE kind = 'mail_auth_lost'").n;
async function line6() {
  const inc0 = authLost();
  G.auth.invalidate(); G.inject401 = true;
  let r1, r2;
  try { r1 = await tick(); r2 = await G.m.runMailTick(pollDeps()); } finally { G.inject401 = false; }
  const inc1 = authLost(); const st = G.store.mailState();
  const parked = parkExcept(plantedCardIds()); // the incident's page row stays on the copy, never sent: the daemon's grant is intact
  G.store.setMailState({ last_error_code: null, backoff_n: 0, failing_since: null }); // as `/mail on` resumes a paused poller
  const ok = r1.ran && r1.error === "auth" && inc1 - inc0 === 1 && st.last_error_code === "auth" && !r2.ran && r2.why === "paused";
  return { ok, detail: `tick ${tickText(r1)} (want error auth) · mail_auth_lost +${inc1 - inc0} (want 1) · paused ${st.last_error_code === "auth"} · next tick ${tickText(r2)} (want skipped paused) · page rows parked ${parked}` };
}
async function line7() {
  const ids = ["urgent", "newsletter", "code"].map((k) => G.planted[k]).filter(Boolean);
  const cards0 = plantedCardIds().sort();
  const items0 = one(G.store, "SELECT COUNT(*) AS n FROM mail_items").n;
  G.store.setMailState({ history_id: G.cursor0 });
  const r = await tick();
  const [delivered] = await pumpPlanted();
  const again = findPlanted();
  const rows = ids.map((it) => one(G.store, "SELECT COUNT(*) AS n FROM mail_items WHERE gmail_message_id = ?", it.gmail_message_id).n);
  const cards1 = ids.map((it) => q(G.store, "SELECT notification_id FROM notification_outbox WHERE correlation_id = ?", it.item_id).map((x) => x.notification_id)).flat().sort();
  const ok = r.ran && r.error === undefined && rows.every((n) => n === 1) && JSON.stringify(cards1) === JSON.stringify(cards0) && delivered === 0 && again.extra === 0;
  return { ok, detail: `second poll over the window from the first-run cursor: ${tickText(r)} · other new mail stored ${one(G.store, "SELECT COUNT(*) AS n FROM mail_items").n - items0} (counted, never shown) · planted rows [${rows.join(" ")}] (want 1 1 1) · planted card rows unchanged ${JSON.stringify(cards1) === JSON.stringify(cards0)} · cards delivered now ${delivered} (want 0)` };
}
async function line8() {
  if (flag("--no-open-check")) return { status: "INCONCLUSIVE", detail: "skipped (--no-open-check): the deep-link format is unverified" };
  const u = G.planted.urgent;
  const answer = (await G.rl.question(`# tap Open on the urgent card (notification ${short(u?.notification_id)}) — did it open the planted thread? reply y or n: `)).trim().toLowerCase();
  return { ok: answer === "y", detail: `Paco's answer ${answer === "y" ? "y" : answer === "n" ? "n" : "other"} (want y)` };
}

// ---- setup ----
const killFiles = () => [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
/** The daemon's env, then the gate's own posture: disarm pinned under the temp root BEFORE the load (the live posture would force the flag off), the broker as cli.ts builds it, the mail flag on LAST. */
function loadEnv(root) {
  G.savedEnv = { ...process.env };
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  Object.assign(process.env, { HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"), HOUGE_DAEMON_TMP_DIR: join(root, "daemon") });
  delete process.env.HOUGE_MAIL_ENABLED;
  G.m.loadHougeEnv();
  const broker = G.m.resolveSecretsFirewallEnabled(process.env) ? G.m.createSecretBroker(process.env) : undefined;
  if (broker) G.m.stripSecretsFromEnv(process.env);
  process.env.HOUGE_MAIL_ENABLED = "1";
  return broker;
}
function restoreEnv() {
  if (!G.savedEnv) return;
  for (const k of Object.keys(process.env)) if (!(k in G.savedEnv)) delete process.env[k];
  Object.assign(process.env, G.savedEnv);
  G.savedEnv = null;
}
async function loadMods() {
  G.d = await loadDist(DIST);
  for (const k of ["RunStore", "storeOptionsFor", "NotificationOutbox", "NotificationDispatcher", "workspaceTelegramAdapter"]) if (!G.d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  const load = async (rel) => import(join(DIST, rel));
  const parts = await Promise.all(["mail/poller.js", "mail/flag.js", "mail/inbox.js", "mail/envelope.js", "decisions/decide.js", "decisions/entries/mail-triage.js", "jev/mail-ask.js", "jev/jev-client.js",
    "capabilities/google-auth.js", "config/load-env.js", "config/secret-broker.js", "telegram/telegram-client.js", "telegram/telegram-daemon.js", "notifications/local-notification-adapter.js"].map(load));
  G.m = Object.assign({}, ...parts);
  for (const k of ["runMailTick", "pacoAddress", "applySenderRule", "undoSenderRule", "jevStateOf", "decide", "MAIL_TRIAGE", "jevMailAnswer", "askMail", "createJevClient", "createGoogleAuthClient", "loadHougeEnv",
    "createSecretBroker", "stripSecretsFromEnv", "resolveSecretsFirewallEnabled", "TelegramClient", "createOutboxDispatcher", "LocalNotificationAdapter"]) if (!G.m[k]) throw new SetupError(`${k} missing from dist: rebuild`);
}
/** Paco's auth client as the daemon builds it (broker first), over a fetch the gate can answer with one 401 (line 6). */
function buildClients(broker, root) {
  const env = process.env;
  const authFetch = (url, init) => { if (G.inject401) { G.inject401 = false; return Promise.resolve(new Response("", { status: 401 })); } return fetch(url, init); };
  G.auth = G.m.createGoogleAuthClient({ clientId: env.HOUGE_GMAIL_CLIENT_ID, clientSecret: () => (broker ? broker.gmailClientSecret() : env.HOUGE_GMAIL_CLIENT_SECRET),
    refreshToken: () => (broker ? broker.pacoGmailRefreshToken() : env.HOUGE_PACO_GMAIL_REFRESH_TOKEN) }, { fetchImpl: authFetch });
  G.hasRefresh = Boolean(broker ? broker.pacoGmailRefreshToken() : env.HOUGE_PACO_GMAIL_REFRESH_TOKEN);
  const apiKey = broker ? broker.typesafeKey() : env.TYPESAFE_API_KEY;
  const tgToken = broker ? broker.telegramToken() : env.HOUGE_TELEGRAM_BOT_TOKEN;
  const missing = [["HOUGE_GMAIL_CLIENT_ID", env.HOUGE_GMAIL_CLIENT_ID], ["gmail client secret", broker ? broker.gmailClientSecret() : env.HOUGE_GMAIL_CLIENT_SECRET], ["paco refresh token (houge mail auth)", G.hasRefresh],
    ["TYPESAFE_API_KEY", apiKey], ["telegram bot token", tgToken], ["HOUGE_TELEGRAM_CHAT_ID", G.chatId], ["HOUGE_PACO_GMAIL_ADDRESS", G.pacoAddr]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new SetupError(`env missing: ${missing.join(", ")}`);
  const jev = G.m.createJevClient({ apiKey, audit: G.store.llmAuditSink({ correlation_id: "mail-gate", role: "mail" }), meteredBreached: () => G.store.meteredFuseLatched(), retries: 0, timeoutMs: 6_000 });
  G.jev = async (req) => { G.jevReqs.push(JSON.stringify(req)); return jev(req); };
  const client = new G.m.TelegramClient({ token: tgToken });
  mkdirSync(join(root, "data"), { recursive: true });
  G.dispatcher = G.m.createOutboxDispatcher(G.store, { local: new G.m.LocalNotificationAdapter(), telegram: G.d.workspaceTelegramAdapter(client, join(root, "data")) });
}
async function setup() {
  const envFile = resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(envFile), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  if (killFiles() !== 0) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  G.token = arg("--token");
  if (!G.token || !TOKEN_RE.test(G.token)) throw new SetupError("--token must be 6-12 lowercase letters (digits would be masked by the redactor)");
  const sw = liveMailSwitches(liveDb, envFile);
  note(`live daemon mail: switch ${sw.dbOn ? "on" : "off"} · env file flag ${sw.fileOn ? "on" : "off"}`);
  // the DB switch alone decides (codex B3): the running daemon's effective env may differ from the file, so a live `/mail on` is a refusal whatever the file says
  if (sw.dbOn) throw new SetupError(`the live daemon's mail switch is ON in the live DB (env file flag ${sw.fileOn ? "on" : "off"}): run \`/mail off\` first, so Paco is not pinged twice`);
  await loadMods();
  const root = initTemp(false); G.root = root;
  const broker = loadEnv(root);
  G.chatId = process.env.HOUGE_TELEGRAM_CHAT_ID?.trim() || null;
  G.pacoAddr = G.m.pacoAddress(process.env) ?? null;
  const copy = join(root, "houge.sqlite");
  vacuumInto(liveDb, copy);
  G.store = G.d.RunStore.open(copy, G.d.storeOptionsFor(broker, process.env));
  const parked = parkExcept([]);
  G.store.setMailState({ enabled: true, enabled_at: nowIso(), history_id: null, last_ok_at: null, last_error_code: null, failing_since: null, backoff_n: 0 });
  buildClients(broker, root);
  note(`copy ready: pre-existing undelivered outbox rows parked ${parked} · firewall ${broker ? "on (broker)" : "off (env)"} · mail enabled on the copy and in this process only`);
  G.rl = createInterface({ input: process.stdin, output: process.stderr });
}

// ---- the run ----
async function firstRun() {
  for (let i = 1; i <= 5; i++) {
    const r = await tick();
    note(`first run tick ${i}: ${tickText(r)}`);
    if (r.ran && r.error) throw new SetupError(`first run failed: ${r.error}`);
    if (r.ran && r.cursorAdvanced) { G.cursor0 = G.store.mailState().history_id; parkExcept([]); G.codeBaseline = codeRowCount(); return r.stored; }
    if (!r.ran) throw new SetupError(`first run skipped: ${r.why}`);
  }
  throw new SetupError("first run never advanced the cursor");
}
async function waitForPlanted(waitMin) {
  const end = Date.now() + waitMin * 60_000;
  for (let k = 1; ; k++) {
    const r = await tick();
    G.planted = findPlanted();
    const [delivered, parked] = await pumpPlanted();
    note(`tick ${k}: ${tickText(r)} · planted found ${foundCount(G.planted)}/3 · cards delivered ${delivered} · other rows parked ${parked}`);
    if (foundCount(G.planted) === 3) return true;
    if (Date.now() >= end || G.abort.signal.aborted) return false;
    await sleep(TICK_GAP_MS);
  }
}

function closeAll() { try { G.store?.close(); } catch { /* a closed handle is not a finding */ } G.store = null; try { G.rl?.close(); } catch { /* closed */ } }
/** Every exit path removes the copy and restores the env. */
function bail(code) { G.abort.abort(); closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]]) process.on(sig, () => bail(code));
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.error(`${ev}: ${errCode(e)}`); bail(2); });

try {
  await setup();
  const backfill = await firstRun();
  note(`first run done: ${backfill} backfill item(s) stored to /inbox (never shown) · cursor set ${G.cursor0 !== null}`);
  await G.rl.question("# send the three mails now from another address, each subject carrying the token (one with URGENT, one newsletter-style, one 'your code is <the six digits of spec §10>'), then press Enter: ");
  const found = await waitForPlanted(Number(arg("--wait-min") ?? 10));
  if (!found) note(`planted found ${foundCount(G.planted)}/3 within the wait: lines 1-8 run on what arrived`);
  const lines = [[1, "three planted mails stored once with one decision row each", line1], [2, "Jev answered (rung system_one, no fallback) for at least 2 of 3", line2],
    [3, "urgent pinged, newsletter did not", line3], [4, "the planted code appears nowhere", line4], [5, "never rule routes the re-decided newsletter to inbox; /mail_undo restores Jev's call", line5],
    [6, "injected 401 opens exactly one mail_auth_lost", line6], [7, "a second poll over the same window sends no second ping", line7], [8, "the card's Open button opens the planted thread", line8]];
  for (const [n, name, fn] of lines) await runLine(n, name, fn);
  const leak = printed.filter((l) => l.includes(CODE)).length;
  if (leak !== 0) { out.push("FAIL"); say(`FAIL post the planted code reached the gate's own output — lines ${leak} (want 0)`); }
  const passed = out.filter((s) => s === "PASS").length; const failed = out.filter((s) => s === "FAIL").length;
  note(`${passed}/8 PASS · inconclusive [${inconclusive.join(" ")}] · failed ${failed}`);
  process.exitCode = failed === 0 && out.length >= 8 ? 0 : 1;
} catch (e) {
  console.error(e instanceof SetupError ? `setup_failed: ${e.message}` : `setup_failed: ${errCode(e)}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) console.error(`# temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
