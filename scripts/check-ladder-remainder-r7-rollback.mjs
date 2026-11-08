#!/usr/bin/env node
// Rollback check — decision ladder remainder R7, attach.path (spec 2026-11-08 R7 §7; plan Task 9).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/check-ladder-remainder-r7-rollback.mjs \
//     --old-dist <main checkout>/.worktrees/base-<12-char sha>/dist [--old-base-r7 <full sha>] [--live-db <path>]
// --old-base-r7 <full sha>: only after the merge (the merge base is then this build's own HEAD); on the branch the merge base is discovered.
// Provenance file: notifications/telegram-notification-adapter.js.
// R7 adds record-only attach.path decision rows (no migration, no table), written by this build through its real paths: parse (the dist PlannerSupervisor on a fake child,
// scripts/stage4-supervisor-fixture.mjs, a final text with a `../` marker) and send (the dist NotificationDispatcher + workspaceTelegramAdapter over a fake Telegram client,
// the file kinds of scripts/stage4-delivery-fixture.mjs), plus one planted decide throw (rung fail). The merge-base build knows no such id.
// Two VACUUM copies: A (never seeded) and F (cut from A, then seeded by this build, dated now so inside the /status 24 h window). Prep on A before the cut: non-final outbox
// rows parked. The old build then opens both copies; its /status (every line but attach.path byte-identical A vs F; that line, rendered without the seam suffix, equals the line built
// from SQL), list and ENTRY_IDS-validated writer (review_ok) are compared; its own dispatcher then delivers a final_report with two attachments on F; this build reopens F.
// Exit 0 PASS · 1 FAIL · 2 setup error. The live DB is read only by VACUUM INTO; every write goes to a copy under /tmp/hg-s4d-* (the fixtures' workdirs, hdl-* and hsv-*, under os.tmpdir()), all removed on every exit path (pass, FAIL, throw,
// SIGINT, SIGTERM, SIGHUP, SIGQUIT, uncaught exception). Pins set before any store opens and restored on exit: HOUGE_DAEMON_TMP_DIR / HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH
// under the temp root, HOUGE_TELEGRAM_CHAT_ID = -1003; scheduler/radar/media flags deleted. No omp, no Telegram client. Only line names, entry ids, counts, verdicts and codes from
// closed sets are printed; never an error message from a build or the DB, message text, chat id or file path. Synthetic text only.
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyStampedDist } from "./old-dist-provenance.mjs";
import * as fx from "./stage4-supervisor-fixture.mjs";
import { CHAT, makeFiles, mkData, removeDeliveryDirs } from "./stage4-delivery-fixture.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const AP = "attach.path";
const MIB = 1024 * 1024;
const TABLES = ["decisions", "decision_outcomes", "notification_outbox", "telegram_command_audit", "runs"];
const BIG = 1_000_000_000; // caps no real copy reaches
const STUB_CHAT = "-1003"; // numeric, not a real chat
const SET_PINS = ["HOUGE_DAEMON_TMP_DIR", "HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES", "HOUGE_LESSON_CHAR_CAP", "HOUGE_LESSON_CAP_PER_SCOPE", "HOUGE_MAX_CONSECUTIVE_CLARIFY", "HOUGE_CHAT_CONTEXT_TURNS", "HOUGE_EMBED_URL", "HOUGE_EMBED_MODEL", "HOUGE_EMBED_TIMEOUT_MS", "HOUGE_MODEL_ROLES"];
const failures = [];
const saved = {};
const J = (o) => JSON.stringify(o);
const same = (a, b) => J(a) === J(b);
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const handles = [];
const yieldLoop = () => new Promise((r) => setImmediate(r)); // lets a SIGINT/SIGTERM handler run during an otherwise synchronous run

const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError", "AbortError"]);
const SYSTEM_CODES = new Set(["ERR_SQLITE_ERROR", "ERR_MODULE_NOT_FOUND", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_STATE", "ERR_ASSERTION",
  "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CONSTRAINT", "SQLITE_CORRUPT", "SQLITE_FULL", "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_CANTOPEN",
  "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOSPC", "EBUSY", "EISDIR", "ENOTDIR", "EMFILE", "ETIMEDOUT", "ECONNREFUSED", "ESRCH"]);
/** A thrown value prints as a standard class name and a system code from a closed set, never its message. */
function errCode(e) {
  const name = e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error";
  const code = typeof e?.code === "string" ? (SYSTEM_CODES.has(e.code) ? ` ${e.code}` : " <other>") : "";
  return `${name}${code}`;
}

/** VACUUM INTO `to` from `from` (read-only source); a daemon write lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt_ = 1; ; attempt_++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt_ >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
function openStore(d, path) {
  const store = d.RunStore.open(path, d.storeOptionsFor ? d.storeOptionsFor(undefined, {}) : {});
  handles.push(store);
  return store;
}
const closeStore = (s) => { try { s.close(); } catch { /* a closed handle is not a finding */ } };
const ro = (path, fn) => { const db = new DatabaseSync(path, { readOnly: true }); try { return fn(db); } finally { db.close(); } };
const counts = (path) => ro(path, (db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])));
const apCount = (path) => ro(path, (db) => db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?").get(AP).n);
/** The schema as a hash (every object's type, name, sql) plus user_version and every schema_migrations row: a migration changes it. */
const schemaOf = (path) => ro(path, (db) => ({
  uv: db.prepare("PRAGMA user_version").get().user_version,
  hash: createHash("sha256").update(J(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all())).digest("hex").slice(0, 12),
  mig: createHash("sha256").update(J(db.prepare("SELECT * FROM schema_migrations ORDER BY rowid").all())).digest("hex").slice(0, 12)
}));
const canonRow = (r) => J(Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]])));
/** Every decisions row, whole, as canonical JSON, ordered by rowid. */
const contentOf = (path) => ro(path, (db) => db.prepare("SELECT * FROM decisions ORDER BY rowid").all().map(canonRow));
/** Primary keys of the tracked tables: a lost row is a missing key. */
function keysOf(path) {
  return ro(path, (db) => Object.fromEntries(TABLES.map((t) => {
    const pk = db.prepare(`PRAGMA table_info(${t})`).all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const cols = pk.length ? pk : ["rowid"];
    return [t, new Set(db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${t}`).all().map((r) => cols.map((c) => String(r[c])).join("|")))];
  })));
}
const lost = (before, after) => TABLES.map((t) => [...before[t]].filter((k) => !after[t].has(k)).length);

// ---- the /status count line for attach.path, straight from SQL ----
const WINDOW_MS = 24 * 60 * 60 * 1000;
const RUNG_ORDER = ["rule", "system_one", "model", "paco", "fail"]; const RUNG_LABEL = { rule: "code", system_one: "Jev", model: "model", paco: "you", fail: "fallback" };
const windowRows = (path, now) => {
  const since = new Date(Date.parse(now) - WINDOW_MS).toISOString();
  return ro(path, (db) => db.prepare("SELECT rung, verdict, reason_code FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ?").all(AP, since, now));
};
/** The base count line `· attach.path <n> — <rung> <k> · …` for a set of rows (rung order as digest.ts countLines). */
function rungLine(rows) {
  const m = new Map(); for (const r of rows) m.set(r.rung, (m.get(r.rung) ?? 0) + 1);
  const known = RUNG_ORDER.filter((k) => m.has(k)).map((k) => `${RUNG_LABEL[k]} ${m.get(k)}`);
  const other = [...m.keys()].filter((k) => !RUNG_ORDER.includes(k)).sort().map((k) => `${k} ${m.get(k)}`);
  return `· ${AP} ${rows.length} — ${[...known, ...other].join(" · ")}`;
}
/** The count line (digest.ts countLines format) from SQL over the window; null when the window holds no attach.path row. `suffix` is the R7 seam suffix of status-lines.ts attachSuffix. */
function expectedLine(path, now, suffix) {
  const rows = windowRows(path, now);
  if (rows.length === 0) return null;
  const line = rungLine(rows);
  if (!suffix) return line;
  const refused = rows.filter((r) => r.verdict === "refuse"); const failed = refused.filter((r) => r.rung === "fail").length;
  const parse = refused.filter((r) => r.rung !== "fail" && r.reason_code === "marker_outside").length;
  return `${line} (parse ${parse} · send ${refused.length - failed - parse} · failed ${failed})`;
}
const norm = (l) => l.replace(/\b\d\d-\d\d \d\d:\d\d\b/g, "<ts>");
const shortRun = (run_id) => (run_id ? run_id.replace(/^run_/, "").slice(0, 8) : "–"); // status-view.ts shortRun
/** The recent-list line for a seeded row, as the old build renders it (status-view.ts recentLine). */
const listLine = (r, label) => `<ts> · ${r.entry_id} · ${label(r.rung)} → ${r.verdict} · p ${r.p === null ? "–" : r.p.toFixed(2)} · run ${shortRun(r.run_id)}`;
const apLines = (lines) => lines.filter((l) => l.startsWith(`· ${AP} `));
const otherLines = (lines) => lines.filter((l) => !l.startsWith(`· ${AP} `));

// ---- step 1: this build writes the rows through its real parse and send paths ----
let seq = 0;
function mkRun(d, store, tag) {
  seq += 1;
  const r = new d.Gateway(store, { ...d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG }).intake(d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "synthetic", requested_by: { kind: "user", id: `rb-r7-${tag}-${seq}` },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `rb-r7:${tag}:${seq}`, source_reference: `telegram:update:${seq}:message:${seq}` }));
  if (!r.ok) throw new Error("rollback: run intake refused");
  return r.run_id;
}
/** The fake Telegram client: every call, in order. */
function mkClient() {
  const log = [];
  return { log, client: {
    sendMessage: async (m) => { log.push(["msg", m.text]); return { message_id: log.length }; },
    sendDocument: async (doc) => { log.push(["doc", doc.filename, doc.content.length, createHash("sha256").update(Buffer.from(doc.content)).digest("hex").slice(0, 16)]); }
  } };
}
const uploadsOf = (log) => log.filter((e) => e[0] === "doc").map((e) => e.slice(1));
const followOf = (log) => log.filter((e) => e[0] === "msg" && e[1].startsWith("⚠")).map((e) => e[1]);
const parkExcept = (store, id) => store.db.prepare("UPDATE notification_outbox SET state = 'failed_terminal' WHERE state NOT IN ('delivered', 'failed_terminal') AND notification_id != ?").run(id ?? "").changes;
const localAdapter = () => ({ send: async () => ({ provider_message_id: "local" }) });
const names = (n) => Array.from({ length: n }, (_, i) => [`f${i + 1}.txt`, "file"]);
const BIGFILE = ["big.bin", "sparse", 21 * MIB];

/** One delivery of `spec` { files, runless, wsSwap, plant } through build `d`'s dispatcher on `store`; the recorder is `d`'s own store recorder when `record`. Returns { run, log, status, id }. */
async function deliverOn(d, store, spec, record) {
  const { data, ws } = mkData(d); const paths = makeFiles(data, ws, spec.files);
  const run = spec.runless ? null : mkRun(d, store, "send");
  const outbox = new d.NotificationOutbox(store);
  if (run) store.enqueueFinalReportNotification(run, { text: "here you go", report_path: "r.md", attachments: paths });
  else outbox.enqueue({ topic: "reply", target: { kind: "telegram", chat_id: CHAT }, intent_type: "progress", idempotency_key: `rb-r7:p:${seq += 1}`, correlation_id: `rb-r7:p:${seq}`, payload: { text: "here you go", attachments: paths } });
  const id = store.db.prepare("SELECT notification_id FROM notification_outbox WHERE state NOT IN ('delivered', 'failed_terminal') AND payload_json LIKE '%here you go%' ORDER BY rowid DESC LIMIT 1").get()?.notification_id;
  if (!id) throw new Error("rollback: the seeded notification is missing");
  parkExcept(store, id);
  if (spec.wsSwap) { renameSync(ws, `${ws}.real`); symlinkSync(`${ws}.real`, ws); }
  const { client, log } = mkClient();
  const dispatcher = new d.NotificationDispatcher(outbox, { local: localAdapter(), telegram: d.workspaceTelegramAdapter(client, data) }, record ? { recorder: d.storeRecorder(store) } : {});
  const rung = d.ATTACH_PATH?.ladder[0]; const orig = rung?.decide;
  if (spec.plant) rung.decide = () => { throw new Error("planted"); };
  try { const res = await dispatcher.dispatchOnce("rollback"); return { run, log, id, status: res.status, delivered: res.notification_id === id }; }
  finally { if (spec.plant) rung.decide = orig; }
}
/** Spec R7 §7: [label, spec] in the order they are written onto F. */
const SENDS = [["too_large", { files: [BIGFILE] }], ["workspace_unverified", { files: [["a.txt", "file"]], wsSwap: true }], ["not_found", { files: [["gone.txt", "missing"]] }],
  ["over_count", { files: names(6) }], ["progress_runless", { files: [["gone.txt", "missing"]], runless: true }], ["fail_rung", { files: [BIGFILE], plant: true }]];
/** [label of the consulting run, rung, verdict, reason_code] in write order: the parse row first, then the six sends. */
const EXPECTED = [["parse", "rule", "refuse", "marker_outside"], ["too_large", "rule", "refuse", "too_large"], ["workspace_unverified", "rule", "refuse", "workspace_unverified"],
  ["not_found", "rule", "refuse", "not_found"], ["over_count", "rule", "refuse", "over_count"], ["progress_runless", "rule", "refuse", "not_found"], ["fail_rung", "fail", "refuse", null]];

async function seedParse(ctx, store) {
  try {
    const session = fx.fakeSession({ final: "ok\n[[attach: ../x]]" });
    const { sup } = fx.mkSupervisor(ctx.dNew, store, { recorder: ctx.dNew.storeRecorder(store), session });
    const id = mkRun(ctx.dNew, store, "parse"); sup.submit(fx.req(id, "hi")); await sup.whenIdle();
    return id;
  } finally { await fx.cleanup(); }
}
async function seedF(ctx, path) {
  const s = openStore(ctx.dNew, path); const runs = {};
  try {
    runs.parse = await seedParse(ctx, s);
    for (const [label, spec] of SENDS) { const r = await deliverOn(ctx.dNew, s, spec, true); runs[label] = r.run; if (!r.delivered) throw new Error("rollback: a seeded send was not the delivered row"); }
    return runs;
  } finally { closeStore(s); }
}
/** The attach.path rows of F as [run label, rung, verdict, reason_code], in write order, with the exact fields the old build must read back. */
function seededRows(path, runs) {
  const label = (id) => (id === null ? "progress_runless" : Object.entries(runs).find(([, v]) => v === id)?.[0] ?? "?");
  return ro(path, (db) => db.prepare("SELECT entry_id, p, run_id, rung, verdict, reason_code, entry_version, decision_id FROM decisions WHERE entry_id = ? ORDER BY rowid").all(AP).map((r) => ({ ...r, label: label(r.run_id) })));
}

// ---- step 2: the merge base on the copy ----
/** review_ok naming attach.path must be refused by the old build's own ENTRY_IDS; a valid id is accepted, so the refusal is about the value. */
function outcomeProbes(store) {
  const decision_id = store.db.prepare("SELECT decision_id FROM decisions WHERE entry_id != ? ORDER BY rowid LIMIT 1").get(AP)?.decision_id;
  if (!decision_id) throw new Error("the copy holds no decision row to attach an outcome to");
  const probe = (value) => {
    try { return `inserted:${store.insertDecisionOutcome({ decision_id, signal: "review_ok", value, source: "code" }).inserted}`; }
    catch (e) { return e?.constructor?.name === "OutcomeRejected" && /^value not allowed for review_ok$/.test(e.message) ? "OutcomeRejected:value not allowed for review_ok" : `error:${errCode(e)}`; }
  };
  return Object.fromEntries([AP, "tool.policy"].map((v) => [v, probe(v)]));
}
async function oldSteps(ctx, path, now) {
  const { dOld, mOld } = ctx;
  const s = openStore(dOld, path); // the old build opens the copy; its migrations ran
  const r = { schemaAfterOpen: schemaOf(path) };
  await yieldLoop();
  r.status = mOld.decisionStatusLines(s, now);
  r.listText = mOld.decisionListText(s, process.env).split("\n");
  const all = s.listRecentDecisions(100_000);
  r.listedAll = all.length;
  r.readRows = all.map((x) => ({ ...x }));
  r.read = all.map(canonRow).sort();
  r.outcomes = outcomeProbes(s);
  closeStore(s);
  return r;
}

/** Disables every enabled schedule on the copy through the store's own cancelScheduledTask and parks non-final outbox rows (a poll flush would send them). */
function prepA(dNew, path) {
  const s = openStore(dNew, path);
  try {
    const cancelled = s.listScheduledTasks().filter((t) => t.state === "enabled").filter((t) => s.cancelScheduledTask(t.schedule_id)).length;
    const parked = s.db.prepare("UPDATE notification_outbox SET state = 'failed_terminal' WHERE state NOT IN ('delivered', 'failed_terminal')").run().changes;
    return { cancelled, parked };
  } finally { closeStore(s); }
}

async function setup() {
  if (!DIST.includes("/.worktrees/")) throw new SetupError("run from the worktree; never build in the main checkout");
  if (!arg("--old-dist")) throw new SetupError("usage: --old-dist <merge-base dist> [--old-base-r7 <full sha>] [--live-db <path>]");
  const oldDist = resolve(arg("--old-dist"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  let prov, base;
  try { base = mergeBaseOf(DIST, arg("--old-base-r7")); prov = verifyStampedDist(oldDist, DIST, base, "notifications/telegram-notification-adapter.js"); } catch (e) { throw new SetupError(provenanceText(e)); }
  console.log(`old build pinned to base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, stamped dist ${prov.hash.slice(0, 12)}`);
  const root = initTemp(false);
  for (const k of [...SET_PINS, ...DELETE_PINS]) saved[k] = process.env[k];
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID", ...DELETE_PINS]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-rollback/omp", HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_ENABLED: "0", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  for (const k of ["storeOptionsFor", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "storeRecorder", "PlannerSupervisor", "ToolRegistry", "resolveOmpConfig", "NotificationOutbox", "NotificationDispatcher", "workspaceTelegramAdapter", "chatWorkspace", "ATTACH_PATH"]) if (!dNew[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  for (const k of ["RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "NotificationOutbox", "NotificationDispatcher", "workspaceTelegramAdapter", "chatWorkspace"]) if (!dOld[k]) throw new SetupError(`${k} missing from the old dist`);
  const mods = async (dist) => ({ ...(await import(join(dist, "decisions/digest.js"))), ...(await import(join(dist, "decisions/status-lines.js"))), ...(await import(join(dist, "decisions/status-view.js"))) });
  const [mNew, mOld] = [await mods(DIST), await mods(oldDist)];
  const A = join(mkTemp("copy-A"), "houge.sqlite"); const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, A);
  const prep = prepA(dNew, A);
  vacuumInto(A, F); // F is cut from the prepped A, so a daemon write between two live reads cannot separate them
  return { dNew, dOld, mNew, mOld, A, F, root, prep };
}

const OUT_REJ = "OutcomeRejected:value not allowed for review_ok";
/** Step 1: snapshot F, seed it through this build's real paths, mirror the chat turns onto A, check the seeded rows. */
async function seedPhase(ctx, st) {
  const { A, F } = ctx;
  phase = "snapshot"; const before = { schema: schemaOf(F), apN: apCount(F) };
  phase = "seed F"; const runs = await seedF(ctx, F);
  const rows = seededRows(F, runs); const got = rows.slice(before.apN).map((r) => [r.label, r.rung, r.verdict, r.reason_code]);
  const snapF = { counts: counts(F), keys: keysOf(F), schema: schemaOf(F), content: contentOf(F) };
  const snapA = { counts: counts(A), keys: keysOf(A), schema: schemaOf(A), content: contentOf(A) };
  check("this build wrote exactly the seven expected attach.path rows through its real paths: the parse refusal marker_outside (the dist supervisor, a `../` marker) and, at the send seam, too_large, workspace_unverified, not_found and over_count with a run id, not_found with run_id null (progress_runless) and one refusal at rung fail (planted throw); each at entry_version of the entry, nothing else",
    same(got, EXPECTED) && rows.slice(before.apN).every((r) => r.entry_version === ctx.dNew.ATTACH_PATH.version) && rows.slice(before.apN).every((r) => (r.label === "progress_runless") === (r.run_id === null)) && rows.length === before.apN + 7
    && snapF.counts.decisions === snapA.counts.decisions + 7 && same(before.schema, snapF.schema),
    `rows ${got.map((r) => `${r[0]}:${r[1]}/${r[2]}/${r[3]}`).join(" ")} · attach.path rows A ${apCount(A)} F ${apCount(F)} · outbox parked on A ${ctx.prep.parked}`);
  Object.assign(st, { before, runs, rows, snapF, snapA });
}
/** Step 2: the old build on A and F, and the no-migration check. */
async function oldPhase(ctx, st) {
  const { A, F } = ctx; const { snapA, snapF, before } = st;
  await yieldLoop();
  const now = new Date(Date.now() + 60_000).toISOString();
  phase = "old build on A"; const oa = await oldSteps(ctx, A, now);
  await yieldLoop();
  phase = "old build on F"; const of = await oldSteps(ctx, F, now);
  check("the old build opened both copies and every step (/status, list, review_ok) completed without throwing", true);
  phase = "compare";
  const [aA, aF, schA, schF] = [counts(A), counts(F), schemaOf(A), schemaOf(F)];
  check("the old build ran no migration: the schema (every object's sql and user_version and every schema_migrations row) is identical before and after its open, on A and F, and A equals F",
    same(snapA.schema, oa.schemaAfterOpen) && same(snapF.schema, of.schemaAfterOpen) && same(snapA.schema, schA) && same(snapF.schema, schF) && same(snapA.schema, snapF.schema) && same(before.schema, snapF.schema),
    `${snapF.schema.hash} migrations ${snapF.schema.mig} uv ${snapF.schema.uv} -> A ${schA.hash} / F ${schF.hash}`);
  Object.assign(st, { now, oa, of, aA, aF });
}
/** Step 3: the rendered comparisons and row integrity. */
function compareAndRefusePhase(ctx, st) {
  const { A, F, mOld } = ctx; const { rows, snapF, snapA, now, oa, of, aA, aF, before } = st;
  const fRows = rows.slice(before.apN);
  const lineF = apLines(of.status); const wantF = rungLine([...fRows, ...windowRows(A, now)]); // the seeded rows plus A's in-window prior, whatever rungs the prior holds
  const noDigest = mOld.buildDecisionDigest === undefined; // the nightly digest is gone from the merge base too (spec 2026-11-07): nothing to compare, and a build that brings it back must fail here
  const [head, ...aRows] = oa.listText.map(norm);
  const wantList = [head, ...[...fRows].reverse().map((r) => listLine(r, mOld.deciderLabel)), ...aRows].slice(0, 11);
  const listOk = same(of.listText.map(norm), wantList);
  const sqlF = expectedLine(F, now, false); const sqlA = expectedLine(A, now, false);
  const ok = noDigest && listOk && same(otherLines(oa.status), otherLines(of.status)) && of.status.length === oa.status.length + 1 - (apLines(oa.status).length)
    && same(lineF, [sqlF]) && (windowRows(A, now).length > 0 || lineF[0] === wantF) && same(apLines(oa.status), sqlA === null ? [] : [sqlA]) && !/\(parse /.test(lineF[0] ?? "");
  check("A vs F as rendered by the old build: the nightly digest has no builder in the old build (gone since spec 2026-11-07), /status is byte-identical in every line but attach.path, that line (rendered without the seam suffix) equals the rung-count line `· attach.path <n> — code … · fallback …` computed from the seeded rows plus the copy's in-window prior, and the /status decisions list is A's with the seven seeded rows on top",
    ok, `F line [${lineF.join(" | ")}] = SQL-built ${same(lineF, [sqlF])} · A attach.path lines ${apLines(oa.status).length} · other lines ${otherLines(of.status).length} equal ${same(otherLines(oa.status), otherLines(of.status))} · digest builder absent ${noDigest} · /status decisions list = A's with the seven seeded rows on top ${listOk} (F ${of.listText.length - 1} rows)`);
  const readBack = rows.map((r) => of.readRows.find((x) => x.decision_id === r.decision_id));
  const gone = lost(snapF.keys, keysOf(F)); const goneA = lost(snapA.keys, keysOf(A));
  const seeded = fRows.every((r) => { const x = of.readRows.find((y) => y.decision_id === r.decision_id); return x && x.rung === r.rung && x.entry_version === r.entry_version && x.verdict === r.verdict && x.reason_code === r.reason_code && x.run_id === r.run_id && x.entry_id === AP; });
  check("every decisions row is intact after the old build, on A and F: the count the same before and after, no key lost, every row's full content equal to SQL before it opened, its list reads every row, and each of the seven attach.path rows reads back unchanged (rung, entry_version, verdict, reason_code, run_id)",
    aF.decisions === snapF.counts.decisions && aA.decisions === snapA.counts.decisions && [...gone, ...goneA].every((n) => n === 0) && same(contentOf(F), snapF.content) && same(contentOf(A), snapA.content)
    && same(of.read, [...snapF.content].sort()) && same(oa.read, [...snapA.content].sort()) && of.listedAll === aF.decisions && oa.listedAll === aA.decisions && seeded && readBack.every(Boolean),
    `decisions A ${snapA.counts.decisions} -> ${aA.decisions}, F ${snapF.counts.decisions} -> ${aF.decisions} · keys lost ${[...gone, ...goneA].reduce((a, b) => a + b, 0)} · attach.path rows read ${readBack.filter(Boolean).length}/${rows.length} exact ${seeded}`);
  check("the old build refuses review_ok naming attach.path (normal OutcomeRejected, no crash; a valid id is accepted) on A and F",
    [oa, of].every((x) => x.outcomes[AP] === OUT_REJ && x.outcomes["tool.policy"] === "inserted:true") && same(oa.outcomes, of.outcomes), `A ${J(oa.outcomes)} · F ${J(of.outcomes)}`.replace(/"/g, ""));
  const grew = (x, y) => TABLES.map((t) => y[t] - x[t]);
  check("the old build wrote the same rows to A and F: only decision_outcomes grew, by exactly 1 (its valid-id probe)",
    same(grew(snapA.counts, aA), grew(snapF.counts, aF)) && TABLES.every((t, i) => grew(snapF.counts, aF)[i] === (t === "decision_outcomes" ? 1 : 0)), `growth ${TABLES.map((t, i) => `${t} ${grew(snapA.counts, aA)[i]}/${grew(snapF.counts, aF)[i]}`).join(" · ")} (A/F)`);
  st.keysF = keysOf(F);
}
/** Step 4: the old build's own dispatcher delivers a final_report with two attachments on F (one regular, one 21 MiB sparse) and sends exactly what this build sends. */
async function dispatchPhase(ctx, st) {
  const { F } = ctx; const spec = { files: [["small.txt", "file"], BIGFILE] };
  phase = "old dispatcher on F"; const n0 = apCount(F);
  const s = openStore(ctx.dOld, F); let o;
  try { o = await deliverOn(ctx.dOld, s, spec, false); } finally { closeStore(s); }
  phase = "new reference"; const ref = openStore(ctx.dNew, join(mkTemp("copy-ref"), "ref.sqlite"));
  let n;
  try { n = await deliverOn(ctx.dNew, ref, spec, true); } finally { closeStore(ref); }
  const oneUpload = uploadsOf(o.log).length === 1 && uploadsOf(o.log)[0][0] === "small.txt";
  check("the old build's own dispatcher (NotificationDispatcher + workspaceTelegramAdapter, fake client) delivers a final_report with two attachments on F: the row delivered, one upload, the follow-up line byte-equal to this build's, zero new attach.path rows",
    o.status === "delivered" && o.delivered && oneUpload && same(uploadsOf(o.log), uploadsOf(n.log)) && same(followOf(o.log), ["⚠ Not attached: big.bin (over 20 MB)"]) && same(followOf(o.log), followOf(n.log)) && apCount(F) === n0,
    `dispatch ${o.status} · uploads ${uploadsOf(o.log).length} (want 1) · follow-ups ${followOf(o.log).length} byte-equal to this build's ${same(followOf(o.log), followOf(n.log))} · attach.path rows on F ${n0} -> ${apCount(F)}`);
}
/** Step 5: this build reopens F. */
function reopenPhase(ctx, st) {
  const { F, mNew } = ctx; const { now, rows, before } = st;
  phase = "reopen F"; const s = openStore(ctx.dNew, F);
  const re = mNew.decisionStatusLines(s, now);
  const reRows = s.listRecentDecisions(100_000).map(canonRow).sort();
  closeStore(s);
  const want = expectedLine(F, now, true); const seededN = rows.length - before.apN;
  check("this build reopens F: every attach.path row unchanged, nothing lost, and its /status attach.path line carries the seam suffix with the seeded counts (parse 1 · send 5 · failed 1 over the seeded rows)",
    reRows.length === contentOf(F).length && lost(st.keysF, keysOf(F)).every((n) => n === 0) && same(apLines(re), [want]) && / \(parse \d+ · send \d+ · failed \d+\)$/.test(apLines(re)[0] ?? "") && seededN === 7 && /\(parse (\d+) · send (\d+) · failed (\d+)\)$/.test(want ?? "")
    && (() => { const m = /\(parse (\d+) · send (\d+) · failed (\d+)\)$/.exec(apLines(re)[0] ?? ""); const p = windowRows(ctx.A, now).length === 0; return !p || (m && m[1] === "1" && m[2] === "5" && m[3] === "1"); })(),
    `line [${apLines(re).join(" | ")}] · SQL-built ${same(apLines(re), [want])} · rows read ${reRows.length}`);
  const tomb = [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
  check("no houge.kill tombstone appeared in the cwd or the main checkout", tomb === 0, `found ${tomb} (want 0)`);
}
async function run(ctx) {
  const st = {};
  await seedPhase(ctx, st); await oldPhase(ctx, st); compareAndRefusePhase(ctx, st); await dispatchPhase(ctx, st); reopenPhase(ctx, st);
}

function restoreEnv() { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } delete process.env.HOUGE_OMP_BIN; }
// PlannerSupervisor.shutdown can wait ~5 s on a draining turn before it stops the session (src/omp/planner-supervisor.ts); the bound covers that plus margin.
const SETTLE_BOUND_MS = 15_000;
/** Every exit path: handles closed, the fixtures' /tmp workdirs removed, the copies removed, env restored. */
function onSignal(code) {
  for (const h of handles.splice(0)) closeStore(h);
  Promise.race([fx.cleanupSettled().catch(() => undefined), new Promise((r) => setTimeout(r, SETTLE_BOUND_MS))]).finally(() => { fx.removeDataDirsSync(); removeDeliveryDirs(); cleanupTemp(); restoreEnv(); process.exit(code); });
}
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]]) process.on(sig, () => onSignal(code));
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.error(`${ev}: ${errCode(e)}`); onSignal(2); });

export async function main() {
  let root;
  try {
    const ctx = await setup(); root = ctx.root;
    try { await run(ctx); } catch (e) { check(`run — unexpected error at ${phase}: ${errCode(e)}`, false); }
    console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(e instanceof SetupError ? `setup_failed: ${e.message}` : `setup_failed: ${errCode(e)}`);
    process.exitCode = 2;
  } finally {
    for (const h of handles.splice(0)) closeStore(h);
    await fx.cleanupSettled().catch(() => undefined);
    removeDeliveryDirs();
    await runClosers();
    cleanupTemp();
    restoreEnv();
    if (root) console.error(`# temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
