#!/usr/bin/env node
// Rollback check — decision ladder remainder R1, the three intake entries (spec 2026-10-30 R1 §7; plan Task 7).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-ladder-remainder-r1-rollback.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-aec1d4f/dist [--old-base-r1 <full sha>] [--live-db <path>]
// --old-base-r1 <full sha>: the base the old build must be pinned to; required once the branch is merged (merge-base of HEAD and main is then HEAD itself).
// R1 adds record-only `intake.*` decision rows (no migration, no table), all with run_id and tool_call_id null. ONE VACUUM copy of the live DB:
// this build writes one row of each new id through its own Gateway.intake (as scripts/live-gate-ladder-remainder-r1.mjs does); then the merge
// base aec1d4f (the build before the three entries existed) opens it, renders /status + digest + /status decisions, lists the decisions, and
// refuses review_ok outcomes naming each new id (outcomes.ts validates against its own ENTRY_IDS); then this build reopens it.
// The digest's chat-bound review omits null-run rows by design (spec §5): "all rows present" is checked on the decisions table itself (count,
// key identity, byte-identical seeded rows), and the old build's /status count line per new id must equal the SQL count over its window.
// Provenance: verifyStampedDist is given gateway/gateway.js (the compiled module this slice changed), not the 4C default core-worker.js.
// Dropped from the 4C check, and why: the A/F two-copy comparison (A vs F render equality, F-only baseline) — R1's old-build behaviour
// on rows of ids it does not know is already pinned by the SQL-count line and the row-identity lines, and F would only re-prove 4C's
// delta bookkeeping; the per-decider rung breakdown of the count line (the R1 rows are single-rung rule rows, the total is compared);
// the memory.lesson_admit/schedule.admit/memory.correct_preflight call-site seeds (worker, bridge, scheduler fixtures — R1 seeds through
// Gateway.intake only); the recent-list expected-newest-10 splice (it modelled the 4C seed's mixed runs; here the list is checked by reading
// every row); the "c558413 added the same rows to A and F" growth line (no F). insertLadderMove is not probed (not id-validated, 4C plan P2).
// Exit 0 PASS · 1 FAIL · 2 setup error. There is no debug flag. The live DB is read only by VACUUM INTO; every write goes to the copy, which
// lives under /tmp/hg-s4d-* and is removed on every exit path (pass, FAIL, throw, SIGINT, SIGTERM, SIGHUP). Safety pins set before any store
// opens and restored on exit: HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root, HOUGE_TELEGRAM_CHAT_ID = a stub. Every chat and
// text is synthetic and nothing is sent anywhere. Only line names, entry ids, counts, verdicts and codes from closed sets are printed.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyStampedDist } from "./old-dist-provenance.mjs";
import { intakeEvent, saturateWindow, seedAsk } from "./stage4-intake-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const NEW_IDS = ["intake.rate_limit", "intake.rating_reply", "intake.budget_fuse"];
const TABLES = ["decisions", "decision_outcomes", "notification_outbox", "telegram_command_audit", "runs"];
const COUNT_RE = /^· ([a-z_]+(?:\.[a-z_]+)+) (\d+) — /;
const BIG = 1_000_000_000; // caps no real copy reaches
const STUB_CHAT = "rollback-stub-chat";
const PINNED = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_RATING_PENDING_MINUTES"];
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
const totalsMatch = (lines, want) => { const got = lineTotals(lines); return NEW_IDS.every((id) => got[id].length === 1 && got[id][0] === want[id]); };

// ---- step 1: this build writes one row of each new id through Gateway.intake ----
const gateway = (d, store, caps = {}) => new d.Gateway(store, { ...d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG, ...caps });
const send = (d, gw, who, o) => gw.intake(intakeEvent(d, who, o), wall());
/** Rate limit (sixth turn in the window), rating reply (bare digit on an open ask) and budget fuse (runs cap 0); each on its own identity. */
function seedRows(d, store) {
  const who = (n) => ({ chat: `rb-r1-chat-${n}`, actor: `rb-r1-actor-${n}` });
  saturateWindow(store, who(1), "turn", 5, wall());
  const limited = send(d, gateway(d, store), who(1), { key: "rb-limit" });
  seedAsk(store, who(2), wall(), 10, true);
  const rated = send(d, gateway(d, store), who(2), { goal: "3", key: "rb-rating" });
  const fused = send(d, gateway(d, store, { runs: 0 }), who(3), { key: "rb-fuse" });
  return { limited: limited.error?.code, rated: rated.ok ? rated.status : rated.error?.code, fused: fused.error?.code };
}
async function seedA(dNew, path) {
  const s = openStore(dNew, path);
  const mark = s.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
  const results = seedRows(dNew, s);
  const rows = s.db.prepare("SELECT decision_id, entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ? ORDER BY rowid").all(mark).map((r) => ({ ...r }));
  closeStore(s);
  return { results, rows };
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
  r.digestLines = dg && dg.text ? dg.text.split("\n").length : 0;
  r.list = mOld.decisionListText(s, process.env).split("\n").length - 1;
  r.listedAll = s.listRecentDecisions(100_000).length;
  r.listedNew = s.listRecentDecisions(100_000).filter((x) => NEW_IDS.includes(x.entry_id)).length;
  r.outcomes = outcomeProbes(s);
  closeStore(s);
  return r;
}

async function setup() {
  if (!DIST.includes("/.worktrees/")) throw new SetupError(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
  if (!arg("--old-dist")) throw new SetupError("usage: --old-dist <merge-base dist> [--old-base-r1 <full sha>] [--live-db <path>]");
  const oldDist = resolve(arg("--old-dist"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  let prov, base;
  try { base = mergeBaseOf(DIST, arg("--old-base-r1")); prov = verifyStampedDist(oldDist, DIST, base, "gateway/gateway.js"); } catch (e) { throw new SetupError(provenanceText(e)); }
  console.log(`old build pinned to merge base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, stamped dist ${prov.hash.slice(0, 12)}`);
  const root = initTemp(false);
  for (const k of PINNED) saved[k] = process.env[k];
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  delete process.env.HOUGE_RATING_PENDING_MINUTES;
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-rollback/omp", HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  for (const k of ["storeOptionsFor", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS"]) if (!dNew[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  if (!dOld.RunStore) throw new SetupError("RunStore missing from the old dist");
  const mods = async (dist) => ({ ...(await import(join(dist, "decisions/digest.js"))), ...(await import(join(dist, "decisions/status-view.js"))) });
  const [mNew, mOld] = [await mods(DIST), await mods(oldDist)];
  const A = join(mkTemp("copy-A"), "houge.sqlite");
  vacuumInto(liveDb, A);
  return { dNew, dOld, mNew, mOld, A, root };
}

async function run(ctx) {
  const { dNew, A, mNew } = ctx;
  phase = "snapshot"; const before = { n: NEW_IDS.map((id) => entryCount(A, id)), schema: schemaOf(A) };
  phase = "seed A"; const seed = await seedA(dNew, A);
  const seedIds = seed.rows.map((r) => r.decision_id);
  const snap = { counts: counts(A), keys: keysOf(A), schema: schemaOf(A), hash: rowsHash(A, seedIds) };
  const per = NEW_IDS.map((id) => seed.rows.filter((r) => r.entry_id === id));
  check("this build wrote one row of each new id through Gateway.intake: the expected verdicts, run_id and tool_call_id null, nothing else added",
    per.every((r) => r.length >= 1) && seed.rows.length === per.reduce((a, r) => a + r.length, 0) && seed.rows.every((r) => r.run_id === null && r.tool_call_id === null)
    && per.every((r, i) => entryCount(A, NEW_IDS[i]) === before.n[i] + r.length) && seed.results.limited === "TELEGRAM_RATE_LIMITED" && seed.results.rated === "rating_captured" && seed.results.fused === "GLOBAL_BUDGET_FUSE",
    `rows per id ${per.map((r) => r.length).join("/")} (want >=1 each) · pairs ${seed.rows.map((r) => `${r.verdict}/${r.reason_code}`).join(",")} · results ${J(seed.results).replace(/"/g, "")}`);
  await yieldLoop();
  const now = new Date(Date.now() + 60_000).toISOString();
  phase = "old build on A"; const old = await oldSteps(ctx, A, now);
  check("aec1d4f opened the copy and every step (/status, digest, /status decisions, list, review_ok) completed without throwing", true);
  phase = "compare";
  const after = counts(A); const schemaAfter = schemaOf(A);
  check("aec1d4f ran no migration: the schema (every object's sql and user_version) is identical before and after its open",
    same(snap.schema, old.schemaAfterOpen) && same(snap.schema, schemaAfter) && same(before.schema, snap.schema), `${snap.schema.hash} uv ${snap.schema.uv} -> ${schemaAfter.hash} uv ${schemaAfter.uv}`);
  const keysAfter = keysOf(A); const gone = lost(snap.keys, keysAfter);
  const hashAfter = rowsHash(A, seedIds);
  check("every stored decision row is present after aec1d4f: count unchanged, no key lost, the seeded rows byte-identical, and its list reads every row (the digest omits null-run rows by design)",
    after.decisions === snap.counts.decisions && old.decisionsOnOpen === snap.counts.decisions && gone.every((n) => n === 0) && hashAfter === snap.hash && seedIds.every((k) => keysAfter.decisions.has(k))
    && old.listedAll === after.decisions && old.listedNew === seed.rows.length + before.n.reduce((a, b) => a + b, 0),
    `decisions ${snap.counts.decisions} -> ${after.decisions} · keys lost ${gone.join("/")} (${TABLES.join("/")}) · seeded hash ${snap.hash} -> ${hashAfter} · list reads ${old.listedAll}/${after.decisions}, of which new ids ${old.listedNew}`);
  const win = windowCounts(A, now);
  check("aec1d4f's /status carries exactly one count line per new id, each total equal to the SQL count over its window; its digest and list render",
    totalsMatch(old.status, win) && old.digestLines > 0 && old.list >= 1, `lines ${J(lineTotals(old.status)).replace(/"/g, "")} vs SQL ${J(win).replace(/"/g, "")} · digest ${old.digestLines} lines · list ${old.list} rows`);
  const refused = NEW_IDS.every((id) => old.outcomes[id] === "OutcomeRejected:value not allowed for review_ok") && old.outcomes["tool.policy"] === "inserted:true";
  check("aec1d4f refuses review_ok naming intake.rate_limit, intake.rating_reply and intake.budget_fuse (normal OutcomeRejected, no crash; a valid id is accepted)", refused, J(old.outcomes).replace(/"/g, ""));
  const grown = TABLES.filter((t) => t !== "decision_outcomes").filter((t) => after[t] !== snap.counts[t]);
  check("aec1d4f wrote nothing else: no table but decision_outcomes (its one valid-id probe) changed its count, and that grew by exactly 1",
    grown.length === 0 && after.decision_outcomes - snap.counts.decision_outcomes === 1, `${TABLES.map((t) => `${t} ${snap.counts[t]}->${after[t]}`).join(" · ")}`);
  phase = "reopen A"; const s = openStore(dNew, A);
  const re = mNew.decisionStatusLines(s, now);
  const reRows = s.listRecentDecisions(100_000).length;
  closeStore(s);
  const keys3 = keysOf(A);
  check("this build reopens the copy: the seeded rows are intact, every decision row is listed, nothing lost, and the three new-id /status lines equal the SQL counts",
    rowsHash(A, seedIds) === snap.hash && reRows === after.decisions && lost(keysAfter, keys3).every((n) => n === 0) && totalsMatch(re, windowCounts(A, now)),
    `rows listed ${reRows}/${after.decisions} · lines ${J(lineTotals(re)).replace(/"/g, "")}`);
}

function restoreEnv() { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
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
