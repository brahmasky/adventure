#!/usr/bin/env node
// Rollback check — memory write (spec 2026-10-15 §11; plan 2026-10-17 Task 16).
//
//   From the feature worktree, after `npm run build` there:
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-memory-write-rollback.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/memory-write-base/dist [--old-base <sha>] [--db <path>] [--keep]
//
// A VACUUM copy of the live DB is migrated by the new build, which seeds, in a gate-only chat with synthetic text:
// production-shaped retire and correct rows (as memory_correct writes them), then — in ONE transaction — an explicit
// fact ADD and a SUPERSEDE with their `add` Undo rows, as the memory write does. The previous build opens the copy (its
// CREATE TABLE IF NOT EXISTS is a no-op on the rebuilt table) and Paco's Undo taps go through ITS gateway handler: every
// change undone as its own code reads it. Exit 0 PASS · 1 FAIL · 2 setup error. The temp copy is deleted unless --keep.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { verifyOldDist } from "./old-dist-provenance.mjs";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const CHAT = "-100rollbackcheck";
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const temp = { root: null, keep: false };
const cleanup = () => { if (temp.root && !temp.keep) rmSync(temp.root, { recursive: true, force: true }); else if (temp.root) console.log(`temp dir kept (holds a live-DB copy): ${temp.root}`); temp.root = null; };
const load = async (dist, ps) => Object.assign({}, ...(await Promise.all(ps.map((p) => import(join(dist, p))))));

function parseArgs(argv) {
  const a = { oldDist: null, oldBase: null, db: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist") a.oldDist = resolve(argv[++i]); else if (argv[i] === "--old-base") a.oldBase = argv[++i];
    else if (argv[i] === "--db") a.db = resolve(argv[++i]); else if (argv[i] === "--keep") a.keep = true; else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!NEW_DIST.includes("/.worktrees/")) throw new Error(`run from the feature worktree (this dist is ${NEW_DIST})`);
  if (!a.oldDist || !existsSync(join(a.oldDist, "gateway/memory-commands.js"))) throw new Error("--old-dist <previous build's dist> is required");
  a.oldBase ??= execFileSync("git", ["merge-base", "main", "HEAD"], { encoding: "utf8" }).trim();
  const prov = verifyOldDist(a.oldDist, NEW_DIST, a.oldBase);
  console.log(`old build: worktree HEAD ${prov.head.slice(0, 12)} (base ${a.oldBase.slice(0, 12)}), core-worker.js ${prov.oldHash} (new ${prov.newHash})`);
  return a;
}

function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/** The new build migrates, then seeds: a retire and a correct (memory_correct's own calls), then ADD + SUPERSEDE in one transaction. */
function seedNew(RunStore, path) {
  const s = RunStore.open(path);
  try {
    const now = new Date().toISOString();
    const fact = (t) => s.addEpisodicFact({ chat_id: CHAT, fact: `rollback check: ${t}`, created_at: now });
    const retired = fact("retired by memory_correct");
    const corrected = fact("corrected by memory_correct");
    const retire = s.retireMemoryRows({ kind: "fact", ids: [retired], chat_id: CHAT, run_id: null, now });
    const correct = s.correctEpisodicFacts({ ids: [corrected], correction: "rollback check: the corrected value", chat_id: CHAT, run_id: null, now });
    const saves = s.inTransaction(() => {
      const added = fact("an explicit add");
      const old = fact("the old value");
      const sup = s.saveReconciledFact({ chat_id: CHAT, fact: "rollback check: the new value", source_turn_ids: [] }, { verdict: "SUPERSEDE", id: old }, now);
      const add = s.insertFactAddChange({ new_id: added, superseded_id: null, pruned_ids: [], run_id: "run_rollback_check", chat_id: CHAT, now });
      const supc = s.insertFactAddChange({ new_id: sup.id, superseded_id: old, pruned_ids: sup.prunedIds, run_id: "run_rollback_check", chat_id: CHAT, now });
      s.insertMemorySaveTrigger("run_rollback_check", ["fact"], now);
      return { add: add.change_id, sup: supc.change_id, ids: { added, old, sup: sup.id } };
    });
    return { retire: { change_id: retire.change_id, id: retired }, correct: { change_id: correct.change_id, id: corrected, new_id: correct.new_id }, ...saves };
  } finally { s.close(); }
}

/** The rebuilt schema, read directly: `add` in the CHECK, the pruned_ids column, and the trigger table with its three columns. */
function schemaOf(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_changes'`).get()?.sql ?? "";
    const trig = db.prepare(`PRAGMA table_info(memory_save_triggers)`).all().map((c) => c.name);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM memory_save_triggers WHERE run_id = 'run_rollback_check'`).get().n;
    return { add: sql.includes("'add'"), pruned: sql.includes("pruned_ids"), triggers: trig.join(","), triggerRows: rows };
  } finally { db.close(); }
}

/** Paco's Undo tap through the OLD build's gateway handler. */
function tapOld(old, store, change_id, key) {
  return old.handleMemoryUndo(store, old.buildTypedTaskEvent({ source: "telegram", type: "memory_undo", requested_by: { kind: "user", id: "rollback" },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: key, source_reference: key, metadata: { telegram_update_id: 1, telegram_callback_id: key, change_id } }));
}

function undoOnOld(old, path, seed) {
  const s = old.RunStore.open(path);
  try {
    const st = (id) => s.getEpisodicFact(id)?.status;
    for (const [k, c] of [["add", seed.add], ["sup", seed.sup], ["retire", seed.retire.change_id], ["correct", seed.correct.change_id]]) {
      const r = tapOld(old, s, c, `rollback:${k}`);
      check(`old build's gateway Undo on ${k} returns ok`, r.ok === true, JSON.stringify(r));
    }
    check("ADD undone by the old build: the new fact pruned", st(seed.ids.added) === "pruned");
    check("SUPERSEDE undone by the old build: new pruned, old restored", st(seed.ids.sup) === "pruned" && st(seed.ids.old) === "active");
    check("retire undone by the old build: the fact active again", st(seed.retire.id) === "active");
    check("correct undone by the old build: old active, correction pruned", st(seed.correct.id) === "active" && st(seed.correct.new_id) === "pruned");
    check("a second tap on the old build changes nothing", tapOld(old, s, seed.add, "rollback:again").ok === true && s.getMemoryChange(seed.add)?.undone_at !== null);
  } finally { s.close(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const neu = await load(NEW_DIST, ["run/run-store.js", "config/load-env.js"]);
  neu.loadHougeEnv();
  const live = resolve(args.db ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  const base = join(homedir(), "Library/Caches/houge-daemon"); mkdirSync(base, { recursive: true });
  temp.root = mkdtempSync(join(base, "mwrb-")); temp.keep = args.keep;
  const path = join(temp.root, "copy.sqlite");
  copyDb(live, path);
  const seed = seedNew(neu.RunStore, path);
  const before = schemaOf(path);
  check("the new build migrated the copy: 'add' and pruned_ids in memory_changes", before.add && before.pruned);
  check("memory_save_triggers exists with run_id, kinds, created_at and holds the seeded row", before.triggers === "run_id,kinds,created_at" && before.triggerRows === 1, JSON.stringify(before));
  try {
    undoOnOld(await load(args.oldDist, ["run/run-store.js", "gateway/memory-commands.js", "domain/types.js"]), path, seed);
  } catch (e) {
    check("the previous build boots on the migrated copy", false, e instanceof Error ? e.message : String(e));
  }
  check("the previous build left the rebuilt schema in place", schemaOf(path).add);
  try { neu.RunStore.open(path).close(); check("the new build reopens the copy afterwards", true); }
  catch (e) { check("the new build reopens the copy afterwards", false, e instanceof Error ? e.message : String(e)); }
  console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
  return failures.length === 0 ? 0 : 1;
}

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(sig, () => { cleanup(); process.exit(code); });
main().then((c) => { cleanup(); process.exit(c); }, (e) => { console.error(`rollback check setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); cleanup(); process.exit(2); });
