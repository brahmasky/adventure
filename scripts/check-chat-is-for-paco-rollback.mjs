#!/usr/bin/env node
// Rollback check — chat is for Paco (spec 2026-11-03 §10). From the worktree after `npm run build` THERE (never in the main checkout):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-chat-is-for-paco-rollback.mjs --old-dist <merge-base dist> [--old-base <full sha>] [--live-db <path>]
//   e.g. --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-c10507c4/dist (a built worktree of the merge base; no stamp needed: its HEAD must be the base).
// What it proves: the pre-slice build boots on a post-slice DB, ignores change_log, sends background notices to chat again, loses no data — and the one residual the
// spec names: after a tick that retired the card override, the old build's gemini-pro pattern has no member, so judges:2 reopens role_unresolved and the card returns.
// Two VACUUM copies of the live DB: A (never touched by this build) and F (cut from A, then written by THIS build: change_log rows from a log-kind incident and from
// the new roles tick on the fixture catalog, gemini-pro adopted, the legacy card override of judges:2 retired). The old build then opens A and F, reads, ticks.
// Exit 0 PASS · 1 FAIL · 2 setup error. The live DB is read only by VACUUM INTO; every write goes to a copy under /tmp/hg-s4d-*, removed on every exit path.
// Pins: HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root, HOUGE_TELEGRAM_CHAT_ID = -1003 (a stub). No omp (HOUGE_OMP_BIN points nowhere), no Telegram client.
// Only fixed codes and counts are printed: no error message, no stack, no id, no message text.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyOldDist } from "./old-dist-provenance.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const FIXTURE = resolve(new URL("../tests/fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const STUB_CHAT = "-1003"; // numeric, not a real chat
const ARGON = "gemini-4-argon";
const GOOGLE = "google-antigravity";
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES", "HOUGE_MODEL_ROLES"];
const failures = [];
const saved = {};
const J = (o) => JSON.stringify(o);
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const handles = [];

/** The only setup-failure reasons ever printed (a closed list; never a message, a path or a detail). */
const REASONS = {
  usage: "usage: --old-dist <merge-base dist> [--old-base <full sha>] [--live-db <path>]",
  not_in_worktree: "this dist is not under .worktrees/: run from the worktree, never build in the main checkout",
  old_dist_missing: "the old build's dist/ does not exist (build the base worktree)",
  live_db_missing: "the live DB was not found (--live-db <path>)",
  tombstone_present: "a houge.kill tombstone already exists: refusing to run",
  vacuum_failed: "VACUUM INTO of the live DB failed",
  fixture_unreadable: "the catalog fixture could not be read or parsed",
  export_missing: "a module or export the check drives is missing from a dist: rebuild",
  seed_failed: "this build did not produce the post-slice state the check needs (change_log rows, a retired judges:2 override)",
  unexpected: "an unexpected setup error (detail withheld)"
};
class Setup extends Error { constructor(code) { super(code); this.code = code; } }
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError", "AbortError"]);
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");

function vacuumInto(from, to) {
  for (let n = 1; ; n++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (n >= 5 || !/locked|busy/i.test(String(e))) throw new Setup("vacuum_failed"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
function openStore(d, path) { const store = d.RunStore.open(path, d.storeOptionsFor(undefined, {})); handles.push(store); return store; }
const closeStore = (s) => { try { s.close(); } catch { /* a closed handle is not a finding */ } };
const ro = (path, fn) => { const db = new DatabaseSync(path, { readOnly: true }); try { return fn(db); } finally { db.close(); } };
const changeLogOf = (path) => ro(path, (db) => db.prepare("SELECT change_id, topic, idempotency_key, text, created_at FROM change_log ORDER BY change_id").all().map((r) => ({ ...r })));
const outboxN = (store) => store.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get().n;
const stubProbe = async () => ({ result: "pass", kind: "ok" });
const resolverOf = (d, store, catalog) => new d.RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog });
const tickNowOf = (store) => { const last = store.latestModelRolesResolved(); return last ? new Date(Date.parse(last.resolved_at) + 25 * 3_600_000).toISOString() : new Date().toISOString(); };

// ---- this build writes F ----
/** The post-slice state: the legacy card override of judges:2, the new tick (adopts the new Gemini, retires the override, writes model_change rows), a log-kind incident row. */
async function seedF(ctx) {
  const s = openStore(ctx.dNew, ctx.F);
  try {
    const now = new Date().toISOString();
    const pro = s.listModelTiers().find((t) => t.tier === "gemini-pro");
    if (pro && (pro.adopted !== null || pro.previous !== null || pro.rejected_selector !== null)) {
      s.writeModelTier({ tier: "gemini-pro", adopted: null, previous: null, adopted_at: null, rejected_selector: null, rejected_at: null }, now);
    }
    s.recordModelProbe({ tier: "gemini-pro", selector: `${GOOGLE}/${ARGON}`, purpose: "tap", result: "pass", kind: "ok" });
    s.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "gate:rollback" });
    const roles = resolverOf(ctx.dNew, s, ctx.catalog);
    const tickNow = tickNowOf(s);
    await ctx.dNew.runRolesTick({ store: s, modelProbe: stubProbe }, { modelRoles: () => roles }, tickNow, STUB_CHAT, new AbortController().signal);
    ctx.dNew.openAlertedIncident(s, { kind: "decision_record_failed", subject: "rollback.gate", detail: {}, env: {} }); // a log kind, no chat: one change_log row
    const logs = s.db.prepare("SELECT topic FROM change_log").all().map((r) => r.topic);
    const pro2 = s.listModelTiers().find((t) => t.tier === "gemini-pro");
    const unresolved = s.listOpenIncidents().filter((i) => i.kind === "role_unresolved" && i.subject === "judges:2").length;
    if (!logs.includes("model_change") || !logs.includes("incident_log") || pro2?.adopted !== ARGON || s.latestModelRoleOverrides().has("judges:2") || unresolved !== 0) throw new Setup("seed_failed");
    return { tickNow, overrides: s.db.prepare("SELECT COUNT(*) AS n FROM ledger_events WHERE event_type = 'model_role_override'").get().n, tiers: s.listModelTiers().map((r) => ({ ...r })) };
  } finally { closeStore(s); }
}

// ---- the merge-base build on a copy ----
/** The old build opens `path`, reads what it reads, and returns the pieces to compare (no tick). */
async function oldOpens(ctx, path) {
  const s = openStore(ctx.dOld, path); // the old build's migrations run on the post-slice copy
  try {
    return { open: s.listOpenIncidents().length, overrides: [...s.latestModelRoleOverrides()].length, tiers: s.listModelTiers().length, outbox: outboxN(s), resolved: s.latestModelRolesResolved() !== undefined };
  } finally { closeStore(s); }
}
/** The old tick on F at the new row + 25 h, over the fixture catalog: the §10 residual. */
async function oldTick(ctx) {
  const s = openStore(ctx.dOld, ctx.F);
  try {
    const roles = resolverOf(ctx.dOld, s, ctx.catalog);
    const notes = []; const cards = []; const out0 = outboxN(s);
    const now = tickNowOf(s);
    const unresolvedBefore = s.listOpenIncidents().filter((i) => i.kind === "role_unresolved" && i.subject === "judges:2").length;
    const res = await ctx.tOld.runModelRolesTick({ store: s, roles, probe: stubProbe, now, notify: (t) => notes.push(t), card: (c) => cards.push(c) });
    const unresolvedAfter = s.listOpenIncidents().filter((i) => i.kind === "role_unresolved" && i.subject === "judges:2").length;
    const inc = s.listOpenIncidents().find((i) => i.kind === "role_unresolved" && i.subject === "judges:2");
    const pages = inc ? s.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE idempotency_key = ?").get(`incident_opened:${inc.incident_id}`).n : 0;
    return { res, notes: notes.length, cards, unresolvedBefore, unresolvedAfter, pages, outboxDelta: outboxN(s) - out0, pro: s.listModelTiers().find((t) => t.tier === "gemini-pro") };
  } finally { closeStore(s); }
}

async function setup() {
  if (!DIST.includes("/.worktrees/")) throw new Setup("not_in_worktree");
  const oldArg = arg("--old-dist");
  if (oldArg === undefined) throw new Setup("usage");
  const baseArg = arg("--old-base");
  if (baseArg !== undefined && !/^[0-9a-f]{40}$/.test(baseArg)) throw new Setup("usage");
  const oldDist = resolve(oldArg);
  if (!existsSync(oldDist)) throw new Setup("old_dist_missing");
  let base;
  try { base = mergeBaseOf(DIST, baseArg); } catch (e) { throw new SetupError(provenanceText(e)); }
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new Setup("live_db_missing");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new Setup("tombstone_present");
  let prov;
  try { prov = verifyOldDist(oldDist, DIST, base, "omp/model-roles-tick.js"); } catch { throw new SetupError("provenance: the old dist is not the merge-base build"); }
  console.log(`old build pinned to base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, old/new tick module ${prov.oldHash}/${prov.newHash}`);
  const root = initTemp(false);
  for (const k of [...SET_PINS, ...DELETE_PINS]) saved[k] = process.env[k];
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID", ...DELETE_PINS]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-rollback/omp", HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_ENABLED: "0", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  const mods = async (dist) => {
    const [store, so, roles, cat, tick] = await Promise.all(["run/run-store.js", "run/store-options.js", "omp/role-resolver.js", "omp/model-catalog.js", "omp/model-roles-tick.js"].map((m) => import(join(dist, m))));
    return { RunStore: store.RunStore, storeOptionsFor: so.storeOptionsFor, RoleResolver: roles.RoleResolver, parseOmpCatalog: cat.parseOmpCatalog, runModelRolesTick: tick.runModelRolesTick };
  };
  const [dNew, dOld] = [await mods(DIST), await mods(oldDist)];
  const [inc, daemon] = await Promise.all([import(join(DIST, "run/incident-alert.js")), import(join(DIST, "telegram/telegram-daemon.js"))]);
  Object.assign(dNew, { openAlertedIncident: inc.openAlertedIncident, runRolesTick: daemon.runRolesTick });
  for (const k of ["RunStore", "storeOptionsFor", "RoleResolver", "parseOmpCatalog", "runModelRolesTick", "openAlertedIncident", "runRolesTick"]) if (!dNew[k]) throw new Setup("export_missing");
  for (const k of ["RunStore", "RoleResolver", "parseOmpCatalog", "runModelRolesTick"]) if (!dOld[k]) throw new Setup("export_missing");
  if (!dOld.storeOptionsFor) dOld.storeOptionsFor = () => ({}); // a base that predates store-options
  let catalog;
  try { catalog = dNew.parseOmpCatalog(readFileSync(FIXTURE, "utf8")); } catch { catalog = null; }
  if (!catalog) throw new Setup("fixture_unreadable");
  const A = join(mkTemp("copy-A"), "houge.sqlite"); const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, A);
  vacuumInto(A, F); // F is cut from A, so a daemon write between two live reads cannot separate them
  return { dNew, dOld, tOld: { runModelRolesTick: dOld.runModelRolesTick }, catalog, A, F, root };
}

async function run(ctx) {
  const { A, F } = ctx;
  phase = "seed F"; const seed = await seedF(ctx);
  const logsF = changeLogOf(F);
  check("seeded — this build wrote the post-slice state to F: change_log rows (model_change and incident_log), gemini-pro adopted, the legacy judges:2 override retired, no role_unresolved for judges:2",
    logsF.length >= 2, `change_log rows ${logsF.length}`);
  phase = "old build on A"; const oa = await oldOpens(ctx, A);
  phase = "old build on F"; const of = await oldOpens(ctx, F);
  check("old_opens_and_reads — the merge-base build opens the post-slice copy F and A without throwing and reads incidents, overrides and tiers",
    typeof of.open === "number" && typeof oa.open === "number" && of.tiers >= 1 && of.resolved === true, `F: open incidents ${of.open}, overrides ${of.overrides}, tiers ${of.tiers} · A: open incidents ${oa.open}`);
  check("change_log_untouched — the old build ignored change_log: every row on F is byte-equal after the old build opened it (no data loss)",
    J(changeLogOf(F)) === J(logsF), `rows ${changeLogOf(F).length} (was ${logsF.length})`);
  phase = "old tick on F"; const tk = await oldTick(ctx);
  check("residual_role_unresolved_reopens — the old runModelRolesTick on F (now = the new row + 25 h, fixture catalog): no crash, gemini-pro has no member under the old pattern, so judges:2 reopens role_unresolved (none was open before) and pages",
    tk.res.ran === true && tk.unresolvedBefore === 0 && tk.unresolvedAfter === 1 && tk.pages === 1, `ran ${tk.res.ran} · judges:2 role_unresolved ${tk.unresolvedBefore} → ${tk.unresolvedAfter} · pages for that incident in outbox ${tk.pages} · gemini-pro adopted ${tk.pro?.adopted === null ? "null" : "set"}`);
  check("residual_card_returns — the same old tick offers the empty-tier card for gemini-pro naming judges:2 (a re-tap or /models set restores it)",
    tk.cards.length === 1 && tk.cards[0].tier === "gemini-pro" && tk.cards[0].keys.includes("judges:2"), `cards ${tk.cards.length}`);
  check("old_notices_go_to_chat — the old tick reports the head change through its notify (the old daemon enqueues it to chat again), and writes no change_log row",
    tk.notes >= 1 && J(changeLogOf(F)) === J(logsF), `notices ${tk.notes} · change_log rows ${changeLogOf(F).length} (want ${logsF.length})`);
  phase = "reopen F"; const s = openStore(ctx.dNew, F);
  let reopen;
  try { reopen = { logs: s.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n, tiers: s.listModelTiers().length, seeded: seed.tiers.length }; } finally { closeStore(s); }
  check("new_reopens — this build reopens F after the old build wrote to it: no throw, change_log rows intact, tiers readable",
    reopen.logs === logsF.length && reopen.tiers === reopen.seeded, `change_log ${reopen.logs} (was ${logsF.length}) · tiers ${reopen.tiers}`);
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
