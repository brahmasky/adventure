#!/usr/bin/env node
// Rollback check — decision ladder stage 2b-i (spec 2026-10-19 §7; plan Task 13).
//
//   From the feature worktree, after `npm run build` there:
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-ladder-2b-hooks-rollback.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/ladder-2b-base/dist [--old-base <sha>] [--db <path>] \
//     [--session-dir <kept gate run>/case-<6|3>-<n>/data/omp/sessions/chat--4200] [--keep]   (run once per kind: todo calls, a continuation leg)
//
// No migration ships in 2b-i; the new rows are what a rollback must survive. A VACUUM copy of the live DB is opened by the
// new build, which seeds in one transaction: a turn.settle decision with its three outcomes (settle_sent_back,
// settle_unverified, settle_discarded), a tool.injection row recorded `late`, and a tool_finished builtin:todo on a completed
// run. The previous build then opens the copy (its migrations run), renders `/status decisions` and the digest over those
// rows, and runs its invariant detection. With --session-dir (a kept gate run's transcript: case 6's todo calls, or case
// 3's continuation leg; used IN PLACE, since omp resumes only from the cwd the transcript records, and the turn appends to the
// kept gate dir), the previous build's CoreWorker resumes that transcript on the real omp and answers one turn; resume
// is proved from the directory itself (no new session file; the newest one grew). The new build reopens the copy last.
// Exit 0 PASS · 1 FAIL · 2 setup error · 3 INCONCLUSIVE (no --session-dir, or omp unavailable). The temp root is deleted
// unless --keep. Never opens the live DB for writing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { verifyOldDist } from "./old-dist-provenance.mjs";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const CHAT = "-4200";
const failures = []; const inconclusive = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const cannotRun = (name, why) => { console.log(`INCONCLUSIVE ${name} — ${why}`); inconclusive.push(`${name}: ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = { root: null, keep: false };
const cleanup = () => { if (temp.root && !temp.keep) rmSync(temp.root, { recursive: true, force: true }); else if (temp.root) console.log(`temp dir kept (holds a live-DB copy): ${temp.root}`); temp.root = null; };
const load = async (dist, ps) => Object.assign({}, ...(await Promise.all(ps.map((p) => import(join(dist, p))))));
const msg = (e) => (e instanceof Error ? e.message : String(e));

function parseArgs(argv) {
  const a = { oldDist: null, oldBase: null, db: null, sessionDir: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist") a.oldDist = resolve(argv[++i]); else if (argv[i] === "--old-base") a.oldBase = argv[++i];
    else if (argv[i] === "--db") a.db = resolve(argv[++i]); else if (argv[i] === "--session-dir") a.sessionDir = resolve(argv[++i]);
    else if (argv[i] === "--keep") a.keep = true; else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!NEW_DIST.includes("/.worktrees/")) throw new Error(`run from the feature worktree (this dist is ${NEW_DIST})`);
  if (!a.oldDist || !existsSync(join(a.oldDist, "core/core-worker.js"))) throw new Error("--old-dist <previous build's dist> is required");
  a.oldBase ??= execFileSync("git", ["merge-base", "main", "HEAD"], { encoding: "utf8" }).trim();
  if (!a.oldBase) throw new Error("--old-base must be a non-empty commit");
  const prov = verifyOldDist(a.oldDist, NEW_DIST, a.oldBase);
  if (existsSync(join(a.oldDist, "omp/settle-judge.js")) || existsSync(join(a.oldDist, "omp/extension/settle-hook.js"))) throw new Error("--old-dist contains the 2b-i code: it is not the previous build");
  if (a.sessionDir && !existsSync(a.sessionDir)) throw new Error(`--session-dir ${a.sessionDir} does not exist`);
  console.log(`old build: worktree HEAD ${prov.head.slice(0, 12)} (base ${a.oldBase.slice(0, 12)}), core-worker.js ${prov.oldHash} (new ${prov.newHash})`);
  return a;
}

/** The live DB is in use by the daemon: a VACUUM INTO that meets its write lock is retried (5 × 1 s) before it is a setup error. */
function copyDb(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(msg(e))) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000); }
    finally { src.close(); }
  }
}

function isolate(root) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  Object.assign(process.env, { HOUGE_TELEGRAM_CHAT_ID: CHAT, HOUGE_LESSON_SESSION_RESET: "0", HOUGE_JEV_TRIAGE_ENABLED: "off",
    HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_DAEMON_TMP_DIR: join(root, "daemon-tmp"),
    HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"), HOUGE_DISARM_PATH: join(root, "houge.disarm") });
}

function intake(m, store, dataDir, goal, key) {
  const r = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir }).intake(m.buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal, requested_by: { kind: "user", id: "rollback" }, notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: `rollback2b:${key}`, source_reference: `rollback2b:${key}` }));
  if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
  return r.run_id;
}

/** Step 1, the new build: a completed run, then in ONE transaction its todo row, a turn.settle row with three outcomes, a late tool.injection row. */
function seedNew(m, path, root) {
  const s = m.RunStore.open(path);
  try {
    const run = intake(m, s, root, "rollback check 2b", `seed:${Date.now()}`);
    s.claimRun(run, "rollback-2b", 60);
    if (!s.finishRun({ run_id: run, expected_worker_id: "rollback-2b", next: "completed", report_ref: "runs/rollback-check-2b.md", duration_ms: 1, tool_calls: 1 })) throw new Error("the seed run did not complete");
    const ids = s.inTransaction(() => {
      s.appendRunLedgerEvent(run, "tool_finished", "capability_runner", { tool_call_id: "rb-todo", tool: "builtin:todo", status: "succeeded", output_hash: "", duration_ms: 1, bytes_out: 12 });
      const settle = s.insertDecision({ entry_id: "turn.settle", entry_version: 1, run_id: run, tool_call_id: null, stage: "settle", rung: "rule", verdict: "send_back",
        p: null, reason_code: "claim_scheduled", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 3 });
      for (const [signal, value] of [["settle_sent_back", "claim_scheduled"], ["settle_unverified", "claim_scheduled"], ["settle_discarded", "signal"]]) s.insertDecisionOutcome({ decision_id: settle, signal, value, source: "code" });
      const inj = s.insertDecision({ entry_id: "tool.injection", entry_version: 1, run_id: run, tool_call_id: "rb-read", stage: "post_tool", rung: "system_one", verdict: "pass",
        p: 0.02, reason_code: "jev_passed", fallback_reason: null, fallback_rung: null, armed_mode: "late", latency_ms: 250 });
      return { settle, inj };
    });
    return { run, ...ids };
  } finally { s.close(); }
}

function seeded(path, seed) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    return { settle: one(`SELECT entry_id FROM decisions WHERE decision_id = ?`, seed.settle)?.entry_id, late: one(`SELECT armed_mode FROM decisions WHERE decision_id = ?`, seed.inj)?.armed_mode,
      outcomes: db.prepare(`SELECT signal FROM decision_outcomes WHERE decision_id = ? ORDER BY signal`).all(seed.settle).map((r) => r.signal).join(","),
      todo: one(`SELECT COUNT(*) AS n FROM ledger_events WHERE run_id = ? AND event_type = 'tool_finished' AND json_extract(payload_json, '$.tool') = 'builtin:todo'`, seed.run).n,
      state: one(`SELECT state FROM runs WHERE run_id = ?`, seed.run)?.state };
  } finally { db.close(); }
}

/** Step 2, the previous build: its migrations, its `/status decisions` and digest over the new rows, its invariant detection. */
/** The previous build's invariant detection, as distinct violation kinds (names only; subjects can carry ids). */
const violationKinds = (old, store) => [...new Set(old.detectViolations(store, new Date().toISOString()).map((v) => v.kind))].sort();
/** Review I4: the same detection on an unseeded copy, so a kind the 2b-i rows cause is told from one the live data already has. */
function baselineKinds(old, path) { const s = old.RunStore.open(path); try { return violationKinds(old, s); } finally { s.close(); } }

function oldReads(old, path, seed, baseline) {
  const s = old.RunStore.open(path);
  try {
    check("the previous build opens the copy (its migrations ran)", true);
    let list = "";
    try { list = old.decisionListText(s, process.env); check("the previous build's /status decisions renders", true); } catch (e) { check("the previous build's /status decisions renders", false, msg(e)); }
    check("/status decisions names the turn.settle row by id", list.includes("turn.settle"), list.split("\n").filter((l) => l.includes("turn.settle")).length + " line(s)");
    try {
      const d = old.buildDecisionDigest(s, new Date().toISOString(), process.env);
      // review I4: a null digest proves nothing about rendering the new rows
      if (!d) cannotRun("the previous build's digest names the turn.settle rows", "no digest was due on the copy");
      else check("the previous build's digest renders and names the turn.settle rows", d.text.includes("turn.settle"), `${d.text.length} chars`);
    } catch (e) { check("the previous build's digest renders and names the turn.settle rows", false, msg(e)); }
    try {
      const kinds = violationKinds(old, s); const added = kinds.filter((k) => !baseline.includes(k));
      check("the previous build's invariant detection raises no violation kind the seeded rows caused", added.length === 0, `now [${kinds.join(", ") || "none"}] · baseline [${baseline.join(", ") || "none"}] · added [${added.join(", ") || "none"}]`);
    } catch (e) { check("the previous build's invariant detection raises no violation kind the seeded rows caused", false, msg(e)); }
    check("the previous build reads the seeded completed run", s.getRunState(seed.run) === "completed", s.getRunState(seed.run));
  } finally { s.close(); }
}

const jsonls = (dir) => readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
function newestOf(dir) { return jsonls(dir).map((f) => ({ f, size: statSync(join(dir, f)).size, mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]; }
async function waitEnd(store, run, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const st = store.getRunState(run); if (st === "completed" || st === "failed") return st; await sleep(500); }
  return "timeout";
}

/** Step 3, the previous build's supervisor and extension resume the gate's transcript (todo calls, a continuation leg) and answer one turn. */
async function oldResume(old, path, args) {
  if (!args.sessionDir) return cannotRun("the previous build resumes a 2b-i transcript", "no --session-dir (pass a kept gate run's case-6 or case-3 chat--4200 directory)");
  try { execFileSync("omp", ["--version"], { stdio: "pipe" }); } catch { return cannotRun("the previous build resumes a 2b-i transcript", "omp is unavailable"); }
  // In place, not copied: omp resumes a transcript only from the cwd its session header records (the gate's workspace);
  // a copy under another data dir opens a fresh session on the new build and the old alike (control run 2026-10-20).
  const dir = args.sessionDir; const data = resolve(dir, "..", "..", "..");
  if (!/^\/(private\/)?tmp\/hg-2b-[^/]+\//.test(realpathSync(dir)) || dir !== join(data, "omp", "sessions", `chat-${CHAT}`)) {
    throw new Error(`--session-dir must be a kept gate run's <root>/case-<tag>-<n>/data/omp/sessions/chat-${CHAT} (it is used in place): ${dir}`);
  }
  const before = jsonls(dir); const newest = newestOf(dir);
  if (!newest) return cannotRun("the previous build resumes a 2b-i transcript", "the session dir holds no transcript");
  const text = readFileSync(join(dir, newest.f), "utf8");
  // what 2b-i adds to a transcript: todo calls (case 6) and a continuation leg carrying the settle note (cases 3 and 5); one
  // gate case rarely leaves both, so the check runs once per kind of --session-dir and names which this run covered
  const todo = text.includes('"toolName":"todo"') || text.includes('"name":"todo"');
  const continuation = text.includes("Your reply will replace the previous one: restate your complete final answer.");
  if (!todo && !continuation) return cannotRun("the previous build resumes a 2b-i transcript", `the transcript ${newest.f} holds neither a todo call nor a continuation leg`);
  console.log(`  transcript ${newest.f}: ${newest.size} bytes; todo call: ${todo}; continuation leg: ${continuation}`);
  const s = old.RunStore.open(path);
  const worker = new old.CoreWorker(s, dirname(args.oldDist), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { dataDir: data, distDir: args.oldDist });
  try {
    const run = intake(old, s, data, "ok", `resume:${Date.now()}`);
    worker.submitTurn(run);
    const state = await waitEnd(s, run, 300_000);
    const assistant = new DatabaseSync(path, { readOnly: true });
    let n = 0; try { n = assistant.prepare(`SELECT COUNT(*) AS n FROM chat_turns WHERE run_id = ? AND role = 'assistant'`).get(run).n; } finally { assistant.close(); }
    const trace = s.getLedgerEvents(run).map((e) => (e.event_type === "run_failed" ? `run_failed(${e.payload.error_type}:${e.payload.error_ref ?? ""})` : e.event_type)).join(" ");
    check("the previous build answers a turn on the resumed transcript (run completed, one assistant chat turn)", state === "completed" && n === 1, `${state}, ${n} assistant turn(s)${state === "completed" ? "" : ` · ${trace}`}`);
    const after = newestOf(dir);
    check("no new session file: the previous build resumed the transcript", JSON.stringify(jsonls(dir)) === JSON.stringify(before), `${before.length} → ${jsonls(dir).length} file(s)`);
    check("the resumed transcript grew by the appended turn", after?.f === newest.f && after.size > newest.size, `${newest.f} ${newest.size} → ${after?.f} ${after?.size} bytes`);
  } finally { await worker.shutdownPlanners?.(); s.close(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const neu = await load(NEW_DIST, ["run/run-store.js", "config/load-env.js", "gateway/gateway.js", "domain/types.js", "decisions/status-view.js"]);
  neu.loadHougeEnv();
  const live = resolve(args.db ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  temp.root = mkdtempSync("/tmp/hg-2b-rb-"); temp.keep = args.keep;
  isolate(temp.root); mkdirSync(join(temp.root, "daemon-tmp"), { recursive: true });
  const path = join(temp.root, "copy.sqlite"); const basePath = join(temp.root, "baseline.sqlite");
  copyDb(live, path); copyDb(live, basePath);
  const seed = seedNew(neu, path, temp.root);
  const s1 = seeded(path, seed);
  check("the new build seeded the rows (turn.settle + 3 outcomes, a late tool.injection, a builtin:todo on a completed run)",
    s1.settle === "turn.settle" && s1.outcomes === "settle_discarded,settle_sent_back,settle_unverified" && s1.late === "late" && s1.todo === 1 && s1.state === "completed", JSON.stringify(s1));
  const old = await load(args.oldDist, ["run/run-store.js", "core/core-worker.js", "gateway/gateway.js", "domain/types.js", "decisions/status-view.js", "decisions/digest.js", "run/invariant-sweep.js"]);
  let baseline = [];
  try { baseline = baselineKinds(old, basePath); } catch (e) { check("the previous build's invariant detection runs on the unseeded baseline copy", false, msg(e)); }
  try { oldReads(old, path, seed, baseline); } catch (e) { check("the previous build boots on the copy", false, msg(e)); }
  try { await oldResume(old, path, args); } catch (e) { check("the previous build resumes a 2b-i transcript", false, msg(e)); }
  check("the previous build left the seeded rows in place", JSON.stringify(seeded(path, seed)) === JSON.stringify(s1));
  try { const s = neu.RunStore.open(path); try { check("the new build reopens the copy afterwards", neu.decisionListText(s, process.env).includes("turn.settle")); } finally { s.close(); } }
  catch (e) { check("the new build reopens the copy afterwards", false, msg(e)); }
  const status = failures.length > 0 ? "FAIL" : inconclusive.length > 0 ? "INCONCLUSIVE" : "PASS";
  console.log(status === "FAIL" ? `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}` : `\nROLLBACK CHECK: ${status}${inconclusive.length ? `\n  - ${inconclusive.join("\n  - ")}` : ""}`);
  return status === "PASS" ? 0 : status === "FAIL" ? 1 : 3;
}

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { cleanup(); process.exit(code); });
main().then((c) => { cleanup(); process.exit(c); }, (e) => { console.error(`rollback check setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); cleanup(); process.exit(2); });
