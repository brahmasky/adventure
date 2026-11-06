#!/usr/bin/env node
// Rollback check — decision ladder remainder R2, intake.sender + turn.contract (spec 2026-11-01 R2 §7; plan Task 10).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/check-ladder-remainder-r2-rollback.mjs \
//     --old-dist <main checkout>/.worktrees/base-ef4d0d1/dist [--old-base-r2 <full sha>] [--live-db <path>]
// --old-base-r2 <full sha>: the base the old build is pinned to (ef4d0d10fbcbe3077e10a28979891f0abd256b2f). Optional only while the merge base of HEAD and
// main IS that commit; on the branch (cut from the plan commit) and after the merge it is required. Provenance file: gateway/gateway.js.
// R2 adds record-only decision rows (no migration, no table): `intake.sender` (stage intake, run_id null) and `turn.contract` (stage pre_model):
// `restrict` (a schedule-born turn, with its run) and `refuse` (run_id null). Two VACUUM copies as in R1: A (never seeded) and F (cut from A, then
// seeded by this build through its real paths: runTelegramPollOnce with a recording stub client for the sender row; maybeFireScheduledTasks and
// Gateway.intake for the contract rows). Prep on A before the cut (so A and F differ only by what the seed writes): the copy's non-final outbox rows
// are parked and its enabled schedules cancelled through the store's own cancelScheduledTask (P7). The old build then opens both copies; everything
// it renders (/status, digest, /status decisions list) is compared A against F; its ENTRY_IDS-validated writer (review_ok) must refuse each new id
// normally; this build then reopens F.
// Exit 0 PASS · 1 FAIL · 2 setup error. The live DB is read only by VACUUM INTO; every write goes to a copy under /tmp/hg-s4d-*, removed on every exit
// path (pass, FAIL, throw, SIGINT, SIGTERM, SIGHUP). Pins set before any store opens and restored on exit: HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under
// the temp root (P3), HOUGE_TELEGRAM_CHAT_ID = a stub chat (P4); scheduler/radar/media flags deleted. Nothing is sent anywhere (the Telegram client is a
// recording stub). Only line names, entry ids, counts, verdicts and codes from closed sets are printed.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyStampedDist } from "./old-dist-provenance.mjs";
import { intakeEvent } from "./stage4-intake-fixture.mjs";
import { CHAT, PACO, STRANGER, senderUpdate } from "./stage4-sender-fixture.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const NEW_IDS = ["intake.sender", "turn.contract"];
const TABLES = ["decisions", "decision_outcomes", "notification_outbox", "telegram_command_audit", "runs"];
const COUNT_RE = /^· ([a-z_]+(?:\.[a-z_]+)+) (\d+) — /;
const BIG = 1_000_000_000; // caps no real copy reaches
const STUB_CHAT = "rollback-stub-chat";
const ALLOWLIST = { users: [{ telegram_user_id: PACO, identity_id: "paco" }], chats: [{ telegram_chat_id: CHAT, label: "synthetic", allowed_identity_ids: ["paco"] }] };
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES"];
const failures = [];
const saved = {};
const J = (o) => JSON.stringify(o);
const same = (a, b) => J(a) === J(b);
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const handles = [];
const yieldLoop = () => new Promise((r) => setImmediate(r)); // lets a SIGINT/SIGTERM handler run during an otherwise synchronous run
const wall = () => new Date().toISOString();

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
const totalsMatch = (lines, want) => { const got = lineTotals(lines); return NEW_IDS.every((id) => (want[id] === 0 ? got[id].length === 0 : got[id].length === 1 && got[id][0] === want[id])); };
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
const expectedLines = (path, now) => NEW_IDS.map((id) => expectedLine(path, id, now)).filter((l) => l !== null);
const newLines = (lines) => lines.filter((l) => NEW_IDS.includes(COUNT_RE.exec(l)?.[1]));
const norm = (l) => l.replace(/\b\d\d-\d\d \d\d:\d\d\b/g, "<ts>");
const shortRun = (run_id) => (run_id ? run_id.replace(/^run_/, "").slice(0, 8) : "–"); // status-view.ts shortRun

// ---- step 1: this build writes the three rows through its real paths ----
const gateway = (d, store) => new d.Gateway(store, { ...d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG });
/** A fresh update id above the copy's offset. */
const nextId = (store) => store.getOffset("telegram") + 1000;
const STUB_WORKER = { submitTurn: () => true, executeRun: async () => ({ status: "queued" }) };
async function seedRows(ctx, store) {
  const { dNew } = ctx;
  const mark = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
  // 1. intake.sender: a stranger's message through the production poll cycle, stub client (no network).
  const sent = [];
  const updates = [senderUpdate("message", { id: nextId(store), from: STRANGER })];
  await dNew.runTelegramPollOnce({ store, projectRoot: ctx.work, omp: { dataDir: ctx.work, distDir: DIST }, allowlist: ALLOWLIST,
    telegramClient: { getUpdates: async () => structuredClone(updates), sendMessage: async ({ chat_id }) => { sent.push(String(chat_id)); return { message_id: 1 }; } } });
  // 2. turn.contract restrict: a due schedule fired through maybeFireScheduledTasks (pre-existing schedules were cancelled on A before the cut).
  const sch = store.addScheduledTask({ chat_id: "rb-r2-sched", goal: "synthetic", spec_json: '{"kind":"daily","at":"08:00"}', tz: "UTC", next_run_at: new Date(Date.now() - 60_000).toISOString(), created_by: "rb-r2" });
  const { maybeFireScheduledTasks } = await import(join(DIST, "run/schedule-tick.js"));
  const fire = await maybeFireScheduledTasks({ store, gateway: gateway(dNew, store), worker: STUB_WORKER, now: wall(), env: { HOUGE_SCHEDULER_ENABLED: "true", HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT } });
  const run = store.db.prepare("SELECT run_id FROM runs WHERE source = 'schedule' AND json_extract(requested_by_json, '$.id') = ?").all(sch.schedule_id);
  // 3. turn.contract refuse: /run with an unknown program.
  const bad = gateway(dNew, store).intake(intakeEvent(dNew, { chat: "rb-r2-chat-3", actor: "rb-r2-actor-3" }, { type: "run", goal: "x", key: "rb-nosuch", extra: { program: "nosuch" } }), wall());
  const rows = store.db.prepare("SELECT * FROM decisions WHERE rowid > ? ORDER BY rowid").all(mark).map((r) => ({ ...r }));
  return { rows, runId: run.length === 1 ? run[0].run_id : null, results: { sent: sent.length, fired: fire.fired, runs: run.length, refused: bad.ok ? "ok" : bad.error?.code } };
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
  if (!arg("--old-dist")) throw new SetupError("usage: --old-dist <merge-base dist> [--old-base-r2 <full sha>] [--live-db <path>]");
  const oldDist = resolve(arg("--old-dist"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  let prov, base;
  try { base = mergeBaseOf(DIST, arg("--old-base-r2")); prov = verifyStampedDist(oldDist, DIST, base, "gateway/gateway.js"); } catch (e) { throw new SetupError(provenanceText(e)); }
  console.log(`old build pinned to base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, stamped dist ${prov.hash.slice(0, 12)}`);
  const root = initTemp(false);
  for (const k of [...SET_PINS, ...DELETE_PINS]) saved[k] = process.env[k];
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "work"), { recursive: true });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID", ...DELETE_PINS]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-rollback/omp", HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_ENABLED: "0", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  for (const k of ["storeOptionsFor", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "runTelegramPollOnce"]) if (!dNew[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  if (!dOld.RunStore) throw new SetupError("RunStore missing from the old dist");
  const mods = async (dist) => ({ ...(await import(join(dist, "decisions/digest.js"))), ...(await import(join(dist, "decisions/status-view.js"))) });
  const [mNew, mOld] = [await mods(DIST), await mods(oldDist)];
  const A = join(mkTemp("copy-A"), "houge.sqlite"); const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, A);
  const prep = prepA(dNew, A);
  vacuumInto(A, F); // F is cut from the prepped A, so a daemon write between two live reads cannot separate them
  return { dNew, dOld, mNew, mOld, A, F, root, work: join(root, "work"), prep };
}

/** The recent-list line for a seeded row, as the old build renders it (status-view.ts recentLine). */
const listLine = (r, label) => `<ts> · ${r.entry_id} · ${label(r.rung)} → ${r.verdict} · p ${r.p === null ? "–" : r.p.toFixed(2)} · run ${shortRun(r.run_id)}`;
function renderBad(a, f, seedRows, label) {
  const bad = [];
  if (!a.digest || !f.digest) bad.push("digest did not render");
  else if (!same(a.digest, f.digest)) bad.push(`digest differs (A ${a.digest.length} lines, F ${f.digest.length})`);
  if (f.digest?.some((l) => COUNT_RE.test(l) || NEW_IDS.some((id) => l.includes(id)))) bad.push("digest carries a per-entry line or new id");
  const isNew = (l) => NEW_IDS.includes(COUNT_RE.exec(l)?.[1]);
  const [sa, sf] = [a.status.filter((l) => !isNew(l)).map(norm), f.status.filter((l) => !isNew(l)).map(norm)];
  if (!same(sa, sf)) bad.push(`/status other lines differ (A ${sa.length}, F ${sf.length})`);
  const [head, ...rows] = a.listText.map(norm);
  const want = [head, ...[...seedRows].reverse().map((r) => listLine(r, label)), ...rows].slice(0, 11);
  if (!same(f.listText.map(norm), want)) bad.push(`recent list differs from A's with the seeded rows on top (F ${f.listText.length - 1} rows)`);
  return bad;
}
const OUT_REJ = "OutcomeRejected:value not allowed for review_ok";
/** P8: the three rows, exact. [entry_id, verdict, reason_code, stage, run_id null?] */
const EXPECTED = [["intake.sender", "deny", "user_not_allowlisted", "intake", true], ["turn.contract", "restrict", "schedule_born", "pre_model", false], ["turn.contract", "refuse", "unknown_program", "pre_model", true]];
const rowShape = (r) => [r.entry_id, r.verdict, r.reason_code, r.stage, r.run_id === null];
async function run(ctx) {
  const { A, F, mNew, mOld } = ctx;
  phase = "snapshot"; const before = { n: NEW_IDS.map((id) => entryCount(F, id)), schema: schemaOf(F), counts: counts(F) };
  phase = "seed F"; const seed = await seedF(ctx, F);
  const seedIds = seed.rows.map((r) => r.decision_id);
  const snapF = { counts: counts(F), keys: keysOf(F), schema: schemaOf(F), hash: rowsHash(F, seedIds), content: contentOf(F) };
  const snapA = { counts: counts(A), keys: keysOf(A), schema: schemaOf(A), content: contentOf(A) };
  const got = seed.rows.map(rowShape);
  const restrict = seed.rows[1];
  check("this build wrote exactly the three expected rows through its real paths: intake.sender deny/user_not_allowlisted (intake, run_id null), turn.contract restrict/schedule_born (pre_model, with the scheduled run's id), turn.contract refuse/unknown_program (pre_model, run_id null), tool_call_id null on all, and nothing else",
    same(got, EXPECTED) && seed.rows.every((r) => r.tool_call_id === null) && restrict?.run_id !== undefined && restrict.run_id === seed.runId
    && entryCount(F, "intake.sender") === before.n[0] + 1 && entryCount(F, "turn.contract") === before.n[1] + 2
    && snapF.counts.decisions === snapA.counts.decisions + 3 && seed.results.sent === 0 && seed.results.fired === 1 && seed.results.runs === 1 && seed.results.refused === "TASK_CONTRACT_INVALID",
    `rows ${seed.rows.map((r) => `${r.entry_id}/${r.verdict}/${r.reason_code}/${r.stage}/${r.run_id === null ? "null" : "run"}`).join(" ")} · results ${J(seed.results).replace(/"/g, "")} · decisions A ${snapA.counts.decisions} F ${snapF.counts.decisions} · prep: schedules cancelled ${ctx.prep.cancelled}, outbox parked ${ctx.prep.parked}`);
  await yieldLoop();
  const now = new Date(Date.now() + 60_000).toISOString();
  phase = "old build on A"; const oa = await oldSteps(ctx, A, now);
  await yieldLoop();
  phase = "old build on F"; const of = await oldSteps(ctx, F, now);
  check("ef4d0d1 opened both copies and every step (/status, digest, /status decisions, list, review_ok) completed without throwing", true);
  phase = "compare";
  const [aA, aF, schA, schF] = [counts(A), counts(F), schemaOf(A), schemaOf(F)];
  check("ef4d0d1 ran no migration: the schema (every object's sql and user_version) is identical before and after its open, on A and F, and A equals F",
    same(snapA.schema, oa.schemaAfterOpen) && same(snapF.schema, of.schemaAfterOpen) && same(snapA.schema, schA) && same(snapF.schema, schF) && same(snapA.schema, snapF.schema) && same(before.schema, snapF.schema),
    `${snapF.schema.hash} uv ${snapF.schema.uv} -> A ${schA.hash} / F ${schF.hash}`);
  const keysF = keysOf(F); const gone = lost(snapF.keys, keysF); const goneA = lost(snapA.keys, keysOf(A));
  const hashAfter = rowsHash(F, seedIds); const contentF = contentOf(F); const contentA = contentOf(A);
  const seededRead = seedIds.map((id) => of.readRows.find((x) => x.decision_id === id));
  const seededOk = seededRead.every((x) => x) && same(seededRead.map(rowShape), EXPECTED) && seededRead[1].run_id === seed.runId;
  check("every decisions row is intact after ef4d0d1, on A and F: the count is exactly the same before and after, no key lost, every row's full content equal to SQL before it opened (as SQL after, and as the old build read it), the three seeded rows read with their exact entry_id, verdict, reason_code, stage and run_id, and its list reads every row",
    aF.decisions === snapF.counts.decisions && aA.decisions === snapA.counts.decisions && snapF.counts.decisions === snapA.counts.decisions + 3 && [...gone, ...goneA].every((n) => n === 0) && hashAfter === snapF.hash
    && same(contentF, snapF.content) && same(contentA, snapA.content) && same(of.read, [...snapF.content].sort()) && same(oa.read, [...snapA.content].sort()) && seededOk
    && of.listedAll === aF.decisions && oa.listedAll === aA.decisions && of.listedNew === seed.rows.length + before.n.reduce((a, b) => a + b, 0),
    `decisions A ${snapA.counts.decisions} -> ${aA.decisions}, F ${snapF.counts.decisions} -> ${aF.decisions} · keys lost ${[...gone, ...goneA].reduce((a, b) => a + b, 0)} · rows compared whole ${snapF.content.length + snapA.content.length} · old build read ${of.read.length}/${oa.read.length} · seeded rows read ${seededRead.filter(Boolean).length}/3 exact ${seededOk} · new ids listed ${of.listedNew} on F`);
  const bad = renderBad(oa, of, seed.rows, mOld.deciderLabel);
  const [winA, winF] = [windowCounts(A, now), windowCounts(F, now)];
  const [expLinesA, expLinesF] = [expectedLines(A, now), expectedLines(F, now)];
  check("A vs F as rendered by ef4d0d1: the digest is identical (no per-entry lines, no new id), /status differs only in the intake.sender and turn.contract count lines (each whole line, rung breakdown included, equals the line built from SQL rung counts over the same window; +1 and +2 over A), recent list = A's with the three seeded rows on top",
    bad.length === 0 && same(newLines(oa.status), expLinesA) && same(newLines(of.status), expLinesF) && expLinesF.length === 2 && winF["intake.sender"] === winA["intake.sender"] + 1 && winF["turn.contract"] === winA["turn.contract"] + 2,
    bad.length ? bad.join("; ") : `F lines [${newLines(of.status).join(" | ")}] = SQL-built · A lines [${newLines(oa.status).join(" | ")}] · digest ${of.digest.length} raw lines (A ${oa.digest.length}) identical, same now · list ${of.listText.length - 1} rows`);
  check("ef4d0d1 refuses review_ok naming intake.sender and turn.contract (normal OutcomeRejected, no crash; a valid id is accepted) on A and F",
    [oa, of].every((x) => NEW_IDS.every((id) => x.outcomes[id] === OUT_REJ) && x.outcomes["tool.policy"] === "inserted:true") && same(oa.outcomes, of.outcomes), `A ${J(oa.outcomes)} · F ${J(of.outcomes)}`.replace(/"/g, ""));
  const grew = (x, y) => TABLES.map((t) => y[t] - x[t]);
  check("ef4d0d1 wrote the same rows to A and F: only decision_outcomes grew, by exactly 1 (its valid-id probe)",
    same(grew(snapA.counts, aA), grew(snapF.counts, aF)) && TABLES.every((t, i) => grew(snapF.counts, aF)[i] === (t === "decision_outcomes" ? 1 : 0)), `growth ${TABLES.map((t, i) => `${t} ${grew(snapA.counts, aA)[i]}/${grew(snapF.counts, aF)[i]}`).join(" · ")} (A/F)`);
  phase = "reopen F"; const s = openStore(ctx.dNew, F);
  const re = mNew.decisionStatusLines(s, now);
  const reRows = s.listRecentDecisions(100_000).map(canonRow).sort();
  closeStore(s);
  check("this build reopens F: every decisions row's full content is unchanged, nothing lost, and the intake.sender and turn.contract /status lines equal the SQL counts",
    same(contentOf(F), snapF.content) && same(reRows, [...snapF.content].sort()) && lost(keysF, keysOf(F)).every((n) => n === 0) && same(newLines(re), expectedLines(F, now)),
    `rows read ${reRows.length}/${snapF.content.length} · lines ${J(lineTotals(re)).replace(/"/g, "")}`);
  const tomb = [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
  check("no houge.kill tombstone appeared in the cwd or the main checkout (P3)", tomb === 0, `found ${tomb} (want 0)`);
}

function restoreEnv() { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } delete process.env.HOUGE_OMP_BIN; }
function onSignal(code) { for (const h of handles.splice(0)) closeStore(h); cleanupTemp(); restoreEnv(); process.exit(code); }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => onSignal(code));

export async function main() {
  let root;
  try {
    const ctx = await setup(); root = ctx.root;
    try { await run(ctx); } catch (e) { check(`run — unexpected error at ${phase}: ${errCode(e)}`, false); }
    console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(`setup error: ${e instanceof SetupError ? e.message.split("\n")[0] : `withheld (${errCode(e)})`}`);
    process.exitCode = 2;
  } finally {
    for (const h of handles.splice(0)) closeStore(h);
    await runClosers();
    cleanupTemp();
    restoreEnv();
    if (root) console.error(`# temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
