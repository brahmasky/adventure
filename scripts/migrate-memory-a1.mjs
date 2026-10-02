// One-off memory A1 migration (spec docs/superpowers/specs/2026-10-02-memory-a1-fixes-design.md §8).
//
//   HOUGE_ENV_FILE=/abs/.env node scripts/migrate-memory-a1.mjs [--apply | --revert] [--db <path>] [--plan <path>]
//
// Dry run by default: prints every before/after row and writes nothing to the live DB — it describes from a
// VACUUM INTO copy under $HOUGE_DAEMON_TMP_DIR/memory-a1 (removed after), because opening a store migrates its schema.
// --apply runs every step in ONE transaction; --revert undoes the last applied migration in ONE transaction (both open
// the real DB: they are writes). Re-running --apply after success is a no-op. Reads the untracked plan file
// (.superpowers/memory-a1/plan.json): the approved texts never enter the repo. The restored core row is embedded
// best-effort (local Ollama, computed before the transaction; NULL on failure, the daily backfill retries it).
// SQLite's default busy timeout applies: a concurrent daemon write fails loud (exit 1, rolled back), never silently.
//
// Operator order: (1) --apply with the daemon idle (no turn in flight); (2) build and kickstart the new daemon. The
// first turn after the kickstart starts one fresh planner session (the lesson set changed).
// --revert is valid only until the first real lesson or fact write touches a migrated row (a lesson reconcile, a
// fact distill or a memory_correct against one): it then refuses, and nothing is written.
// Build first (imports ../dist). Exit: 0 done/no-op · 1 apply or revert failed (rolled back) · 2 setup error.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function parseArgs(argv) {
  const args = { apply: false, revert: false, db: undefined, plan: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--revert") args.revert = true;
    else if (argv[i] === "--db") args.db = argv[++i];
    else if (argv[i] === "--plan") args.plan = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (args.apply && args.revert) throw new Error("--apply and --revert are exclusive");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [{ loadHougeEnv }, mig, { RunStore }, { resolveDaemonTmpDir }, { embedText, resolveEmbedConfig }] = await Promise.all([
    import("../dist/config/load-env.js"), import("../dist/run/memory-a1-migration.js"), import("../dist/run/run-store.js"),
    import("../dist/run/daemon-tmp.js"), import("../dist/llm/embeddings.js")
  ]);
  loadHougeEnv();
  if (!process.env.HOUGE_ENV_FILE && !args.db) throw new Error("set HOUGE_ENV_FILE (the daemon's .env) or pass --db <path>");
  const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env")));
  const dbPath = resolve(args.db ?? join(repo, "houge.sqlite"));
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath} (refusing to create one)`);
  // Revert needs neither the plan nor the chat id, so a bad plan can never block a rollback.
  const needsPlan = !args.revert;
  const chat = process.env.HOUGE_TELEGRAM_CHAT_ID?.trim();
  if (needsPlan && !chat) throw new Error("HOUGE_TELEGRAM_CHAT_ID is not set (point HOUGE_ENV_FILE at the daemon's .env)");
  const plan = needsPlan ? mig.parseMigrationPlan(JSON.parse(readFileSync(resolve(args.plan ?? join(repo, ".superpowers", "memory-a1", "plan.json")), "utf8"))) : null;
  const embedCfg = resolveEmbedConfig(process.env);
  const embedCore = () => mig.embedRestoredCore(plan, (t) => embedText(t, embedCfg), embedCfg.model);
  const dry = !args.apply && !args.revert;
  const snap = dry ? mig.snapshotForDryRun(dbPath, resolveDaemonTmpDir()) : null;
  try {
    const store = RunStore.open(snap ? snap.path : dbPath);
    try {
      return await run(mig, store, plan, chat, { ...args, embedCore });
    } finally {
      store.close();
    }
  } finally {
    snap?.cleanup();
  }
}

async function run(mig, store, plan, chat, args) {
  const now = new Date().toISOString();
  if (args.revert) {
    try {
      console.log(`reverted ${mig.revertMigration({ store, now })} step(s) in one transaction`);
      return 0;
    } catch (err) {
      console.error(`revert failed, nothing written: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  let status;
  try {
    status = mig.migrationStatus(store, plan, chat);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (status === "applied") {
    console.log("already applied — nothing to do");
    return 0;
  }
  for (const line of mig.describeMigration(store, plan)) console.log(line);
  if (!args.apply) {
    console.log("\ndry run (read from a copy): nothing written to the live DB (pass --apply)");
    return 0;
  }
  // only after the "already applied" check, and outside the transaction (the embed is an await on local Ollama)
  const coreEmbedding = await args.embedCore();
  try {
    const ctx = { store, plan, chat_id: chat, now, ...(coreEmbedding ? { coreEmbedding } : {}) };
    for (const s of mig.applyMigration(ctx)) console.log(`applied ${s.step}: ${JSON.stringify({ old_ids: s.old_ids, new_ids: s.new_ids })}`);
    if (plan.restore_core) console.log(`restored core row embedding: ${coreEmbedding ? "stored" : "unavailable (the daily backfill retries it)"}`);
    console.log("\nAPPLIED. Next: build and kickstart the new daemon. The first turn after the kickstart starts one fresh planner session.");
    console.log("--revert stays valid only until the first real lesson or fact write touches a migrated row.");
    return 0;
  } catch (err) {
    console.error(`apply failed, rolled back, nothing written: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(`setup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
