#!/usr/bin/env node
// Rollback check — decision ladder remainder R6, lookup.rewrite + lookup.thin + turn.model (spec 2026-11-03 R6 §8; plan Task 7).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=<main checkout>/.env node scripts/check-ladder-remainder-r6-rollback.mjs \
//     --old-dist <main checkout>/.worktrees/base-<12-char sha>/dist [--old-base-r6 <full sha>] [--live-db <path>]
// --old-base-r6 <full sha>: only after the merge (the merge base is then this build's own HEAD); on the branch the merge base is discovered (P1).
// Provenance file: omp/planner-supervisor.js.
// R6 adds record-only decision rows (no migration, no table): lookup.rewrite rewrite/rewritten and bare/late, lookup.thin fetch/thin and none/answered (both written by this
// build's real runLookupLane over CoreWorker.lookupLaneDepsForTest with scripted network deps), turn.model fallback/refused and none/no_leg (written through the real dist
// PlannerSupervisor on a fake child, scripts/stage4-supervisor-fixture.mjs, setModel refusals by this dist's PlannerRpcError), each with the consulting run's id.
// The lane's tool.wall / reader.family rows are rows of ids the merge base already knows; they are removed from F (asserted to be exactly those ids) so the A-vs-F comparison isolates the three new ids.
// Two VACUUM copies: A (never seeded) and F (cut from A, then seeded by this build). Prep on A before the cut: non-final outbox rows parked. The old build then opens both copies;
// everything it renders (/status decisions lines, digest, /status decisions list) is compared A against F; its ENTRY_IDS-validated writer (review_ok) must refuse each new id
// normally; this build then reopens F. Exit 0 PASS · 1 FAIL · 2 setup error. The live DB is read only by VACUUM INTO; every write goes to a copy under /tmp/hg-s4d-*, removed
// on every exit path (pass, FAIL, throw, SIGINT, SIGTERM, SIGHUP, SIGQUIT, uncaught exception). Pins set before any store opens and restored on exit: HOUGE_TOMBSTONE_PATH /
// HOUGE_DISARM_PATH under the temp root (P2), HOUGE_TELEGRAM_CHAT_ID = -1003 (P3); scheduler/radar/media flags deleted. No omp, no Telegram client. Only line names, entry ids,
// counts, verdicts and codes from closed sets are printed; never an error_ref, message or stack. Synthetic text only.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyStampedDist } from "./old-dist-provenance.mjs";
import * as fx from "./stage4-supervisor-fixture.mjs";
import { MAIN_CHECKOUT } from "./main-checkout.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const RW = "lookup.rewrite"; const TH = "lookup.thin"; const TM = "turn.model";
const NEW_IDS = [RW, TH, TM];
const LANE_OLD_IDS = new Set(["tool.wall", "reader.family"]); // rows of ids the merge base knows, written by the same lane drives
const CATALOG_FIXTURE = resolve(new URL("../tests/fixtures/omp-models.json", import.meta.url).pathname);
const CHAT = "42"; // the fixture supervisor's chat
const TABLES = ["decisions", "decision_outcomes", "notification_outbox", "telegram_command_audit", "runs"];
const COUNT_RE = /^· ([a-z_]+(?:\.[a-z_]+)+) (\d+) — /;
const BIG = 1_000_000_000; // caps no real copy reaches
const STUB_CHAT = "-1003"; // numeric, not a real chat
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
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

// ---- step 1: this build writes the rows through its real lane and supervisor paths ----
const mkRun = (d, store, n, text) => {
  const r = new d.Gateway(store, { ...d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG }).intake(d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: `rb-r6-actor-${n}` },
    notify: { kind: "telegram", chat_id: STUB_CHAT }, idempotency_key: `rb-r6:${n}`, source_reference: `telegram:update:${n}:message:${n}` }));
  if (!r.ok) throw new Error("rollback: run intake refused");
  return r.run_id;
};
const COMPOSE_RESERVE_MS = 15_000; // lookup-lane.ts COMPOSE_RESERVE_MS
const LATE_BOUND_MS = 40; // the rewrite's real-time bound in the late drive (now() is frozen, so deadlineAt - reserve - now() is exactly this)
const HIT = { title: "Synthetic forecast", url: "https://example.test/forecast", content: "Tomorrow: sunny, max 22." };
const readOf = (answer) => ({ ok: true, extraction: { summary: "Synthetic summary", facts: ["Sunny, max 22C"], time_claims: [], answer_to_objective: answer, contains_instructions: false },
  digest: `[external source — untrusted-derived summary]\nsummary: Synthetic ${answer ?? "thin"}` });
const SHORT = "check again"; // <= 40 code points: with a recent Paco line, the filter wants a rewrite
const answers = (text) => async () => ({ ok: true, provider: "kimi-code", model: "k3", answer: text });
const later = (ms, text) => () => new Promise((r) => setTimeout(() => r({ ok: true, provider: "kimi-code", model: "k3", answer: text }), ms));
/** One lookup lane through this build's runLookupLane over CoreWorker.lookupLaneDepsForTest (production previousTelegramTurns, ledger, recorder); every network and model dep scripted. */
async function laneDrive(ctx, store, worker, n, o) {
  const run = mkRun(ctx.dNew, store, n, o.text);
  const t0 = Date.now();
  const state = { threadCutAt: new Date(t0).toISOString(), turnCtx: { sourceUrls: [] }, anchor: { priorAnswer: "", defaultScope: "chat" } };
  const reads = [...o.reads]; const calls = { searches: [], fetches: [] };
  const d = { ...worker.lookupLaneDepsForTest(run, STUB_CHAT, state), now: () => t0, systemPrompt: () => "SYSTEM", retrieve: async () => ({ facts: [], pages: [] }),
    rewrite: o.rewrite,
    search: async (x) => { calls.searches.push(x.query); return { ok: true, output: { query: x.query, provider: "tavily", results: [HIT] } }; },
    fetch: async (x) => { calls.fetches.push(x.url); return { ok: true, output: { url: x.url, status: 200, bytes: 512, content: "page text" } }; },
    read: async () => readOf(reads.length > 0 ? reads.shift() : "Sunny, 22C"),
    compose: async () => ({ ok: true, provider: "anthropic", model: "claude-sonnet-5-5", answer: "Sunny tomorrow [1]." }) };
  const input = { run_id: run, chat_id: STUB_CHAT, userText: o.text, recentTurns: [], turnChars: 400, quoted: null, effort: "low", verdict_id: "jv_1", note: null,
    signal: new AbortController().signal, deadlineAt: t0 + COMPOSE_RESERVE_MS + (o.late ? LATE_BOUND_MS : 60_000) };
  const result = await ctx.dNew.runLookupLane(input, d);
  return { run, result, calls };
}
const LISTS_2 = { default: ["anthropic/claude-opus-5-5:medium", "anthropic/claude-sonnet-5-5:medium"], fast: ["anthropic/claude-sonnet-5-5:low"], thinking: [] };
const LISTS_1 = { default: ["anthropic/claude-opus-5-5:medium"], fast: [], thinking: [] };
/** One supervisor turn "hi" over the real dist PlannerSupervisor on a fake child whose set_model refuses every key `refuse` accepts (this dist's PlannerRpcError). */
async function pinTurn(ctx, store, n, lists, refuse) {
  try {
    const session = fx.fakeSession({ setModel: async (_m, k) => { if (refuse(k)) throw fx.modelRefusal(ctx.dNew, k); } });
    const { sup, outcome } = fx.mkSupervisor(ctx.dNew, store, { recorder: ctx.dNew.storeRecorder(store), session, lists });
    const id = mkRun(ctx.dNew, store, n, "hi"); sup.submit(fx.req(id, "hi")); await sup.whenIdle();
    return { id, targets: session.models.slice(), done: outcome.done.length, failed: outcome.failed.length };
  } finally { await fx.cleanup(); }
}
/** The digest's clarify rate is clarify / assistant chat turns: the chat turns the drives added to F are replayed onto A (store API), so only decisions rows differ between the copies. */
const turnsAdded = (from, mark) => ro(from, (db) => db.prepare("SELECT chat_id, run_id, role, text, intent, created_at FROM chat_turns WHERE rowid > ? ORDER BY rowid").all(mark));
const turnShape = (rows) => rows.map((r) => [r.role, r.intent, r.text]);
function mirrorChatTurns(ctx, rows, to) {
  const a = openStore(ctx.dNew, to);
  try { for (const r of rows) a.recordChatTurn({ ...r, intent: r.intent ?? undefined }); } finally { closeStore(a); }
}
async function seedRows(ctx, store) {
  const mark = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
  const runs = {}; const facts = {}; let n = 1;
  const roles = new ctx.RR({ store, env: () => ({}), readCatalog: async () => ctx.catalog }); await roles.refreshCatalog();
  const work = join(ctx.work, "lane"); mkdirSync(work, { recursive: true });
  const worker = new ctx.dNew.CoreWorker(store, join(work, "project"), async () => ({ ok: true, output: { answer: "stub" } }), undefined, undefined, undefined, undefined, undefined, undefined,
    async () => null, undefined, undefined, { dataDir: work, distDir: DIST, jevFetch: async () => { throw new Error("rollback: no network"); }, roles });
  try {
    const run0 = mkRun(ctx.dNew, store, n++, "synthetic earlier question"); // a recent synthetic Paco line: the filter wants a rewrite of SHORT
    store.recordChatTurn({ chat_id: STUB_CHAT, run_id: run0, role: "user", text: "synthetic earlier question", created_at: new Date(Date.now() - 5 * 60_000).toISOString() });
    const a = await laneDrive(ctx, store, worker, n++, { text: SHORT, reads: ["Sunny, 22C"], rewrite: answers("Sydney weather tomorrow") });
    runs.lane_rewritten = a.run; facts.searched_a = a.calls.searches; facts.fetched_a = a.calls.fetches.length;
    const b = await laneDrive(ctx, store, worker, n++, { text: SHORT, reads: [null, "Sunny, 22C"], rewrite: later(300, "Late Sydney query"), late: true });
    runs.lane_late = b.run; facts.searched_b = b.calls.searches; facts.fetched_b = b.calls.fetches;
    await new Promise((r) => setTimeout(r, 350)); // the late answer has landed: it must never have been searched
  } finally { try { await worker.shutdownPlanners(); } catch { /* a stopped planner is not a finding */ } }
  const p1 = await pinTurn(ctx, store, n++, LISTS_2, (k) => k === "anthropic/claude-opus-5-5"); runs.pin_refused = p1.id; facts.pin1 = p1;
  const p2 = await pinTurn(ctx, store, n++, LISTS_1, () => true); runs.pin_no_leg = p2.id; facts.pin2 = p2;
  const all = store.db.prepare("SELECT * FROM decisions WHERE rowid > ? ORDER BY rowid").all(mark).map((r) => ({ ...r }));
  const stray = all.filter((r) => !NEW_IDS.includes(r.entry_id));
  if (!stray.every((r) => LANE_OLD_IDS.has(r.entry_id))) throw new Error("rollback: the drives wrote a row of an unexpected old id");
  store.db.prepare(`DELETE FROM decisions WHERE rowid > ? AND entry_id IN (${[...LANE_OLD_IDS].map(() => "?").join(",")})`).run(mark, ...LANE_OLD_IDS);
  return { rows: all.filter((r) => NEW_IDS.includes(r.entry_id)), runs, facts, strayN: stray.length };
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
  if (!arg("--old-dist")) throw new SetupError("usage: --old-dist <merge-base dist> [--old-base-r6 <full sha>] [--live-db <path>]");
  const oldDist = resolve(arg("--old-dist"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  let prov, base;
  try { base = mergeBaseOf(DIST, arg("--old-base-r6")); prov = verifyStampedDist(oldDist, DIST, base, "omp/planner-supervisor.js"); } catch (e) { throw new SetupError(provenanceText(e)); }
  console.log(`old build pinned to base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, stamped dist ${prov.hash.slice(0, 12)}`);
  const root = initTemp(false);
  for (const k of [...SET_PINS, ...DELETE_PINS]) saved[k] = process.env[k];
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "work"), { recursive: true });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID", ...DELETE_PINS]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-rollback/omp", HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_ENABLED: "0", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  for (const k of ["storeOptionsFor", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "storeRecorder", "PlannerSupervisor", "lessonSetFingerprint", "ToolRegistry", "parseModelString", "selectorKey", "resolveOmpConfig", "CoreWorker", "runLookupLane", "PlannerRpcError"]) if (!dNew[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  if (!dOld.RunStore) throw new SetupError("RunStore missing from the old dist");
  const mods = async (dist) => ({ ...(await import(join(dist, "decisions/digest.js"))), ...(await import(join(dist, "decisions/status-view.js"))) });
  const [mNew, mOld] = [await mods(DIST), await mods(oldDist)];
  const RR = (await import(join(DIST, "omp/role-resolver.js"))).RoleResolver;
  const catalog = (await import(join(DIST, "omp/model-catalog.js"))).parseOmpCatalog(readFileSync(CATALOG_FIXTURE, "utf8"));
  if (!RR || !catalog) throw new SetupError("RoleResolver or the catalog fixture missing: rebuild");
  const A = join(mkTemp("copy-A"), "houge.sqlite"); const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, A);
  const prep = prepA(dNew, A);
  vacuumInto(A, F); // F is cut from the prepped A, so a daemon write between two live reads cannot separate them
  return { dNew, dOld, mNew, mOld, fx, RR, catalog, A, F, root, work: join(root, "work"), prep };
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
const ADDED = { [RW]: 2, [TH]: 2, [TM]: 2 }; // rows per id this build writes onto F
const OUT_REJ = "OutcomeRejected:value not allowed for review_ok";
/** P5: the six rows, exact, in the order they are written. [entry_id, verdict, reason_code, stage, the consulting run's label, rung, entry_version] */
const EXPECTED = [[RW, "rewrite", "rewritten", "pre_model", "lane_rewritten", "rule", 1], [TH, "none", "answered", "pre_model", "lane_rewritten", "rule", 1],
  [RW, "bare", "late", "pre_model", "lane_late", "rule", 1], [TH, "fetch", "thin", "pre_model", "lane_late", "rule", 1],
  [TM, "fallback", "refused", "pre_model", "pin_refused", "rule", 1], [TM, "none", "no_leg", "pre_model", "pin_no_leg", "rule", 1]];
/** The chat turns the drives add to F, in order [role, intent, text]: the synthetic Paco line, then the refused-head turn's user and answer, then the no_leg turn's user (it fails and answers nothing). */
const EXPECTED_TURNS = [["user", null, "synthetic earlier question"], ["user", null, "hi"], ["assistant", "loop", "answer"], ["user", null, "hi"]];
const shapeOf = (runs) => (r) => [r.entry_id, r.verdict, r.reason_code, r.stage, Object.entries(runs).find(([, id]) => id === r.run_id)?.[0] ?? "?", r.rung, r.entry_version];
/** Step 1: snapshot F, seed it through this build's real paths, mirror the chat turns onto A, check the seeded rows. */
async function seedPhase(ctx, st) {
  const { A, F } = ctx;
  phase = "snapshot"; const before = { n: NEW_IDS.map((id) => entryCount(F, id)), schema: schemaOf(F), counts: counts(F) };
  const chatMark = ro(F, (db) => db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM chat_turns").get().m);
  phase = "seed F"; const seed = await seedF(ctx, F);
  const addedTurns = turnsAdded(F, chatMark);
  check("the chat turns the drives added to F are exactly the expected ones (4: the synthetic Paco line, the refused-head turn's user and answer, the no_leg turn's user; no clarify or extra assistant turn), checked before they are mirrored onto A",
    same(turnShape(addedTurns), EXPECTED_TURNS) && addedTurns.every((r) => r.chat_id === STUB_CHAT || r.chat_id === CHAT), `added ${addedTurns.length} (want ${EXPECTED_TURNS.length}) · clarify ${addedTurns.filter((r) => r.intent === "clarify").length} (want 0)`);
  mirrorChatTurns(ctx, addedTurns, A);
  const seedIds = seed.rows.map((r) => r.decision_id);
  const snapF = { counts: counts(F), keys: keysOf(F), schema: schemaOf(F), hash: rowsHash(F, seedIds), content: contentOf(F) };
  const snapA = { counts: counts(A), keys: keysOf(A), schema: schemaOf(A), content: contentOf(A) };
  const rowShape = shapeOf(seed.runs); const got = seed.rows.map(rowShape);
  check("this build wrote exactly the six expected rows through its real lane and supervisor paths: lookup.rewrite rewrite/rewritten and bare/late, lookup.thin none/answered and fetch/thin, turn.model fallback/refused and none/no_leg (stage pre_model, rung rule, version 1, each with its consulting run's id, tool_call_id null), and nothing else (the lane's tool.wall and reader.family rows removed, asserted to be only those ids)",
    same(got, EXPECTED) && seed.rows.every((r) => r.tool_call_id === null && r.run_id !== null) && NEW_IDS.every((id, i) => entryCount(F, id) === before.n[i] + ADDED[id])
    && snapF.counts.decisions === snapA.counts.decisions + 6,
    `lane old-id rows removed ${seed.strayN} · rows ${seed.rows.map((r) => `${r.entry_id}/${r.verdict}/${r.reason_code}/${r.stage}/${rowShape(r)[4]}/${r.rung}/v${r.entry_version}`).join(" ")} · decisions A ${snapA.counts.decisions} F ${snapF.counts.decisions} · outbox parked on A ${ctx.prep.parked}`);
  Object.assign(st, { before, seed, seedIds, snapF, snapA, rowShape });
}
/** Step 2: the old build on A and F, and the no-migration check. */
async function oldPhase(ctx, st) {
  const { A, F } = ctx; const { before, snapA, snapF } = st;
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
  Object.assign(st, { now, oa, of, aA, aF });
}
/** Step 3: row integrity and the rendered comparisons. */
function compareAndRefusePhase(ctx, st) {
  const { A, F, mOld } = ctx; const { before, seed, seedIds, snapF, snapA, rowShape, now, oa, of, aA, aF } = st;
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
  check("A vs F as rendered by the old build: the digest is identical (no per-entry lines, no new id), /status differs only in the three R6 count lines (each whole line, rung breakdown included, equals the line built from SQL rung counts over the same window; +2, +2, +2 over A), recent list = A's with the six seeded rows on top",
    bad.length === 0 && same(newLines(oa.status), expLinesA) && same(newLines(of.status), expLinesF) && expLinesF.length === 3 && NEW_IDS.every((id) => winF[id] === winA[id] + ADDED[id]),
    bad.length ? bad.join("; ") : `F lines [${newLines(of.status).join(" | ")}] = SQL-built · A lines [${newLines(oa.status).join(" | ")}] · digest ${of.digest.length} raw lines (A ${oa.digest.length}) identical, same now · list ${of.listText.length - 1} rows`);
  check("the old build refuses review_ok naming each of the three R6 ids (normal OutcomeRejected, no crash; a valid id is accepted) on A and F",
    [oa, of].every((x) => NEW_IDS.every((id) => x.outcomes[id] === OUT_REJ) && x.outcomes["tool.policy"] === "inserted:true") && same(oa.outcomes, of.outcomes), `A ${J(oa.outcomes)} · F ${J(of.outcomes)}`.replace(/"/g, ""));
  const grew = (x, y) => TABLES.map((t) => y[t] - x[t]);
  check("the old build wrote the same rows to A and F: only decision_outcomes grew, by exactly 1 (its valid-id probe)",
    same(grew(snapA.counts, aA), grew(snapF.counts, aF)) && TABLES.every((t, i) => grew(snapF.counts, aF)[i] === (t === "decision_outcomes" ? 1 : 0)), `growth ${TABLES.map((t, i) => `${t} ${grew(snapA.counts, aA)[i]}/${grew(snapF.counts, aF)[i]}`).join(" · ")} (A/F)`);
  st.keysF = keysF;
}
/** Step 4: this build reopens F. */
function reopenPhase(ctx, st) {
  const { F, mNew } = ctx; const { snapF, keysF, now } = st;
  phase = "reopen F"; const s = openStore(ctx.dNew, F);
  const re = mNew.decisionStatusLines(s, now);
  const reRows = s.listRecentDecisions(100_000).map(canonRow).sort();
  closeStore(s);
  check("this build reopens F: every decisions row's full content is unchanged, nothing lost, and the three R6 /status lines equal the SQL counts",
    same(contentOf(F), snapF.content) && same(reRows, [...snapF.content].sort()) && lost(keysF, keysOf(F)).every((n) => n === 0) && same(newLines(re), expectedLines(F, now)),
    `rows read ${reRows.length}/${snapF.content.length} · lines ${J(lineTotals(re)).replace(/"/g, "")}`);
  const tomb = [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
  check("no houge.kill tombstone appeared in the cwd or the main checkout (P3)", tomb === 0, `found ${tomb} (want 0)`);
}
async function run(ctx) {
  const st = {};
  await seedPhase(ctx, st); await oldPhase(ctx, st); compareAndRefusePhase(ctx, st); reopenPhase(ctx, st);
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
