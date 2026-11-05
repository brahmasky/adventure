#!/usr/bin/env node
// Rollback check — decision ladder remainder R5, context.recall + context.catch_up + context.lessons + turn.clarify_cap (spec 2026-11-02 R5 §8; plan Task 7).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-ladder-remainder-r5-rollback.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-<12-char sha>/dist [--old-base-r5 <full sha>] [--live-db <path>]
// --old-base-r5 <full sha>: only after the merge (the merge base is then this build's own HEAD); on the branch the merge base is discovered (P1).
// Provenance file: omp/turn-context.js.
// R5 adds record-only decision rows (no migration, no table): context.recall include/embedded and none/embed_failed, context.catch_up inject/all and none/read_failed,
// context.lessons capped/char_cap, turn.clarify_cap cap/cap_reached, each with the consulting run's id.
// Two VACUUM copies: A (never seeded) and F (cut from A, then seeded by this build through the real dist PlannerSupervisor on a fake child, with
// scripts/stage4-supervisor-fixture.mjs: a stubbed retrieve returning embedded / embedding-failed telemetry; a throwing laneTurnsSince, then two lane rows after a planner
// answer; two over-cap lessons at a 40-char cap; a trailing clarify turn). Prep on A before the cut: non-final outbox rows parked. The old build then opens both copies;
// everything it renders (/status decisions lines, digest, /status decisions list) is compared A against F; its ENTRY_IDS-validated writer (review_ok) must refuse each new id
// normally; this build then reopens F. Exit 0 PASS · 1 FAIL · 2 setup error. The live DB is read only by VACUUM INTO; every write goes to a copy under /tmp/hg-s4d-*, removed
// on every exit path (pass, FAIL, throw, SIGINT, SIGTERM, SIGHUP, SIGQUIT, uncaught exception). Pins set before any store opens and restored on exit: HOUGE_TOMBSTONE_PATH /
// HOUGE_DISARM_PATH under the temp root (P2), HOUGE_TELEGRAM_CHAT_ID = -1003 (P3); scheduler/radar/media flags deleted. No omp, no Telegram client. Only line names, entry ids,
// counts, verdicts and codes from closed sets are printed; never an error_ref, message or stack.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyStampedDist } from "./old-dist-provenance.mjs";
import * as fx from "./stage4-supervisor-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const RC = "context.recall"; const CU = "context.catch_up"; const LS = "context.lessons"; const CC = "turn.clarify_cap";
const NEW_IDS = [RC, CU, LS, CC];
const CHAT = "42"; // the fixture supervisor's chat
const NO_CAP = { HOUGE_LESSON_CHAR_CAP: String(1_000_000_000) }; // the copy's real lessons never write a context.lessons row outside the lessons scenario
const TABLES = ["decisions", "decision_outcomes", "notification_outbox", "telegram_command_audit", "runs"];
const COUNT_RE = /^· ([a-z_]+(?:\.[a-z_]+)+) (\d+) — /;
const BIG = 1_000_000_000; // caps no real copy reaches
const STUB_CHAT = "-1003"; // numeric, not a real chat
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES", "HOUGE_LESSON_CHAR_CAP", "HOUGE_LESSON_CAP_PER_SCOPE", "HOUGE_MAX_CONSECUTIVE_CLARIFY", "HOUGE_CHAT_CONTEXT_TURNS", "HOUGE_EMBED_URL"];
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
const entryCount = (path, id) => ro(path, (db) => db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?").get(id).n);
/** The schema as a hash (every object's type, name, sql) plus user_version: a migration changes it. */
const schemaOf = (path) => ro(path, (db) => ({
  uv: db.prepare("PRAGMA user_version").get().user_version,
  hash: createHash("sha256").update(J(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all())).digest("hex").slice(0, 12),
  mig: createHash("sha256").update(J(db.prepare("SELECT * FROM schema_migrations ORDER BY rowid").all())).digest("hex").slice(0, 12), // every schema_migrations row: a migration can add one without touching the schema sql
}));
/** The seeded decision rows, whole, as one hash: a changed or rewritten row differs. */
const rowsHash = (path, ids) => ro(path, (db) => createHash("sha256").update(J(ids.map((id) => db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(id) ?? null))).digest("hex").slice(0, 12));
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
/** The /status count line per new id over (now - 24 h, now], straight from SQL: the line's total must equal it. */
function windowCounts(path, now) {
  const since = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  return ro(path, (db) => Object.fromEntries(NEW_IDS.map((id) => [id, db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ?").get(id, since, now).n])));
}
const lineTotals = (lines) => Object.fromEntries(NEW_IDS.map((id) => [id, lines.filter((l) => COUNT_RE.exec(l)?.[1] === id).map((l) => Number(COUNT_RE.exec(l)[2]))]));
/** The exact count line (digest.ts countLines format) for `id`, built from SQL rung counts over the same window and `now`; null when the window holds no row. */
const RUNG_ORDER = ["rule", "system_one", "model", "paco", "fail"]; const RUNG_LABEL = { rule: "code", system_one: "Jev", model: "model", paco: "you", fail: "fallback" };
function expectedLine(path, id, now) {
  const since = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  const by = ro(path, (db) => db.prepare("SELECT rung, COUNT(*) AS n FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ? GROUP BY rung").all(id, since, now));
  if (by.length === 0) return null;
  const m = new Map(by.map((r) => [r.rung, r.n]));
  const known = RUNG_ORDER.filter((k) => m.has(k)).map((k) => `${RUNG_LABEL[k]} ${m.get(k)}`);
  const other = [...m.keys()].filter((k) => !RUNG_ORDER.includes(k)).sort().map((k) => `${k} ${m.get(k)}`);
  return `· ${id} ${[...m.values()].reduce((a, b) => a + b, 0)} — ${[...known, ...other].join(" · ")}`;
}
// the renderer lists entries alphabetically by id
const expectedLines = (path, now) => [...NEW_IDS].sort().map((id) => expectedLine(path, id, now)).filter((l) => l !== null);
const newLines = (lines) => lines.filter((l) => NEW_IDS.includes(COUNT_RE.exec(l)?.[1]));
const norm = (l) => l.replace(/\b\d\d-\d\d \d\d:\d\d\b/g, "<ts>");
const shortRun = (run_id) => (run_id ? run_id.replace(/^run_/, "").slice(0, 8) : "–"); // status-view.ts shortRun

// ---- step 1: this build writes the rows through its real supervisor path ----
const mkRun = (d, store, n, text) => {
  const r = new d.Gateway(store, { ...d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG }).intake(d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: `rb-r5-actor-${n}` },
    notify: { kind: "telegram", chat_id: STUB_CHAT }, idempotency_key: `rb-r5:${n}`, source_reference: `telegram:update:${n}:message:${n}` }));
  if (!r.ok) throw new Error("rollback: run intake refused");
  return r.run_id;
};
const tel = (over = {}) => ({ admitted: 0, best_admitted: null, best_rejected: null, embedding: true, fts_only: false, ...over });
/** One supervisor over the real dist PlannerSupervisor (fake child, no network) and one turn "hi"; `seed` runs first. Returns the run id. */
async function scenario(ctx, store, n, turnContext, seed) {
  try {
    const seeded = seed?.() ?? {}; // a seed may return the turn-context override it needs (the lessons env)
    const { sup } = fx.mkSupervisor(ctx.dNew, store, { recorder: ctx.dNew.storeRecorder(store), turnContext: { env: NO_CAP, ...turnContext, ...seeded } });
    const id = mkRun(ctx.dNew, store, n, "hi"); sup.submit(fx.req(id, "hi")); await sup.whenIdle();
    return id;
  } finally { await fx.cleanup(); }
}
/** Two over-cap lessons (60 chars each) at a 40-char cap; the per-scope cap is raised to the copy's active count so both reach the renderer (checked from the store). */
function lessonsEnv(store) {
  const ids = fx.seedLessons(store, 2, 60);
  const active = store.db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE status = 'active'").get().n;
  const candidates = store.getActiveLessons("ask", active).map((l) => l.id);
  if (!ids.every((id) => candidates.includes(id))) throw new Error("rollback: the seeded lessons are not candidates");
  return { HOUGE_LESSON_CHAR_CAP: "40", HOUGE_LESSON_CAP_PER_SCOPE: String(active) };
}
/** One clarifying assistant turn dated now: it postdates the earlier scenarios' answers, so this turn's trailing-clarify count is 1 (fixture seedClarify dates it 20 s back). */
function seedClarifyNow(store) {
  store.recordChatTurn({ chat_id: CHAT, run_id: "r0", role: "user", text: "fix the file" });
  store.recordChatTurn({ chat_id: CHAT, run_id: "r0", role: "assistant", text: "Which file do you mean?", intent: "clarify" });
}
/** The digest's clarify rate is clarify / assistant chat turns: the chat turns the scenarios added to F are replayed onto A (store API), so only decisions rows differ between the copies. */
const turnsAdded = (from, mark) => ro(from, (db) => db.prepare("SELECT chat_id, run_id, role, text, intent, created_at FROM chat_turns WHERE rowid > ? ORDER BY rowid").all(mark));
/** The exact chat turns the six scenarios add to F, in order [role, intent, text]: seedLaneRows' planner answer, five answered turns (cu_all, rc_inc, rc_fail, cu_fail, ls), the clarify pair, the cc turn. Anything else is not mirrored silently. */
const EXPECTED_TURNS = [["assistant", null, "planner answer"], ...Array.from({ length: 5 }, () => [["user", null, "hi"], ["assistant", "loop", "answer"]]).flat(),
  ["user", null, "fix the file"], ["assistant", "clarify", "Which file do you mean?"], ["user", null, "hi"], ["assistant", "loop", "answer"]];
const turnShape = (rows) => rows.map((r) => [r.role, r.intent, r.text]);
function mirrorChatTurns(ctx, rows, to) {
  const a = openStore(ctx.dNew, to);
  try { for (const r of rows) a.recordChatTurn({ ...r, intent: r.intent ?? undefined }); } finally { closeStore(a); }
}
async function seedRows(ctx, store) {
  const mark = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
  const runs = {}; let n = 1;
  const embedded = { facts: [{ id: 1, block: "synthetic fact 1" }], pages: [], telemetry: { facts: tel({ admitted: 1, best_admitted: 0.7 }), pages: tel() } };
  const failed = { facts: [], pages: [], telemetry: { facts: tel({ embedding: false }), pages: tel({ embedding: false }) } };
  // First: seedLaneRows' boundary check needs a chat with no later planner answer; every turn below records one.
  runs.cu_all = await scenario(ctx, store, n++, {}, () => fx.seedLaneRows(ctx.dNew, store, CHAT, ["Houge replied: a1", "Houge replied: a2"]));
  runs.rc_inc = await scenario(ctx, store, n++, { retrieve: async () => embedded });
  runs.rc_fail = await scenario(ctx, store, n++, { retrieve: async () => failed });
  const throwing = new Proxy(store, { get: (t, k) => (k === "laneTurnsSince" ? () => { throw new Error("disk"); } : Reflect.get(t, k)) });
  const real = console.error; console.error = () => {}; // the turn context logs the swallowed read failure; the message is not printed
  try { runs.cu_fail = await scenario(ctx, store, n++, { store: throwing }); } finally { console.error = real; }
  runs.ls = await scenario(ctx, store, n++, {}, () => ({ env: lessonsEnv(store) }));
  runs.cc = await scenario(ctx, store, n++, {}, () => seedClarifyNow(store));
  const rows = store.db.prepare("SELECT * FROM decisions WHERE rowid > ? ORDER BY rowid").all(mark).map((r) => ({ ...r }));
  return { rows, runs };
}
async function seedF(ctx, path) {
  const s = openStore(ctx.dNew, path);
  try { return await seedRows(ctx, s); } finally { closeStore(s); }
}

// ---- step 2: the merge base on the copy ----
/** review_ok naming a new id must be refused by the old build's own ENTRY_IDS; a valid id is accepted, so the refusal is about the value. */
function outcomeProbes(store) {
  const decision_id = store.db.prepare(`SELECT decision_id FROM decisions WHERE entry_id NOT IN (${NEW_IDS.map(() => "?").join(",")}) ORDER BY rowid LIMIT 1`).get(...NEW_IDS)?.decision_id;
  if (!decision_id) throw new Error("the copy holds no decision row to attach an outcome to");
  const probe = (value) => {
    try { return `inserted:${store.insertDecisionOutcome({ decision_id, signal: "review_ok", value, source: "code" }).inserted}`; }
    catch (e) { return e?.constructor?.name === "OutcomeRejected" && /^value not allowed for review_ok$/.test(e.message) ? "OutcomeRejected:value not allowed for review_ok" : `error:${errCode(e)}`; }
  };
  return Object.fromEntries([...NEW_IDS, "tool.policy"].map((v) => [v, probe(v)]));
}
async function oldSteps(ctx, path, now) {
  const { dOld, mOld } = ctx;
  const s = openStore(dOld, path); // the old build opens the copy; its migrations ran
  const r = { schemaAfterOpen: schemaOf(path), decisionsOnOpen: s.db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n };
  await yieldLoop();
  r.status = mOld.decisionStatusLines(s, now);
  const dg = mOld.buildDecisionDigest(s, now, { ...process.env, HOUGE_IMPROVE_ENABLED: "false" });
  r.digest = dg && dg.text ? dg.text.split("\n") : null;
  r.listText = mOld.decisionListText(s, process.env).split("\n");
  const all = s.listRecentDecisions(100_000);
  r.listedAll = all.length;
  r.listedNew = all.filter((x) => NEW_IDS.includes(x.entry_id)).length;
  r.read = all.map(canonRow).sort();
  r.readRows = all.map((x) => ({ ...x }));
  r.outcomes = outcomeProbes(s);
  closeStore(s);
  return r;
}

/** Disables every enabled schedule on the copy through the store's own cancelScheduledTask (P7) and parks non-final outbox rows (a poll flush would send them). */
function prepA(dNew, path) {
  const s = openStore(dNew, path);
  try {
    const cancelled = s.listScheduledTasks().filter((t) => t.state === "enabled").filter((t) => s.cancelScheduledTask(t.schedule_id)).length;
    const parked = s.db.prepare("UPDATE notification_outbox SET state = 'failed_terminal' WHERE state NOT IN ('delivered', 'failed_terminal')").run().changes;
    return { cancelled, parked };
  } finally { closeStore(s); }
}

async function setup() {
  if (!DIST.includes("/.worktrees/")) throw new SetupError(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
  if (!arg("--old-dist")) throw new SetupError("usage: --old-dist <merge-base dist> [--old-base-r5 <full sha>] [--live-db <path>]");
  const oldDist = resolve(arg("--old-dist"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  let prov, base;
  try { base = mergeBaseOf(DIST, arg("--old-base-r5")); prov = verifyStampedDist(oldDist, DIST, base, "omp/turn-context.js"); } catch (e) { throw new SetupError(provenanceText(e)); }
  console.log(`old build pinned to base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, stamped dist ${prov.hash.slice(0, 12)}`);
  const root = initTemp(false);
  for (const k of [...SET_PINS, ...DELETE_PINS]) saved[k] = process.env[k];
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "work"), { recursive: true });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID", ...DELETE_PINS]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-rollback/omp", HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_ENABLED: "0", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  for (const k of ["storeOptionsFor", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "storeRecorder", "PlannerSupervisor", "lessonSetFingerprint", "ToolRegistry", "parseModelString", "selectorKey", "resolveOmpConfig"]) if (!dNew[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  if (!dOld.RunStore) throw new SetupError("RunStore missing from the old dist");
  const mods = async (dist) => ({ ...(await import(join(dist, "decisions/digest.js"))), ...(await import(join(dist, "decisions/status-view.js"))) });
  const [mNew, mOld] = [await mods(DIST), await mods(oldDist)];
  const A = join(mkTemp("copy-A"), "houge.sqlite"); const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, A);
  const prep = prepA(dNew, A);
  vacuumInto(A, F); // F is cut from the prepped A, so a daemon write between two live reads cannot separate them
  return { dNew, dOld, mNew, mOld, fx, A, F, root, work: join(root, "work"), prep };
}

/** The recent-list line for a seeded row, as the old build renders it (status-view.ts recentLine). */
const listLine = (r, label) => `<ts> · ${r.entry_id} · ${label(r.rung)} → ${r.verdict} · p ${r.p === null ? "–" : r.p.toFixed(2)} · run ${shortRun(r.run_id)}`;
function renderBad(a, f, seedRows, label) {
  const bad = [];
  if (!a.digest || !f.digest) bad.push("digest did not render");
  else if (!same(a.digest, f.digest)) bad.push(`digest differs (A ${a.digest.length} lines, F ${f.digest.length})`);
  if (f.digest?.some((l) => COUNT_RE.test(l) || NEW_IDS.some((id) => l.includes(id)))) bad.push("digest carries a per-entry line or new id");
  const isNew = (l) => NEW_IDS.includes(COUNT_RE.exec(l)?.[1]);
  const [sa, sf] = [a.status.filter((l) => !isNew(l)), f.status.filter((l) => !isNew(l))];
  if (!same(sa, sf)) bad.push(`/status other lines differ (A ${sa.length}, F ${sf.length})`);
  const [head, ...rows] = a.listText.map(norm);
  const want = [head, ...[...seedRows].reverse().map((r) => listLine(r, label)), ...rows].slice(0, 11);
  if (!same(f.listText.map(norm), want)) bad.push(`recent list differs from A's with the seeded rows on top (F ${f.listText.length - 1} rows)`);
  return bad;
}
const ADDED = { [RC]: 2, [CU]: 2, [LS]: 1, [CC]: 1 }; // rows per id this build writes onto F
const OUT_REJ = "OutcomeRejected:value not allowed for review_ok";
/** P5: the six rows, exact, in the order they are written. [entry_id, verdict, reason_code, stage, the consulting run's label, rung, entry_version] */
const EXPECTED = [[CU, "inject", "all", "pre_model", "cu_all", "rule", 1], [RC, "include", "embedded", "pre_model", "rc_inc", "rule", 1], [RC, "none", "embed_failed", "pre_model", "rc_fail", "rule", 1],
  [CU, "none", "read_failed", "pre_model", "cu_fail", "rule", 1], [LS, "capped", "char_cap", "pre_model", "ls", "rule", 1], [CC, "cap", "cap_reached", "pre_model", "cc", "rule", 1]];
const shapeOf = (runs) => (r) => [r.entry_id, r.verdict, r.reason_code, r.stage, Object.entries(runs).find(([, id]) => id === r.run_id)?.[0] ?? "?", r.rung, r.entry_version];
async function run(ctx) {
  const { A, F, mNew, mOld } = ctx;
  phase = "snapshot"; const before = { n: NEW_IDS.map((id) => entryCount(F, id)), schema: schemaOf(F), counts: counts(F) };
  const chatMark = ro(F, (db) => db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM chat_turns").get().m);
  phase = "seed F"; const seed = await seedF(ctx, F);
  const addedTurns = turnsAdded(F, chatMark);
  check("the chat turns the scenarios added to F are exactly the expected ones (15: the planner answer, five answered turns, the clarify pair, the cc turn; no extra clarify or assistant turn), checked before they are mirrored onto A",
    same(turnShape(addedTurns), EXPECTED_TURNS) && addedTurns.every((r) => r.chat_id === CHAT), `added ${addedTurns.length} (want ${EXPECTED_TURNS.length}) · clarify ${addedTurns.filter((r) => r.intent === "clarify").length} (want 1)`);
  mirrorChatTurns(ctx, addedTurns, A);
  const seedIds = seed.rows.map((r) => r.decision_id);
  const snapF = { counts: counts(F), keys: keysOf(F), schema: schemaOf(F), hash: rowsHash(F, seedIds), content: contentOf(F) };
  const snapA = { counts: counts(A), keys: keysOf(A), schema: schemaOf(A), content: contentOf(A) };
  const rowShape = shapeOf(seed.runs); const got = seed.rows.map(rowShape);
  check("this build wrote exactly the six expected rows through the real supervisor path: context.recall include/embedded and none/embed_failed, context.catch_up none/read_failed and inject/all, context.lessons capped/char_cap, turn.clarify_cap cap/cap_reached (rung rule, version 1, each with its consulting run's id, tool_call_id null), and nothing else",
    same(got, EXPECTED) && seed.rows.every((r) => r.tool_call_id === null && r.run_id !== null) && NEW_IDS.every((id, i) => entryCount(F, id) === before.n[i] + ADDED[id])
    && snapF.counts.decisions === snapA.counts.decisions + 6,
    `rows ${seed.rows.map((r) => `${r.entry_id}/${r.verdict}/${r.reason_code}/${r.stage}/${rowShape(r)[4]}/${r.rung}/v${r.entry_version}`).join(" ")} · decisions A ${snapA.counts.decisions} F ${snapF.counts.decisions} · outbox parked on A ${ctx.prep.parked}`);
  await yieldLoop();
  const now = new Date(Date.now() + 60_000).toISOString();
  phase = "old build on A"; const oa = await oldSteps(ctx, A, now);
  await yieldLoop();
  phase = "old build on F"; const of = await oldSteps(ctx, F, now);
  check("the old build opened both copies and every step (/status, digest, /status decisions, list, review_ok) completed without throwing", true);
  phase = "compare";
  const [aA, aF, schA, schF] = [counts(A), counts(F), schemaOf(A), schemaOf(F)];
  check("the old build ran no migration: the schema (every object's sql and user_version and every schema_migrations row) is identical before and after its open, on A and F, and A equals F",
    same(snapA.schema, oa.schemaAfterOpen) && same(snapF.schema, of.schemaAfterOpen) && same(snapA.schema, schA) && same(snapF.schema, schF) && same(snapA.schema, snapF.schema) && same(before.schema, snapF.schema),
    `${snapF.schema.hash} migrations ${snapF.schema.mig} uv ${snapF.schema.uv} -> A ${schA.hash} / F ${schF.hash}`);
  const keysF = keysOf(F); const gone = lost(snapF.keys, keysF); const goneA = lost(snapA.keys, keysOf(A));
  const hashAfter = rowsHash(F, seedIds); const contentF = contentOf(F); const contentA = contentOf(A);
  const seededRead = seedIds.map((id) => of.readRows.find((x) => x.decision_id === id));
  const seededOk = seededRead.every((x) => x) && same(seededRead.map(rowShape), EXPECTED) && seededRead.every((x, i) => x.run_id === seed.rows[i].run_id);
  check("every decisions row is intact after the old build, on A and F: the count is exactly the same before and after, no key lost, every row's full content equal to SQL before it opened (as SQL after, and as the old build read it), the six seeded rows read with their exact entry_id, verdict, reason_code, stage and run_id, and its list reads every row",
    aF.decisions === snapF.counts.decisions && aA.decisions === snapA.counts.decisions && snapF.counts.decisions === snapA.counts.decisions + 6 && [...gone, ...goneA].every((n) => n === 0) && hashAfter === snapF.hash
    && same(contentF, snapF.content) && same(contentA, snapA.content) && same(of.read, [...snapF.content].sort()) && same(oa.read, [...snapA.content].sort()) && seededOk
    && of.listedAll === aF.decisions && oa.listedAll === aA.decisions && of.listedNew === seed.rows.length + before.n.reduce((a, b) => a + b, 0),
    `decisions A ${snapA.counts.decisions} -> ${aA.decisions}, F ${snapF.counts.decisions} -> ${aF.decisions} · keys lost ${[...gone, ...goneA].reduce((a, b) => a + b, 0)} · rows compared whole ${snapF.content.length + snapA.content.length} · old build read ${of.read.length}/${oa.read.length} · seeded rows read ${seededRead.filter(Boolean).length}/6 exact ${seededOk} · new ids listed ${of.listedNew} on F`);
  const bad = renderBad(oa, of, seed.rows, mOld.deciderLabel);
  const [winA, winF] = [windowCounts(A, now), windowCounts(F, now)];
  const [expLinesA, expLinesF] = [expectedLines(A, now), expectedLines(F, now)];
  check("A vs F as rendered by the old build: the digest is identical (no per-entry lines, no new id), /status differs only in the four R5 count lines (each whole line, rung breakdown included, equals the line built from SQL rung counts over the same window; +2, +2, +1, +1 over A), recent list = A's with the six seeded rows on top",
    bad.length === 0 && same(newLines(oa.status), expLinesA) && same(newLines(of.status), expLinesF) && expLinesF.length === 4 && NEW_IDS.every((id) => winF[id] === winA[id] + ADDED[id]),
    bad.length ? bad.join("; ") : `F lines [${newLines(of.status).join(" | ")}] = SQL-built · A lines [${newLines(oa.status).join(" | ")}] · digest ${of.digest.length} raw lines (A ${oa.digest.length}) identical, same now · list ${of.listText.length - 1} rows`);
  check("the old build refuses review_ok naming each of the four R5 ids (normal OutcomeRejected, no crash; a valid id is accepted) on A and F",
    [oa, of].every((x) => NEW_IDS.every((id) => x.outcomes[id] === OUT_REJ) && x.outcomes["tool.policy"] === "inserted:true") && same(oa.outcomes, of.outcomes), `A ${J(oa.outcomes)} · F ${J(of.outcomes)}`.replace(/"/g, ""));
  const grew = (x, y) => TABLES.map((t) => y[t] - x[t]);
  check("the old build wrote the same rows to A and F: only decision_outcomes grew, by exactly 1 (its valid-id probe)",
    same(grew(snapA.counts, aA), grew(snapF.counts, aF)) && TABLES.every((t, i) => grew(snapF.counts, aF)[i] === (t === "decision_outcomes" ? 1 : 0)), `growth ${TABLES.map((t, i) => `${t} ${grew(snapA.counts, aA)[i]}/${grew(snapF.counts, aF)[i]}`).join(" · ")} (A/F)`);
  phase = "reopen F"; const s = openStore(ctx.dNew, F);
  const re = mNew.decisionStatusLines(s, now);
  const reRows = s.listRecentDecisions(100_000).map(canonRow).sort();
  closeStore(s);
  check("this build reopens F: every decisions row's full content is unchanged, nothing lost, and the four R5 /status lines equal the SQL counts",
    same(contentOf(F), snapF.content) && same(reRows, [...snapF.content].sort()) && lost(keysF, keysOf(F)).every((n) => n === 0) && same(newLines(re), expectedLines(F, now)),
    `rows read ${reRows.length}/${snapF.content.length} · lines ${J(lineTotals(re)).replace(/"/g, "")}`);
  const tomb = [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
  check("no houge.kill tombstone appeared in the cwd or the main checkout (P3)", tomb === 0, `found ${tomb} (want 0)`);
}

function restoreEnv() { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } delete process.env.HOUGE_OMP_BIN; }
// PlannerSupervisor.shutdown can wait ~5 s on a draining turn before it stops the session (src/omp/planner-supervisor.ts:461); the bound covers that plus margin.
const SETTLE_BOUND_MS = 15_000;
/** Every exit path: handles closed, the fixture's /tmp/hsv-* workdirs removed (fx.cleanup), the copies removed, env restored. */
function onSignal(code) {
  for (const h of handles.splice(0)) closeStore(h);
  Promise.race([fx.cleanupSettled().catch(() => undefined), new Promise((r) => setTimeout(r, SETTLE_BOUND_MS))]).finally(() => { fx.removeDataDirsSync(); cleanupTemp(); restoreEnv(); process.exit(code); });
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
    console.error("setup_failed");
    process.exitCode = 2;
  } finally {
    for (const h of handles.splice(0)) closeStore(h);
    await fx.cleanupSettled().catch(() => undefined);
    await runClosers();
    cleanupTemp();
    restoreEnv();
    if (root) console.error(`# temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
