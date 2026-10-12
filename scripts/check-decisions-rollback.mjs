#!/usr/bin/env node
// R13 rollback check — decision ladder stage 1 (spec 2026-10-12 §5.4; plan Task 13).
//
//   From the feature worktree, after `npm run build` there (never in the main checkout):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-decisions-rollback.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/p6-base/dist [--db <path>] [--keep]
//
// Rollback is "revert, rebuild, kickstart" only while every migration is additive. This proves it on real data: a VACUUM
// copy of the live DB is migrated by the new build; then the previous build (3bff437) opens it — its migrations run, a
// triage turn settles (Jev unreachable: a skipped row and a verdict, no network, no egress), its invariant sweep runs —
// and the new build reopens it afterwards. Exit: 0 PASS · 1 FAIL · 2 setup error. Never opens the live DB for writing.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const load = async (dist, paths) => Object.assign({}, ...(await Promise.all(paths.map((p) => import(join(dist, p))))));
const LADDER_TABLES = ["decisions", "decision_outcomes", "ladder_moves", "decision_digests"];

function parseArgs(argv) {
  const a = { oldDist: null, db: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist") a.oldDist = resolve(argv[++i]);
    else if (argv[i] === "--db") a.db = resolve(argv[++i]);
    else if (argv[i] === "--keep") a.keep = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!NEW_DIST.includes("/.worktrees/")) throw new Error(`run from the feature worktree (this dist is ${NEW_DIST}); never build in the main checkout`);
  if (!a.oldDist || !existsSync(join(a.oldDist, "core/core-worker.js"))) throw new Error("--old-dist <previous build's dist> is required");
  return a;
}

function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/** The ladder's additive schema: its four tables and both link columns. */
function hasLadder(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    return LADDER_TABLES.every((t) => tables.includes(t)) && cols("jev_verdicts").includes("decision_id") && cols("jev_decisions").includes("ladder_decision_id");
  } finally { db.close(); }
}

/** No Telegram, disarm flags off, markers in the temp root, Jev armed but unreachable (a dummy key; jevFetch throws). */
function isolate(root, disarmFlags) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID", "HOUGE_JEV_CALIBRATION_FILE", "HOUGE_JEV_GATE"]) delete process.env[k];
  for (const f of disarmFlags) process.env[f] = "false";
  Object.assign(process.env, {
    HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"), HOUGE_DISARM_PATH: join(root, "houge.disarm"),
    HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed"), HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false",
    HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", TYPESAFE_API_KEY: "rollback-check"
  });
}

/** The previous build on the migrated copy: its migrations (on open), one triage turn through its CoreWorker, its sweep. */
async function bootOld(m, path, dist, root) {
  const store = m.RunStore.open(path);
  try {
    const dir = join(root, "old"); mkdirSync(join(dir, "project"), { recursive: true });
    const stub = async () => ({ ok: false, error: "rollback check" });
    const worker = new m.CoreWorker(store, join(dir, "project"), stub, stub, undefined, undefined, stub, undefined, undefined, async () => null, undefined, undefined,
      { dataDir: dir, distDir: dist, jevFetch: async () => { throw new TypeError("rollback check: no network"); } });
    const r = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir }).intake(m.buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: "rollback check", requested_by: { kind: "user", id: "rb" }, notify: { kind: "telegram", chat_id: "rb" },
      idempotency_key: "telegram:rollback-check:1", source_reference: "telegram:update:rollback-check:message:1", metadata: { telegram_update_id: 1, telegram_message_id: 1 } }));
    if (!r.ok || r.status !== "created") throw new Error(`the previous build refused the turn: ${JSON.stringify(r)}`);
    const claim = store.claimRun(r.run_id, "rb", 120);
    worker.buildOmpTools(claim, "rb");
    await worker.triageTurn({ claim, text: "rollback check", userText: "rollback check", modality: "text", posture: null, signal: new AbortController().signal });
    return { verdict: store.getJevVerdictForRun(r.run_id), violations: m.detectViolations(store, new Date().toISOString()).length };
  } finally { store.close(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const newMods = await load(NEW_DIST, ["run/run-store.js", "config/load-env.js", "config/disarm-posture.js"]);
  newMods.loadHougeEnv();
  const live = resolve(args.db ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  const root = mkdtempSync("/tmp/hg-rb-");
  isolate(root, newMods.DISARM_FLAGS);
  const path = join(root, "copy.sqlite");
  copyDb(live, path);
  newMods.RunStore.open(path).close();
  check("the new build migrated the copy (four ladder tables, two link columns)", hasLadder(path));
  const oldMods = await load(args.oldDist, ["core/core-worker.js", "gateway/gateway.js", "run/run-store.js", "domain/types.js", "run/invariant-sweep.js"]);
  try {
    const old = await bootOld(oldMods, path, args.oldDist, root);
    check("the previous build boots on the migrated copy and settles a triage turn", old.verdict !== undefined,
      `verdict ${old.verdict ? `${old.verdict.lane}/${old.verdict.skip_reason ?? old.verdict.reason}` : "none"}; sweep ran (${old.violations} violation(s))`);
  } catch (e) {
    check("the previous build boots on the migrated copy and settles a triage turn", false, e instanceof Error ? e.message : String(e));
  }
  check("the previous build left the ladder's tables and link columns in place", hasLadder(path));
  try { newMods.RunStore.open(path).close(); check("the new build reopens the copy afterwards", true); }
  catch (e) { check("the new build reopens the copy afterwards", false, e instanceof Error ? e.message : String(e)); }
  console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
  if (args.keep || failures.length > 0) console.log(`temp dir kept: ${root}`); else rmSync(root, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`rollback check setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
