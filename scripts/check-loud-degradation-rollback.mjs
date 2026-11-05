#!/usr/bin/env node
// Rollback check — loud degradation (spec 2026-11-02 §10; plan Task 14). From the worktree after `npm run build` THERE (never in the main checkout):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-loud-degradation-rollback.mjs --old-base <full merge-base sha> [--old-dist <dist>] [--live-db <path>]
// --old-dist defaults to <main checkout>/.worktrees/base-<first 12 of --old-base>/dist (built and stamped with scripts/stamp-dist.mjs). Without --old-base the merge base is discovered.
// Provenance file: omp/model-roles-tick.js (the compiled module this slice changed; the stamped old build must differ from this one there).
// Two VACUUM copies: A (never touched by this build) and F (cut from A, then written by THIS build: the tier table seeded by its migration, the two planner_session_state
// columns, a model_probe row, a tier write, a model_roles_resolved row from the new tick, /fresh and a stored trust level, an idea_panel_tick row with judge_models).
// The merge-base build then opens A and F: schema_stable, models_renders, status_renders, old_change_diff_reads_new_payload, carry_still_carries; this build reopens F: new_reopens.
// Exit 0 PASS · 1 FAIL · 2 setup error. The live DB is read only by VACUUM INTO; every write goes to a copy under /tmp/hg-s4d-*, removed on every exit path (pass, FAIL,
// throw, SIGINT, SIGTERM, SIGHUP). Pins set before any store opens and restored on exit: HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root,
// HOUGE_TELEGRAM_CHAT_ID = -1003 (a stub). No omp, no Telegram client. Only fixed codes and closed-set names are printed: no error message, no stack, no flag to print one.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyStampedDist } from "./old-dist-provenance.mjs";
import * as fx from "./stage4-supervisor-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const FIXTURE = resolve(new URL("../tests/fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const CHAT = "42";
const STUB_CHAT = "-1003"; // numeric, not a real chat
const NEW_VERSIONS = ["2026-11-02-hostile-schedule-event", "2026-11-02-loud-degradation"];
const NEW_COLUMNS = ["fresh_requested_at", "transcript_trust_at"];
const TINY_TO = "kimi-code/k3:low";
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES", "HOUGE_MODEL_ROLES"];
/** /status lines whose number the seeding legitimately moves (the seeding wrote ledger events, one tier row, a trust level): compared with the digits masked, named in the detail. */
/** The one /status line whose number the seeding moves: the open-incident count. Only that count is masked, so a changed "swept <age> ago" still fails. Code-owned name for the detail. */
const COUNT_LINES = [{ name: "self_check_open_incident_count", re: /^(Self-check: swept (?:never|.+ ago) · )\d+ open incidents?$/ }];
const failures = [];
const saved = {};
const J = (o) => JSON.stringify(o);
const same = (a, b) => J(a) === J(b);
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const handles = [];
const yieldLoop = () => new Promise((r) => setImmediate(r)); // lets a SIGINT/SIGTERM handler run during an otherwise synchronous run

/** The only setup-failure reasons ever printed (a closed list; never a message, a path or a detail). */
const REASONS = {
  usage: "usage: --old-base <full sha> [--old-dist <dist>] [--live-db <path>]",
  not_in_worktree: "this dist is not under .worktrees/: run from the worktree, never build in the main checkout",
  old_dist_missing: "the old build's dist/ does not exist (build and stamp the base worktree)",
  live_db_missing: "the live DB was not found (--live-db <path>)",
  tombstone_present: "a houge.kill tombstone already exists: refusing to run",
  vacuum_failed: "VACUUM INTO of the live DB failed",
  fixture_unreadable: "the catalog fixture could not be read or parsed",
  export_missing: "a module or export the check drives is missing from a dist: rebuild",
  new_row_missing: "this build did not write the model_roles_resolved row the check needs",
  unexpected: "an unexpected setup error (detail withheld)"
};
class Setup extends Error { constructor(code) { super(code); this.code = code; } }
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
  for (let n = 1; ; n++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (n >= 5 || !/locked|busy/i.test(String(e))) throw new Setup("vacuum_failed"); sleepSync(1_000); }
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
const objectsOf = (path) => ro(path, (db) => db.prepare("SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name").all().map((r) => ({ ...r })));
const columnsOf = (path, table) => ro(path, (db) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const versionsOf = (path) => ro(path, (db) => db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version));
const minus = (a, b) => a.filter((x) => !b.includes(x));
const objKey = (o) => `${o.type} ${o.name}`;
/** The code-owned name of the count line `line` is, or null; `masked` replaces only its count. */
const countLineOf = (line) => COUNT_LINES.find((c) => c.re.test(line)) ?? null;
const maskCount = (line) => { const c = countLineOf(line); return c ? line.replace(c.re, "$1# open incident(s)") : line; };
/** Startup self-test of the matcher (gateway.ts: "swept <age> ago" or "swept never"): a differing count is masked in both forms; a differing age is not. */
const countMatcherOk = () => {
  const eq = (a, b) => maskCount(a) === maskCount(b);
  return eq("Self-check: swept 1d ago · 5 open incidents", "Self-check: swept 1d ago · 2 open incidents")
    && eq("Self-check: swept never · 1 open incident", "Self-check: swept never · 0 open incidents")
    && !eq("Self-check: swept 1d ago · 5 open incidents", "Self-check: swept 9d ago · 5 open incidents")
    && !eq("Self-check: swept never · 5 open incidents", "Self-check: swept 1d ago · 5 open incidents");
};
const migrationRowsOf = (path) => ro(path, (db) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all().map((r) => ({ ...r })));

// ---- this build seeds F ----
async function loadCatalog(dNew) {
  try { const c = dNew.parseOmpCatalog(readFileSync(FIXTURE, "utf8")); if (c) return c; } catch { /* falls to the setup error */ }
  throw new Setup("fixture_unreadable");
}
const resolverOf = (d, store, catalog) => new d.RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog });
/** P27: the tick's 24 h latch reads the copy's own newest model_roles_resolved row, so `now` is that row + 25 h (else the wall clock). */
const tickNowOf = (store) => { const last = store.latestModelRolesResolved(); return last ? new Date(Date.parse(last.resolved_at) + 25 * 3_600_000).toISOString() : new Date().toISOString(); };
async function seedF(ctx) {
  const s = openStore(ctx.dNew, ctx.F);
  try {
    const now = new Date().toISOString();
    s.recordModelProbe({ tier: "kimi", selector: "kimi-code/k3.1-pro", purpose: "head", result: "pass", kind: "ok" });
    s.writeModelTier({ tier: "kimi", adopted: "k3.1-pro", previous: "k3", adopted_at: now, rejected_selector: null, rejected_at: null }, now);
    const roles = resolverOf(ctx.dNew, s, ctx.catalog);
    await roles.refreshCatalog();
    const tickNow = tickNowOf(s);
    const res = await ctx.dNew.runModelRolesTick({ store: s, roles, now: tickNow, notify: () => {} });
    if (!res.ran) throw new Setup("new_row_missing");
    s.requestFreshTranscript(CHAT, now);
    s.setTranscriptTrust(CHAT, "untrusted", now);
    s.recordIdeaPanelTick({ result: "ok", judges_ok: ["judges:0", "judges:1"], judges_failed: [], chair_used: false, cards_scored: 0, shortlist_ids: [], week_key: "2026-W45", brief_written: false,
      judge_models: { "judges:0": "openai-codex/gpt-6.1-sol", "judges:1": null } });
    const row = s.latestModelRolesResolved();
    if (!row || row.resolved_at !== tickNow) throw new Setup("new_row_missing");
    return { tiers: s.listModelTiers().map((r) => ({ ...r })), fresh: s.freshRequestedAt(CHAT), trust: s.getTranscriptTrust(CHAT), row, tickNow };
  } finally { closeStore(s); }
}

// ---- the merge-base build on a copy ----
function replyTextsSince(store, mark) {
  return store.db.prepare("SELECT payload_json FROM notification_outbox WHERE rowid > ? ORDER BY rowid").all(mark).map((r) => String(JSON.parse(r.payload_json).text ?? ""));
}
function statusOf(d, store, now) {
  const mark = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM notification_outbox").get().m;
  const res = new d.Gateway(store).intake(d.buildTypedTaskEvent({ source: "telegram", type: "status", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: "telegram:rb-ld-status", source_reference: "telegram:update:rb-ld-status" }), now);
  if (!res.ok) throw new Error("rollback: status intake refused");
  const texts = replyTextsSince(store, mark);
  if (texts.length !== 1) throw new Error("rollback: /status produced no single reply");
  return texts[0].split("\n");
}
async function oldRender(ctx, path, now) {
  const { dOld, mOld } = ctx;
  const s = openStore(dOld, path); // the old build opens the copy: its migrations run
  try {
    const roles = resolverOf(dOld, s, ctx.catalog);
    await roles.refreshCatalog();
    const models = mOld.modelsListText(s, roles);
    const status = statusOf(dOld, s, now);
    return { models, status };
  } finally { closeStore(s); }
}
/** Line 4: the old tick on F with a fake resolver returning the new row's keys, `tiny` moved; returns what it did. */
async function oldTick(ctx, headTo) {
  const s = openStore(ctx.dOld, ctx.F);
  try {
    const row = s.latestModelRolesResolved();
    const fake = { refreshCatalog: async () => true, resolveAll: () => row.roles.map((r) => ({ key: r.key, head: r.key === "tiny" ? headTo : r.head, candidates: r.key === "tiny" ? [headTo] : (r.candidates ?? []), source: r.source ?? "list" })) };
    const notes = [];
    const now = new Date(Date.parse(row.resolved_at) + 25 * 3_600_000).toISOString();
    const res = await ctx.mOldTick.runModelRolesTick({ store: s, roles: fake, now, notify: (t) => notes.push(t) });
    const fromHead = row.roles.find((r) => r.key === "tiny")?.head ?? null;
    return { res, notes, want: ctx.mOldTick.changeLine("tiny", fromHead, headTo), fromHead };
  } finally { closeStore(s); }
}
/** Line 5: one turn on chat 42 under the old supervisor. mkSupervisor re-records and promotes the current lesson fingerprint for chat 42 first (stage4-supervisor-fixture.mjs): requestFreshTranscript
 *  may have inserted the row with lesson_fingerprint = '', and without that step the old supervisor would lesson-reset at spawn, start clean and fail this line for the wrong reason. Keep it. */
async function oldTurn(ctx) {
  const s = openStore(ctx.dOld, ctx.F);
  try {
    const { sup } = fx.mkSupervisor(ctx.dOld, s);
    const run_id = fx.intakeRun(ctx.dOld, s, "hi", "rb-ld-turn");
    sup.submit(fx.req(run_id, "hi"));
    await sup.whenIdle();
    return { trust: s.getLedgerEvents(run_id).filter((e) => e.event_type === "turn_trust").map((e) => e.payload), after: s.getTranscriptTrust(CHAT) };
  } finally { await fx.cleanup(); closeStore(s); }
}

async function setup() {
  if (!DIST.includes("/.worktrees/")) throw new Setup("not_in_worktree");
  const baseArg = arg("--old-base");
  if (baseArg !== undefined && !/^[0-9a-f]{40}$/.test(baseArg)) throw new Setup("usage");
  let base;
  try { base = mergeBaseOf(DIST, baseArg); } catch (e) { throw new SetupError(provenanceText(e)); }
  const oldDist = resolve(arg("--old-dist") ?? join(MAIN_CHECKOUT, ".worktrees", `base-${base.slice(0, 12)}`, "dist"));
  if (!existsSync(oldDist)) throw new Setup("old_dist_missing");
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new Setup("live_db_missing");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new Setup("tombstone_present");
  let prov;
  try { prov = verifyStampedDist(oldDist, DIST, base, "omp/model-roles-tick.js"); } catch (e) { throw new SetupError(provenanceText(e)); }
  console.log(`old build pinned to base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, stamped dist ${prov.hash.slice(0, 12)}`);
  const root = initTemp(false);
  for (const k of [...SET_PINS, ...DELETE_PINS]) saved[k] = process.env[k];
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID", ...DELETE_PINS]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-rollback/omp", HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_ENABLED: "0", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  const extra = async (dist) => ({ ...(await import(join(dist, "omp/role-resolver.js"))), ...(await import(join(dist, "omp/model-catalog.js"))) });
  const [xNew, xOld] = [await extra(DIST), await extra(oldDist)];
  const mOld = await import(join(oldDist, "gateway/models-commands.js"));
  const [tNew, tOld] = [await import(join(DIST, "omp/model-roles-tick.js")), await import(join(oldDist, "omp/model-roles-tick.js"))];
  Object.assign(dNew, { RoleResolver: xNew.RoleResolver, parseOmpCatalog: xNew.parseOmpCatalog, runModelRolesTick: tNew.runModelRolesTick });
  Object.assign(dOld, { RoleResolver: xOld.RoleResolver, parseOmpCatalog: xOld.parseOmpCatalog });
  for (const k of ["storeOptionsFor", "Gateway", "buildTypedTaskEvent", "RoleResolver", "parseOmpCatalog", "runModelRolesTick", "PlannerSupervisor", "lessonSetFingerprint", "ToolRegistry", "parseModelString", "selectorKey", "resolveOmpConfig"]) if (!dNew[k]) throw new Setup("export_missing");
  for (const k of ["RunStore", "Gateway", "buildTypedTaskEvent", "RoleResolver", "parseOmpCatalog", "PlannerSupervisor", "lessonSetFingerprint", "ToolRegistry", "parseModelString", "selectorKey", "resolveOmpConfig"]) if (!dOld[k]) throw new Setup("export_missing");
  if (!mOld.modelsListText || !tOld.runModelRolesTick || !tOld.changeLine) throw new Setup("export_missing");
  const catalog = await loadCatalog(dNew);
  const A = join(mkTemp("copy-A"), "houge.sqlite"); const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, A);
  vacuumInto(A, F); // F is cut from A, so a daemon write between two live reads cannot separate them
  return { dNew, dOld, mOld, mOldTick: tOld, catalog, A, F, root };
}

async function run(ctx) {
  const { A, F } = ctx;
  check("count_matcher_self_test — the Self-check count mask accepts \"swept <age> ago\" and \"swept never\", masks only the count, and a changed age or never-vs-age still mismatches", countMatcherOk());
  phase = "snapshot"; const before = { objA: objectsOf(A), colsA: columnsOf(A, "planner_session_state"), verA: versionsOf(A), rowsA: migrationRowsOf(A), rowsF0: migrationRowsOf(F) };
  phase = "seed F"; const seed = await seedF(ctx);
  const newObjF = objectsOf(F); const rowsFSeeded = migrationRowsOf(F);
  await yieldLoop();
  const now = new Date(Date.parse(seed.tickNow) + 30 * 60_000).toISOString(); // one instant for both copies' /status
  phase = "old build on A"; const oa = await oldRender(ctx, A, now);
  await yieldLoop();
  phase = "old build on F"; const of = await oldRender(ctx, F, now);
  phase = "compare";
  const [objA2, objF2] = [objectsOf(A), objectsOf(F)];
  const addedObjs = minus(objF2.map(objKey), objA2.map(objKey));
  const ownedByTiers = (k) => k === "table model_tiers" || /^index sqlite_autoindex_model_tiers_\d+$/.test(k);
  const addedCols = minus(columnsOf(F, "planner_session_state"), columnsOf(A, "planner_session_state"));
  const addedVers = minus(versionsOf(F), versionsOf(A));
  const removed = minus(objA2.map(objKey), objF2.map(objKey));
  const [rowsA2, rowsF2] = [migrationRowsOf(A), migrationRowsOf(F)];
  const preExisting = rowsF2.filter((r) => !NEW_VERSIONS.includes(r.version));
  const rowsKept = same(rowsA2, before.rowsA) && same(rowsF2, rowsFSeeded) && same(preExisting, rowsA2) && same(preExisting, before.rowsF0);
  const oldRan = rowsKept && same(objA2, before.objA) && same(columnsOf(A, "planner_session_state"), before.colsA) && same(versionsOf(A), before.verA) && same(objF2, newObjF);
  check("schema_stable — the old build opened F without throwing; F minus A is exactly {table model_tiers}, {fresh_requested_at, transcript_trust_at} on planner_session_state, and the two new migration rows; every pre-existing schema_migrations row (version and applied_at) unchanged by the old build; the old build ran no migration of its own",
    addedObjs.includes("table model_tiers") && addedObjs.every(ownedByTiers) && removed.length === 0 && same([...addedCols].sort(), NEW_COLUMNS) && same([...addedVers].sort(), NEW_VERSIONS) && oldRan,
    `objects +${J(addedObjs)} -${removed.length} · columns +${J(addedCols)} · migrations +${J(addedVers)} · old build migrated A/F: ${!oldRan}`);
  check("models_renders — the old modelsListText (old RoleResolver over the fixture catalog) renders on F and equals A's render (the old build ignores model_tiers)",
    typeof of.models === "string" && of.models.length > 0 && of.models === oa.models, `${of.models.split("\n").length} lines on F, ${oa.models.split("\n").length} on A`);
  const diffs = []; const n = Math.max(oa.status.length, of.status.length);
  for (let i = 0; i < n; i++) if (oa.status[i] !== of.status[i]) diffs.push([oa.status[i] ?? "", of.status[i] ?? ""]);
  const masked = diffs.filter(([a, f]) => countLineOf(a) !== null && maskCount(a) === maskCount(f));
  const unmasked = diffs.filter((d) => !masked.includes(d));
  check("status_renders — the old /status for chat 42 renders on F; every line equals A's except the open-incident count on the Self-check line (only that count masked; the swept age must match)",
    of.status.length > 0 && oa.status.length === of.status.length && unmasked.length === 0,
    `${of.status.length} lines · masked counts [${masked.map(([a]) => countLineOf(a).name).join(" | ")}]${unmasked.length ? ` · UNEXPECTED ${unmasked.length} line(s) differ beyond the masked counts` : ""}`);
  phase = "old tick on F"; const tk = await oldTick(ctx, TINY_TO);
  check(`old_change_diff_reads_new_payload — the old runModelRolesTick on F (the new row's keys, tiny moved to ${TINY_TO}, now = the new row + 25 h) returns changed ["tiny"] and exactly one notice, the old changeLine`,
    tk.res.ran === true && same(tk.res.changed, ["tiny"]) && tk.notes.length === 1 && tk.notes[0] === tk.want, `ran ${tk.res.ran} · changed ${J(tk.res.changed)} · notices ${tk.notes.length} · from ${tk.fromHead}`);
  phase = "old turn on F"; await yieldLoop(); const turn = await oldTurn(ctx);
  check("carry_still_carries — the old supervisor's first turn on chat 42 over F records exactly [{untrusted, carried_untrusted}] (it reads transcript_trust and ignores the marker and the new column)",
    same(turn.trust, [{ level: "untrusted", cause: "carried_untrusted" }]), `turn_trust ${J(turn.trust)} · stored after ${turn.after}`);
  phase = "reopen F"; const s = openStore(ctx.dNew, F);
  let reopen;
  try { reopen = { tiers: s.listModelTiers().map((r) => ({ ...r })), fresh: s.freshRequestedAt(CHAT) }; } finally { closeStore(s); }
  check("new_reopens — this build reopens F after the old build wrote to it: no throw, listModelTiers() unchanged, freshRequestedAt(\"42\") unchanged",
    same(reopen.tiers, seed.tiers) && reopen.fresh === seed.fresh && seed.fresh !== null, `tiers ${reopen.tiers.length} (was ${seed.tiers.length}) · fresh marker ${reopen.fresh === seed.fresh ? "unchanged" : "CHANGED"}`);
  const tomb = [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
  check("no houge.kill tombstone appeared in the cwd or the main checkout", tomb === 0, `found ${tomb} (want 0)`);
}

function restoreEnv() { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } delete process.env.HOUGE_OMP_BIN; }
function onSignal(code) { for (const h of handles.splice(0)) closeStore(h); cleanupTemp(); restoreEnv(); process.exit(code); }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => onSignal(code));

export async function main() {
  let root;
  try {
    const ctx = await setup(); root = ctx.root;
    try { await run(ctx); } catch (e) { if (e instanceof Setup) throw e; check(`run — unexpected error at ${phase}: ${errCode(e)}`, false); }
    console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (e) {
    // SetupError (the harness's own messages) and provenanceText() are fixed strings; Setup carries a key into REASONS; anything else is withheld.
    console.error(`setup_failed: ${e instanceof Setup ? REASONS[e.code] ?? REASONS.unexpected : e instanceof SetupError ? e.message : REASONS.unexpected}`);
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
