#!/usr/bin/env node
// Live gate — chat is for Paco (spec 2026-11-03 §10, eight lines): background notices go to the change log, pages and cards stay in chat.
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/live-gate-chat-is-for-paco.mjs [--live-db <path>] [--dist <path>] [--debug]
// Stdout: `PASS n` or `FAIL n: <code>[,<code>]` per line (closed codes and counts only), then `PASS|FAIL gate — <p>/8`. Exit 0 all PASS · 1 any FAIL · 2 setup error.
// Never printed: an id, a message text, an error message. Everything else goes to stderr prefixed `# `.
// The live DB is read once by VACUUM INTO a pristine copy under the temp root (/tmp/hg-s4d-*); each scenario runs on its own VACUUM copy of that copy; the whole
// root is deleted in `finally` (and on SIGINT/SIGTERM/SIGHUP). Telegram is stubbed (no client exists: the outbox of a copy is the only sink). The only subprocess
// is the one `omp --profile houge models --json` read Houge makes daily (preflight), which captures the live catalog; the roles tick then runs on a
// RoleResolver fed that catalog (no omp spawn by the tick), a stub probe, HOUGE_MODEL_ROLES=resolved, and now = the copy's latest model_roles_resolved + 25 h.
// The copy is normalised to the state the spec describes (tier gemini-pro unadopted; judges:2 holding the card-tap override of gemini-4-argon, written by the
// legacy adjacency: tap probe row then override row). A copy that already moved on (the live daemon ticked) is put back to it on the copy only and noted on stderr.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp } from "./stage4-diff-lib.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const DIST = resolve(arg("--dist") ?? new URL("../dist", import.meta.url).pathname);
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
const DEBUG = argv.includes("--debug");
const STUB_CHAT = "-1003"; // numeric, not a real chat
const ARGON = "gemini-4-argon";
const GOOGLE = "google-antigravity";
const PLANTED_EMPTY = { provider: GOOGLE, id: "gemini-9-pro", thinking: null }; // line 5: a member of the real pro tier that the stub probe refuses
const PLANTED_KIMI_ID = "k9"; // line 4: newer than any real Kimi head
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_MODEL_ROLES"];
const DELETE_PINS = ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID", "HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED",
  "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES"];
const ID_SHAPES = [/run_[0-9a-f-]{36}/, /-?\d{6,}/, /appr_/, /notif_/, /chg_/]; // spec §8
const CHAT_TEXT_MAX = 3_900;

const G = { d: null, root: null, base: null, catalog: null, saved: null, stores: [], tickNow: null };
const out = [];
const note = (s) => console.error(`# ${s}`);
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError"]);
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");

// ---- the copies ----
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
const openStore = (path) => { const s = G.d.RunStore.open(path, G.d.storeOptionsFor(undefined, {})); G.stores.push(s); return s; };
/** A fresh VACUUM copy of the pristine base, opened (its migrations run: change_log exists). */
function fork(name) { const p = join(G.root, `${name}.sqlite`); vacuumInto(G.base, p); return openStore(p); }
const scalar = (store, sql, ...a) => store.db.prepare(sql).get(...a).n;
const outboxCount = (store) => scalar(store, "SELECT COUNT(*) AS n FROM notification_outbox");
const changeCount = (store, topic) => (topic ? scalar(store, "SELECT COUNT(*) AS n FROM change_log WHERE topic = ?", topic) : scalar(store, "SELECT COUNT(*) AS n FROM change_log"));
const outboxByKey = (store, like) => store.db.prepare("SELECT idempotency_key, payload_json FROM notification_outbox WHERE idempotency_key LIKE ? ORDER BY rowid").all(like).map((r) => ({ key: r.idempotency_key, payload: JSON.parse(r.payload_json) }));
const outboxMark = (store) => scalar(store, "SELECT COALESCE(MAX(rowid), 0) AS n FROM notification_outbox");
const outboxAfter = (store, mark) => store.db.prepare("SELECT idempotency_key, payload_json FROM notification_outbox WHERE rowid > ? ORDER BY rowid").all(mark).map((r) => ({ key: r.idempotency_key, payload: JSON.parse(r.payload_json) }));
const changeRows = (store, topic) => store.db.prepare("SELECT idempotency_key, text FROM change_log WHERE topic = ? ORDER BY rowid").all(topic).map((r) => ({ ...r }));

// ---- state normalisation (on the pristine copy only) ----
function normaliseBase() {
  const s = openStore(G.base);
  const now = new Date().toISOString();
  const pro = s.listModelTiers().find((t) => t.tier === "gemini-pro");
  if (pro && (pro.adopted !== null || pro.previous !== null || pro.rejected_selector !== null)) {
    s.writeModelTier({ tier: "gemini-pro", adopted: null, previous: null, adopted_at: null, rejected_selector: null, rejected_at: null }, now);
    note("gemini-pro tier put back to unadopted on the copy");
  }
  const row = s.latestOverrideRows().get("judges:2");
  const legacy = row !== undefined && row.pattern === ARGON && row.via === null && row.prev?.event_type === "model_probe" && row.prev.payload.purpose === "tap" && row.prev.payload.result === "pass"
    && row.prev.payload.tier === "gemini-pro" && row.prev.payload.selector === `${GOOGLE}/${ARGON}`;
  if (!legacy) {
    s.recordModelProbe({ tier: "gemini-pro", selector: `${GOOGLE}/${ARGON}`, purpose: "tap", result: "pass", kind: "ok" });
    s.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "gate:chat-is-for-paco" });
    note("judges:2 card-tap override planted on the copy (legacy adjacency)");
  } else note("judges:2 card-tap override found on the copy (legacy adjacency)");
  const last = s.latestModelRolesResolved();
  G.tickNow = last ? new Date(Date.parse(last.resolved_at) + 25 * 3_600_000).toISOString() : new Date().toISOString();
  s.close(); G.stores.splice(G.stores.indexOf(s), 1);
}

// ---- tick plumbing ----
const probeFor = (refuse = []) => async (selector) => (refuse.includes(selector) ? { result: "model_missing", kind: "model_missing" } : { result: "pass", kind: "ok" });
const rolesOf = (store, catalog) => new G.d.RoleResolver({ store, env: () => process.env, readCatalog: async () => catalog });
async function tick(store, catalog, now, refuse = []) {
  await G.d.runRolesTick({ store, modelProbe: probeFor(refuse) }, { modelRoles: () => rolesOf(store, catalog) }, now, STUB_CHAT, new AbortController().signal);
}
const gateway = (store) => new G.d.Gateway(store);
const typed = (type, key, extra = {}) => G.d.buildTypedTaskEvent({ source: "telegram", type, requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: STUB_CHAT },
  idempotency_key: `telegram:${key}`, source_reference: `telegram:update:${key}`, ...extra });

// ---- the eight lines; each returns the list of failed-check codes ----
const check = (fails, ok, code) => { if (!ok) fails.push(code); };

/** 1. omp_unavailable (a page kind) opened: one outbox row, zero change_log rows. */
function line1(L) {
  const fails = []; const o0 = outboxCount(L); const c0 = changeCount(L);
  const opened = G.d.openAlertedIncident(L, { kind: "omp_unavailable", subject: "omp:gate-chat-is-for-paco", detail: {}, chat_id: STUB_CHAT, env: {} });
  const o = outboxCount(L) - o0; const c = changeCount(L) - c0;
  check(fails, opened, "not_opened"); check(fails, o === 1, `page_outbox_rows=${o}`); check(fails, c === 0, `page_change_log_rows=${c}`);
  return fails;
}
/** 2. decision_record_failed (a log kind) opened with no chat configured: one change_log row, zero outbox rows. */
function line2(L) {
  const fails = []; const o0 = outboxCount(L); const c0 = changeCount(L, "incident_log");
  const opened = G.d.openAlertedIncident(L, { kind: "decision_record_failed", subject: "gate.chat-is-for-paco", detail: {}, env: {} }); // no chat_id, empty env: no chat anywhere
  const o = outboxCount(L) - o0; const c = changeCount(L, "incident_log") - c0;
  check(fails, opened, "not_opened"); check(fails, o === 0, `log_outbox_rows=${o}`); check(fails, c === 1, `log_change_log_rows=${c}`);
  return fails;
}
/** 3. the tick: gemini-pro adopts the new Gemini; the legacy card override is retired; no outbox row; >= 1 model_change row; zero shadow lines. */
async function line3(T) {
  const fails = []; const o0 = outboxCount(T); const m0 = changeCount(T, "model_change");
  await tick(T, G.catalog, G.tickNow);
  const pro = T.listModelTiers().find((t) => t.tier === "gemini-pro");
  check(fails, pro?.adopted === ARGON, "gemini_pro_not_adopted");
  check(fails, !T.latestModelRoleOverrides().has("judges:2"), "override_not_retired");
  check(fails, !T.latestOverrideRows().has("judges:2"), "override_row_still_live");
  const o = outboxCount(T) - o0; check(fails, o === 0, `tick_outbox_rows=${o}`);
  const notices = changeRows(T, "model_change"); const m = notices.length - m0; check(fails, m >= 1, `model_change_rows=${m}`);
  check(fails, notices.every((n) => !n.text.includes("your override")), "shadow_line_present");
  const last = T.latestModelRolesResolved(); const seat = last?.roles.find((r) => r.key === "judges:2");
  check(fails, seat?.source === "list" && typeof seat.head === "string" && seat.head.includes(ARGON), "seat2_not_from_list");
  return fails;
}
/** 4. a planted Kimi move: exactly one model_change row, naming three roles (on top of line 3's tick). */
async function line4(T) {
  const fails = []; const o0 = outboxCount(T); const m0 = changeCount(T, "model_change");
  const kimi = G.catalog.find((m) => m.provider === "kimi-code" && /^k\d/.test(m.id));
  if (!kimi) return ["no_kimi_in_catalog"];
  const catalog = [...G.catalog, { ...kimi, id: PLANTED_KIMI_ID }];
  await tick(T, catalog, new Date(Date.parse(G.tickNow) + 25 * 3_600_000).toISOString());
  const rows = changeRows(T, "model_change").slice(m0); const o = outboxCount(T) - o0;
  check(fails, rows.length === 1, `model_change_rows=${rows.length}`);
  const roles = /\(used by ([^)]*)\)/.exec(rows[0]?.text ?? "")?.[1]?.split(", ").length ?? 0;
  check(fails, roles === 3, `roles_named=${roles}`); check(fails, o === 0, `tick_outbox_rows=${o}`);
  return fails;
}
/** 5. a planted empty family (the stub probe refuses its only member): the override is untouched and the card offers no proposal. */
async function line5(C) {
  const fails = [];
  const proMembers = new Set(G.d.tierMembers(G.d.tierDef("gemini-pro"), G.catalog));
  const catalog = [...G.catalog.filter((m) => !(m.provider === GOOGLE && proMembers.has(m.id))), PLANTED_EMPTY];
  const before = C.latestOverrideRows().get("judges:2"); const mark = outboxMark(C); // the copy may hold an earlier day's card: only what this tick queued counts
  await tick(C, catalog, G.tickNow, [`${GOOGLE}/${PLANTED_EMPTY.id}`]);
  const after = C.latestOverrideRows().get("judges:2");
  check(fails, before !== undefined && after?.sequence === before.sequence && after.pattern === before.pattern, "override_touched");
  const probes = C.db.prepare("SELECT payload_json FROM ledger_events WHERE event_type = 'model_probe'").all().map((r) => JSON.parse(r.payload_json)).filter((p) => p.tier === "gemini-pro" && p.selector === `${GOOGLE}/${PLANTED_EMPTY.id}`);
  check(fails, probes.length === 1 && probes[0].result === "model_missing", `stub_probe_rows=${probes.length}`);
  const pro = C.listModelTiers().find((t) => t.tier === "gemini-pro"); check(fails, pro?.adopted === null, "tier_adopted_something");
  const queued = outboxAfter(C, mark); const cards = queued.filter((r) => r.key.startsWith("model_tier_card:gemini-pro:"));
  check(fails, cards.length === 1, `cards=${cards.length}`);
  check(fails, cards[0] !== undefined && !("button_rows" in cards[0].payload) && /offers no other/.test(String(cards[0].payload.text)), "card_has_proposals");
  check(fails, queued.filter((r) => r.key.startsWith("incident_opened:")).length >= 1, "role_unresolved_not_paged");
  return fails;
}
/** 6. /changes renders the log (the four id-bearing kinds included) with none of the §8 id shapes, within the Telegram bound. */
function line6(T) {
  const fails = [];
  const subjects = { todo_reminder_seen: "-1001234567890", core_overflow: "chat:1234567890", hostile_schedule_turn: "run_0f8e7d6c-1234-4abc-8def-0123456789ab", standing_settle_failed: "appr_0f8e7d6c-1234-4abc-8def-0123456789ab" };
  for (const [kind, subject] of Object.entries(subjects)) G.d.openAlertedIncident(T, { kind, subject, detail: {}, chat_id: STUB_CHAT, env: {} });
  const mark = outboxMark(T);
  const r = gateway(T).intake(typed("status", "gate-cifp:changes", { metadata: { status_view: "changes" } }));
  const rows = outboxAfter(T, mark);
  const text = String(rows[0]?.payload?.text ?? "");
  check(fails, r.ok === true, "intake_refused"); check(fails, rows.length === 1, `reply_rows=${rows.length}`);
  check(fails, text.length > 0 && text.length <= CHAT_TEXT_MAX, `reply_chars=${text.length}`);
  for (const kind of Object.keys(subjects)) check(fails, text.includes(kind), `kind_missing_${kind}`);
  ID_SHAPES.forEach((re, i) => check(fails, !re.test(text), `id_shape_${i}`));
  check(fails, /Kimi|Google|tier/.test(text), "model_change_rows_missing");
  return fails;
}
/** 7. a /status reply: one outbox row, zero change_log rows (a wrong default on the reply path fails here). */
function line7(T) {
  const fails = []; const o0 = outboxCount(T); const c0 = changeCount(T);
  const r = gateway(T).intake(typed("status", "gate-cifp:status"));
  const o = outboxCount(T) - o0; const c = changeCount(T) - c0;
  check(fails, r.ok === true, "intake_refused"); check(fails, o === 1, `status_outbox_rows=${o}`); check(fails, c === 0, `status_change_log_rows=${c}`);
  return fails;
}
/** 8. a kind absent from the table (an old row's string) pages. */
function line8(L) {
  const fails = []; const o0 = outboxCount(L); const c0 = changeCount(L);
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => (String(chunk).startsWith("incident-route:") ? true : realWrite(chunk, ...rest)); // the route's own "no route" notice names the kind; keep stderr quiet
  let opened;
  try { opened = G.d.openAlertedIncident(L, { kind: "gate_unclassified_kind", subject: "gate", detail: {}, chat_id: STUB_CHAT, env: {} }); } finally { process.stderr.write = realWrite; }
  const o = outboxCount(L) - o0; const c = changeCount(L) - c0;
  check(fails, opened, "not_opened"); check(fails, o === 1, `unknown_kind_outbox_rows=${o}`); check(fails, c === 0, `unknown_kind_change_log_rows=${c}`);
  return fails;
}

function verdict(n, fails) {
  out.push(fails.length === 0);
  console.log(fails.length === 0 ? `PASS ${n}` : `FAIL ${n}: ${fails.join(",")}`);
}
async function runLine(n, fn) {
  try { verdict(n, await fn()); } catch (e) {
    if (DEBUG) console.error(`# debug line ${n}: threw ${errCode(e)}`);
    verdict(n, [`threw_${errCode(e)}`]);
  }
}

// ---- setup / main ----
function ompBinFromEnvFile(envFile) {
  try { return /^HOUGE_OMP_BIN=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null; } catch { return null; }
}
const killFiles = () => [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
const load = (rel) => import(join(DIST, rel));
async function loadDistModules() {
  const [store, so, inc, roles, cat, ocfg, tiers, daemon, gw, rr] = await Promise.all([load("run/run-store.js"), load("run/store-options.js"), load("run/incident-alert.js"), load("omp/role-resolver.js"),
    load("omp/model-catalog.js"), load("omp/omp-config.js"), load("omp/model-tiers.js"), load("telegram/telegram-daemon.js"), load("gateway/gateway.js"), load("domain/types.js")]);
  const d = { RunStore: store.RunStore, storeOptionsFor: so.storeOptionsFor, openAlertedIncident: inc.openAlertedIncident, RoleResolver: roles.RoleResolver, readOmpCatalog: cat.readOmpCatalog,
    resolveOmpCatalogConfig: ocfg.resolveOmpCatalogConfig, tierMembers: tiers.tierMembers, tierDef: tiers.tierDef, runRolesTick: daemon.runRolesTick, Gateway: gw.Gateway, buildTypedTaskEvent: rr.buildTypedTaskEvent };
  for (const [k, v] of Object.entries(d)) if (!v) throw new SetupError(`${k} missing from dist: rebuild`);
  return d;
}
function pinEnv(root) {
  G.saved = Object.fromEntries([...SET_PINS, ...DELETE_PINS, "HOUGE_OMP_BIN"].map((k) => [k, process.env[k]]));
  for (const k of DELETE_PINS) delete process.env[k];
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_MODEL_ROLES: "resolved" });
}
function restoreEnv() {
  if (!G.saved) return;
  for (const [k, v] of Object.entries(G.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  G.saved = null;
}
async function setup() {
  const envFile = resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(envFile), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  if (killFiles() !== 0) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  const bin = ompBinFromEnvFile(envFile);
  G.root = initTemp(false); pinEnv(G.root);
  if (bin && !process.env.HOUGE_OMP_BIN) process.env.HOUGE_OMP_BIN = bin;
  G.d = await loadDistModules();
  G.base = join(G.root, "base.sqlite");
  vacuumInto(liveDb, G.base);
  normaliseBase();
  G.catalog = await G.d.readOmpCatalog(G.d.resolveOmpCatalogConfig(process.env)); // the one real omp read (preflight)
  if (!G.catalog || G.catalog.length === 0) throw new SetupError("catalog unavailable");
  note(`catalog models=${G.catalog.length}`);
}
function closeAll() { for (const s of G.stores.splice(0)) { try { s.close(); } catch { /* a closed handle is not a finding */ } } }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });

try {
  await setup();
  const L = fork("log"); const T = fork("tick"); const C = fork("card");
  await runLine(1, () => line1(L));
  await runLine(2, () => line2(L));
  await runLine(3, () => line3(T));
  await runLine(4, () => line4(T));
  await runLine(5, () => line5(C));
  await runLine(6, () => line6(T));
  await runLine(7, () => line7(T));
  await runLine(8, () => line8(L));
  const tomb = killFiles();
  if (tomb !== 0) { out.push(false); console.log(`FAIL post: houge.kill_found=${tomb}`); }
  const passed = out.filter(Boolean).length;
  process.exitCode = out.length === 8 && passed === 8 ? 0 : 1;
  console.log(`${process.exitCode === 0 ? "PASS" : "FAIL"} gate — ${passed}/8`);
} catch (e) {
  console.error(`setup_failed${e instanceof SetupError ? `: ${e.message}` : ""}`);
  if (DEBUG) console.error(`# debug: setup threw ${errCode(e)}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  closeAll(); cleanupTemp(); restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
