#!/usr/bin/env node
// Rollback check — decision ladder Stage 4A, standing approval (spec 2026-10-28 §5; plan Task 10).
//
//   From the feature worktree, after `npm run build` there:
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-standing-rollback.mjs \
//     --old-dist <a worktree at the merge base>/dist [--old-base <sha>] [--db <path>] \
//     [--session-dir <kept gate run>/case-<tag>-<n>/data/omp/sessions/chat--4200] [--keep]
//
// The migration is additive (standing_approvals, standing_uses); a rollback is revert + rebuild, and the previous build must
// never read the tables and keep asking. A VACUUM copy of the live DB is migrated by the new build, which seeds a granted
// standing row on a seeded schedule, the six standing_* events on a completed scheduled run, a tool.policy decision with
// reason "standing", and one real standing use. The previous build then opens the copy and renders /status decisions, the
// digest and /schedule, runs its invariant detection, makes a scheduled bridge call on the granted bytes (it must ask; the
// approval is resolved through its own gateway; no standing use appears), fires a schedule tick, and — with --session-dir —
// resumes a kept transcript on the real omp. The new build reopens the copy last. Exit 0 PASS · 1 FAIL · 2 setup error ·
// 3 INCONCLUSIVE (no --session-dir, or omp unavailable). The temp root is deleted unless --keep. Never opens
// the live DB for writing; never messages any chat (Telegram tokens deleted; nothing here constructs a Telegram client).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { verifyOldDist } from "./old-dist-provenance.mjs";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const CHAT = "-4200";
const OPERATOR = { kind: "user", id: "rollback" };
const CMD = "curl -s -m 10 -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post";
const failures = []; const inconclusive = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const cannotRun = (name, why) => { console.log(`INCONCLUSIVE ${name} — ${why}`); inconclusive.push(`${name}: ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = { root: null, keep: false };
const cleanup = () => { if (temp.root && !temp.keep) rmSync(temp.root, { recursive: true, force: true }); else if (temp.root) console.log(`temp dir kept (holds a live-DB copy): ${temp.root}`); temp.root = null; };
const load = async (dist, ps) => Object.assign({}, ...(await Promise.all(ps.map((p) => import(join(dist, p))))));
const msg = (e) => (e instanceof Error ? e.message : String(e));
const PASS_JUDGE = async (i) => ({ text: i.text, verdict: "pass", withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 0, unanswered: 0, skipped: false, blocked: null, decisionId: null, masked: 0 });

function parseArgs(argv) {
  const a = { oldDist: null, oldBase: null, db: null, sessionDir: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist") a.oldDist = resolve(argv[++i]); else if (argv[i] === "--old-base") a.oldBase = argv[++i];
    else if (argv[i] === "--db") a.db = resolve(argv[++i]); else if (argv[i] === "--session-dir") a.sessionDir = resolve(argv[++i]);
    else if (argv[i] === "--keep") a.keep = true; else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!NEW_DIST.includes("/.worktrees/")) throw new Error(`run from the feature worktree (this dist is ${NEW_DIST})`);
  if (!a.oldDist || !existsSync(join(a.oldDist, "omp/bridge-handler.js"))) throw new Error("--old-dist <previous build's dist> is required");
  a.oldBase ??= execFileSync("git", ["merge-base", "main", "HEAD"], { encoding: "utf8" }).trim();
  if (!a.oldBase) throw new Error("--old-base must be a non-empty commit");
  const prov = verifyOldDist(a.oldDist, NEW_DIST, a.oldBase, "omp/bridge-handler.js");
  if (existsSync(join(a.oldDist, "decisions/standing-approval.js"))) throw new Error("--old-dist contains the Stage 4A code: it is not the previous build");
  if (a.sessionDir && !existsSync(a.sessionDir)) throw new Error(`--session-dir ${a.sessionDir} does not exist`);
  console.log(`old build: worktree HEAD ${prov.head.slice(0, 12)} (base ${a.oldBase.slice(0, 12)}), bridge-handler.js ${prov.oldHash} (new ${prov.newHash})`);
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

function intake(m, store, dataDir, event) {
  const r = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir }).intake(m.buildTypedTaskEvent(event));
  if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
  return r.run_id;
}
const scheduledTurn = (schedule_id, key) => ({ source: "schedule", type: "turn", program: "turn", goal: "rollback 4A check-in", requested_by: { kind: "schedule", id: schedule_id },
  notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `schedule:${schedule_id}:rb4a:${key}`, source_reference: `scheduled_tasks.${schedule_id}` });
const userTurn = (goal, key) => ({ source: "telegram", type: "turn", program: "turn", goal, requested_by: OPERATOR, notify: { kind: "telegram", chat_id: CHAT },
  idempotency_key: `rollback4a:${key}`, source_reference: `rollback4a:${key}` });

/** Step 1, the new build: migrate, then a granted row, six events, a standing decision, and one real use; then the copy's other schedules are quieted. */
function seedNew(m, path, root) {
  const seed = seedRows(m, path, root);
  quietOtherSchedules(path, seed.schedule_id);
  return seed;
}

/**
 * The old tick takes at most three due schedules (schedule-tick.ts), and the live copy holds older ones that could fill every slot:
 * on the COPY only, every other enabled schedule is disabled, so the seeded one is the due one the tick must fire.
 */
function quietOtherSchedules(path, schedule_id) {
  const db = new DatabaseSync(path);
  try { const r = db.prepare(`UPDATE scheduled_tasks SET state = 'disabled' WHERE state = 'enabled' AND schedule_id <> ?`).run(schedule_id); console.log(`  copy: ${r.changes} other schedule(s) disabled for the tick probe`); }
  finally { db.close(); }
}

function seedRows(m, path, root) {
  const s = m.RunStore.open(path);
  try {
    const now = new Date().toISOString();
    const schedule_id = s.addScheduledTask({ chat_id: CHAT, goal: "rollback 4A: Alishan check-in", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney",
      next_run_at: new Date(Date.now() - 60_000).toISOString(), now }).schedule_id; // due: the old build's tick must fire it
    const run = intake(m, s, root, scheduledTurn(schedule_id, `seed:${Date.now()}`));
    s.claimRun(run, "rollback-4a", 60);
    const action_fingerprint = m.actionFingerprint("shell_external", m.OMP_SHELL_META.shell_external, { command: CMD });
    const seed = s.inTransaction(() => {
      const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "rb4a", from_rung: "paco", to_rung: "rule", evidence: ["rb-a1", "rb-a2", "rb-a3", "rb-a4", "rb-dec", run, "rb-tc4"],
        granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true, created_at: now });
      const row = s.insertStandingApprovalForTest({ schedule_id, chat_id: CHAT, action_fingerprint, state: "standing", move_id, credited_runs_json: '["rb-r1","rb-r2","rb-r3"]',
        approval_ids_json: '["rb-a1","rb-a2","rb-a3","rb-a4"]', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), created_at: now });
      const id = row.standing_id;
      for (const [type, payload] of [["standing_streak", { run_id: run, approval_id: "rb-a1", streak: 1 }], ["standing_sealing", { run_id: run, tool_call_id: "rb-tc4", approval_id: "rb-a4" }],
        ["standing_sealed", { run_id: run, tool_call_id: "rb-tc4", exit_code: 0 }], ["standing_granted", { move_id }], ["standing_ended", { reason: "stale" }]]) s.appendStandingLedgerEvent(type, { standing_id: id, ...payload }, run);
      const decision = s.insertDecision({ entry_id: "tool.policy", entry_version: 3, run_id: run, tool_call_id: "rb-tc5", stage: "pre_tool", rung: "rule", verdict: "allowed", p: null,
        reason_code: "standing", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0 });
      return { standing_id: id, move_id, decision };
    });
    const used = s.standingUse({ standing_id: seed.standing_id, action_fingerprint, run_id: run, tool_call_id: "rb-tc5", now }); // the sixth event type, through the real CAS
    if (!used.ok) throw new Error(`seed standing use refused: ${used.code}`);
    // A standing use with no readable clean-room facts after a terminal run is ended as unverified, so the use carries its seal facts.
    s.appendRunLedgerEvent(run, "tool_finished", "core", { tool_call_id: "rb-tc5", status: "succeeded", output_hash: "rb-out", duration_ms: 1, bytes_out: 3, executor: "cleanroom",
      cleanroom: { ran: true, torn_down: true, tampered: false, escaped: false, exit_code: 0, truncated: false, check_failed: false, room: "room-rb4a" } });
    if (!s.finishRun({ run_id: run, expected_worker_id: "rollback-4a", next: "completed", report_ref: "runs/rollback-check-4a.md", duration_ms: 1, tool_calls: 1 })) throw new Error("the seed run did not complete");
    return { run, schedule_id, action_fingerprint, ...seed };
  } finally { s.close(); }
}

/** Read-only view of what the previous build must leave alone. */
function snapshot(path, seed) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const row = one(`SELECT state, move_id, last_used_run_id, updated_at, expires_at FROM standing_approvals WHERE standing_id = ?`, seed.standing_id);
    return { row: JSON.stringify(row), uses: one(`SELECT COUNT(*) AS n FROM standing_uses`).n, move: one(`SELECT state FROM ladder_moves WHERE move_id = ?`, seed.move_id)?.state,
      events: db.prepare(`SELECT event_type, COUNT(*) AS n FROM ledger_events WHERE event_type LIKE 'standing_%' GROUP BY event_type ORDER BY event_type`).all().map((r) => `${r.event_type}:${r.n}`).join(","),
      reason: one(`SELECT reason_code FROM decisions WHERE decision_id = ?`, seed.decision)?.reason_code };
  } finally { db.close(); }
}

const violationKinds = (old, store) => [...new Set(old.detectViolations(store, new Date().toISOString()).map((v) => v.kind))].sort();
function baselineKinds(old, path) { const s = old.RunStore.open(path); try { return violationKinds(old, s); } finally { s.close(); } }

/** Step 2, the previous build: migrations, /status decisions, the digest, invariants, /schedule. */
function oldReads(old, path, seed, baseline, root) {
  const s = old.RunStore.open(path);
  try {
    check("the previous build opens the copy (its migrations ran)", true);
    let list = "";
    try { list = old.decisionListText(s, process.env); check("the previous build's /status decisions renders over a standing decision", true); } catch (e) { check("the previous build's /status decisions renders over a standing decision", false, msg(e)); }
    const short = seed.run.replace(/^run_/, "").slice(0, 8); // the old build never interprets reason codes; it must list the row, not choke on it
    check("/status decisions LISTS the seeded row over a decisions table holding the standing reason and entry_version 3", list.split("\n").some((l) => l.includes("tool.policy") && l.includes(`run ${short}`)), `run ${short}`);
    try { old.decisionStatusLines(s, new Date().toISOString()); check("the previous build's /status decision block builds over the seeded rows", true); } catch (e) { check("the previous build's /status decision block builds over the seeded rows", false, msg(e)); }
    try {
      // the loop-off watch line makes a digest non-empty on any copy, so the render over the seeded rows is always exercised
      const d = old.buildDecisionDigest(s, new Date().toISOString(), { ...process.env, HOUGE_IMPROVE_ENABLED: "false" });
      check("the previous build builds its digest over a copy holding standing rows", d !== null && d.text.includes("improvement tick off"), d ? `${d.text.length} chars` : "no digest");
    } catch (e) { check("the previous build builds its digest over a copy holding standing rows", false, msg(e)); }
    try {
      const kinds = violationKinds(old, s); const added = kinds.filter((k) => !baseline.includes(k));
      check("the previous build's invariant detection raises no violation kind the seeded rows caused", added.length === 0, `now [${kinds.join(", ") || "none"}] · baseline [${baseline.join(", ") || "none"}] · added [${added.join(", ") || "none"}]`);
    } catch (e) { check("the previous build's invariant detection raises no violation kind the seeded rows caused", false, msg(e)); }
    try {
      const key = `rollback4a:schedule:${Date.now()}`;
      new old.Gateway(s, undefined, undefined, undefined, undefined, { dataDir: root }).intake(old.buildTypedTaskEvent({ source: "telegram", type: "schedule_admin", program: "list", requested_by: OPERATOR,
        notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: key, source_reference: `telegram:update:${key}:message:1` }));
      const db = new DatabaseSync(path, { readOnly: true });
      let text = ""; try { text = String(JSON.parse(db.prepare(`SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?`).get(`${key}:schedule`)?.payload_json ?? "{}").text ?? ""); } finally { db.close(); }
      check("the previous build's /schedule lists the granted schedule (and knows no standing section)", text.includes("rollback 4A: Alishan check-in") && !text.includes("常驻批准"), `${text.split("\n").length} line(s)`);
    } catch (e) { check("the previous build's /schedule lists the granted schedule (and knows no standing section)", false, msg(e)); }
  } finally { s.close(); }
}

/** A scheduled ActiveTurn for the previous build's bridge; the shell is a stub (the question is the gate, not the command). */
function oldTurn(old, s, run, schedule_id, root, ran) {
  const claim = s.claimRun(run, "rollback-4a-old", 120); if (!claim) throw new Error("claim failed");
  const registry = new old.ToolRegistry();
  for (const [name, meta] of Object.entries(old.OMP_SHELL_META)) registry.register({ name, category: "tool", ...meta, timeout_ms: 30_000, execute: async () => { ran.n++; return { ok: true, output: { exit_code: 0, output: "200", truncated: false } }; } });
  const cwd = join(root, "ws"); mkdirSync(cwd, { recursive: true });
  return { run_id: run, worker_id: "rollback-4a-old", chat_id: CHAT, requester: { kind: "schedule", id: schedule_id }, approver: OPERATOR, contract: claim.contract,
    budget: new old.BudgetLedger(claim.contract.budget), registry, signal: new AbortController().signal, cwd, step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: async (tool) => ({ digest: "d", contains_instructions: false, source_meta: { tool, bytes: 1 } }), setAwaitingApproval: () => undefined, postureOk: () => null,
    judge: PASS_JUDGE, trust: new old.TurnTrust({ store: s, run_id: run, chat_id: CHAT, born: "schedule", env: {} }) };
}

/** Step 3: the granted bytes on the granted schedule — the previous build asks, its gateway resolves the approval, and the grant is never used. */
async function oldAsks(old, path, seed, root) {
  const before = snapshot(path, seed);
  const s = old.RunStore.open(path);
  try {
    const run = intake(old, s, root, scheduledTurn(seed.schedule_id, `ask:${Date.now()}`));
    const ran = { n: 0 }; const turn = oldTurn(old, s, run, seed.schedule_id, root, ran);
    const decls = old.loadToolDeclarations(old.TOOL_DECLS_DIR); if (!decls.ok) throw new Error(decls.error);
    const handle = old.createBridgeHandler({ store: s, cfg: { ...old.resolveOmpConfig(process.env), sandbox: true }, ctx: { home: join(root, "home"), repo: join(root, "repo"), data: root },
      decls: decls.decls, env: process.env, turnEnvelopeActions: [...old.TURN_ACTIONS], activeTurn: () => turn });
    const pending = handle({ id: "rb4a-1", kind: "call", tool: "bash", input: { command: CMD }, toolCallId: "rb4a-call" });
    let asked; for (let i = 0; i < 200 && !asked; i++) { asked = s.getLedgerEvents(run).find((e) => e.event_type === "approval_requested"); if (!asked) await sleep(50); }
    check("the previous build asks again for the granted bytes on the granted schedule", asked !== undefined && asked.payload.action_fingerprint === seed.action_fingerprint, asked ? "approval_requested" : "no card in 10 s");
    if (!asked) return;
    const key = `rollback4a:approve:${asked.payload.approval_id}`;
    const r = new old.Gateway(s, undefined, undefined, undefined, undefined, { dataDir: root }).intake(old.buildTypedTaskEvent({ source: "telegram", type: "approve", approval_id: asked.payload.approval_id,
      requested_by: OPERATOR, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: key, source_reference: `telegram:update:${key}:callback:1` }));
    check("an approval resolve on the previous build (its gateway, its waiter)", r.ok === true && r.status === "approval_resolved", JSON.stringify(r));
    const out = await Promise.race([pending, sleep(15_000).then(() => ({ timeout: true }))]);
    check("the approved call ran once on the previous build", out.timeout !== true && out.isError === false && ran.n === 1, `ran ${ran.n} · ${JSON.stringify(out).slice(0, 120)}`);
    const reasons = s.listDecisionsForRun(run).filter((d) => d.entry_id === "tool.policy").map((d) => d.reason_code);
    const after = snapshot(path, seed);
    check("the previous build never used the grant (no standing use, row and move untouched, no standing reason)",
      after.uses === before.uses && after.row === before.row && after.move === "active" && !reasons.includes("standing") && !s.getLedgerEvents(run).some((e) => e.event_type === "standing_used"),
      `uses ${before.uses} → ${after.uses} · reasons [${reasons.join(",")}]`);
  } finally { s.close(); }
}

/** Step 4: the previous build's schedule tick fires the seeded due schedule (stub worker: nothing runs). */
async function oldTick(old, path, seed, root) {
  const s = old.RunStore.open(path);
  try {
    const submitted = [];
    const worker = { executeRun: async () => ({}), submitTurn: (run_id) => { submitted.push(run_id); return true; } };
    const r = await old.maybeFireScheduledTasks({ store: s, gateway: new old.Gateway(s, undefined, undefined, undefined, undefined, { dataDir: root }), worker, now: new Date().toISOString(),
      env: { ...process.env, HOUGE_SCHEDULER_ENABLED: "1" } });
    const mine = submitted.filter((id) => s.getRunForWorker(id)?.requested_by?.id === seed.schedule_id);
    check("the previous build's schedule tick fires the granted schedule", mine.length === 1 && r.failures === 0, `fired ${r.fired} · this schedule ${mine.length} · failures ${r.failures}`);
  } finally { s.close(); }
}

const jsonls = (dir) => readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
function newestOf(dir) { return jsonls(dir).map((f) => ({ f, size: statSync(join(dir, f)).size, mtime: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]; }
async function waitEnd(store, run, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const st = store.getRunState(run); if (st === "completed" || st === "failed") return st; await sleep(500); }
  return "timeout";
}

/** Step 5, as the 2b check does: the previous build's supervisor resumes a kept transcript in place on the copy that holds the standing rows. */
async function oldResume(old, path, args) {
  if (!args.sessionDir) return cannotRun("the previous build resumes a transcript on a copy holding standing rows", `no --session-dir (pass a kept gate run's …/data/omp/sessions/chat-${CHAT} directory)`);
  try { execFileSync("omp", ["--version"], { stdio: "pipe" }); } catch { return cannotRun("the previous build resumes a transcript on a copy holding standing rows", "omp is unavailable"); }
  const dir = args.sessionDir; const data = resolve(dir, "..", "..", "..");
  if (!/^\/(private\/)?tmp\/hg-[^/]+\//.test(realpathSync(dir)) || dir !== join(data, "omp", "sessions", `chat-${CHAT}`)) {
    throw new Error(`--session-dir must be a kept gate run's <root>/<case>/data/omp/sessions/chat-${CHAT} (it is used in place): ${dir}`);
  }
  const before = jsonls(dir); const newest = newestOf(dir);
  if (!newest) return cannotRun("the previous build resumes a transcript on a copy holding standing rows", "the session dir holds no transcript");
  console.log(`  transcript ${newest.f}: ${newest.size} bytes (${readFileSync(join(dir, newest.f), "utf8").split("\n").length} lines)`);
  const s = old.RunStore.open(path);
  const worker = new old.CoreWorker(s, dirname(args.oldDist), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { dataDir: data, distDir: args.oldDist });
  try {
    const run = intake(old, s, data, userTurn("ok", `resume:${Date.now()}`));
    worker.submitTurn(run);
    const state = await waitEnd(s, run, 300_000);
    const db = new DatabaseSync(path, { readOnly: true });
    let n = 0; try { n = db.prepare(`SELECT COUNT(*) AS n FROM chat_turns WHERE run_id = ? AND role = 'assistant'`).get(run).n; } finally { db.close(); }
    check("the previous build answers a turn on the resumed transcript (run completed, one assistant chat turn)", state === "completed" && n === 1, `${state}, ${n} assistant turn(s)`);
    const after = newestOf(dir);
    check("no new session file: the previous build resumed the transcript", JSON.stringify(jsonls(dir)) === JSON.stringify(before), `${before.length} → ${jsonls(dir).length} file(s)`);
    check("the resumed transcript grew by the appended turn", after?.f === newest.f && after.size > newest.size, `${newest.f} ${newest.size} → ${after?.f} ${after?.size} bytes`);
  } finally { await worker.shutdownPlanners?.(); s.close(); }
}

/** Step 6, the new build again: the seeded grant is still standing, its sweep runs clean, the rollback left the rows readable. */
function newReopens(neu, path, seed) {
  const s = neu.RunStore.open(path);
  try {
    const sweep = neu.runStandingSweep(s, new Date().toISOString());
    check("the new build reopens the copy: the grant stands and its sweep runs", s.getStandingApproval(seed.standing_id)?.state === "standing", JSON.stringify(sweep));
  } finally { s.close(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const neu = await load(NEW_DIST, ["run/run-store.js", "config/load-env.js", "gateway/gateway.js", "domain/types.js", "capabilities/capability-runner.js", "core/omp-turn-wiring.js", "decisions/standing-approval.js"]);
  neu.loadHougeEnv();
  const live = resolve(args.db ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  temp.root = mkdtempSync("/tmp/hg-4a-rb-"); temp.keep = args.keep;
  isolate(temp.root); mkdirSync(join(temp.root, "daemon-tmp"), { recursive: true });
  const path = join(temp.root, "copy.sqlite"); const basePath = join(temp.root, "baseline.sqlite");
  copyDb(live, path); copyDb(live, basePath);
  const seed = seedNew(neu, path, temp.root);
  const s1 = snapshot(path, seed);
  check("the new build seeded the rows (a standing row with an active move, six standing_* event types, one standing use, a standing decision reason)",
    JSON.parse(s1.row).state === "standing" && s1.move === "active" && s1.uses >= 1 && s1.reason === "standing" && s1.events.split(",").length === 6, `${s1.events} · uses ${s1.uses}`);
  const old = await load(args.oldDist, ["run/run-store.js", "core/core-worker.js", "gateway/gateway.js", "domain/types.js", "decisions/status-view.js", "decisions/digest.js", "run/invariant-sweep.js",
    "run/schedule-tick.js", "omp/bridge-handler.js", "omp/omp-config.js", "omp/tool-decls.js", "core/omp-turn-wiring.js", "contracts/task-contract.js", "decisions/trust.js", "budget/budget-ledger.js", "tools/tool-registry.js"]);
  let baseline = [];
  try { baseline = baselineKinds(old, basePath); } catch (e) { check("the previous build's invariant detection runs on the unseeded baseline copy", false, msg(e)); }
  try { oldReads(old, path, seed, baseline, temp.root); } catch (e) { check("the previous build boots on the copy", false, msg(e)); }
  try { await oldAsks(old, path, seed, temp.root); } catch (e) { check("the previous build asks again and never uses the grant", false, msg(e)); }
  try { await oldTick(old, path, seed, temp.root); } catch (e) { check("the previous build's schedule tick fires the granted schedule", false, msg(e)); }
  try { await oldResume(old, path, args); } catch (e) { check("the previous build resumes a transcript on a copy holding standing rows", false, msg(e)); }
  const s2 = snapshot(path, seed);
  check("the previous build left the seeded standing rows, uses and events in place", s2.row === s1.row && s2.uses === s1.uses && s2.events === s1.events && s2.move === s1.move, `${s1.events} → ${s2.events}`);
  try { newReopens(neu, path, seed); } catch (e) { check("the new build reopens the copy: the grant stands and its sweep runs", false, msg(e)); }
  const status = failures.length > 0 ? "FAIL" : inconclusive.length > 0 ? "INCONCLUSIVE" : "PASS";
  console.log(status === "FAIL" ? `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}` : `\nROLLBACK CHECK: ${status}${inconclusive.length ? `\n  - ${inconclusive.join("\n  - ")}` : ""}`);
  return status === "PASS" ? 0 : status === "FAIL" ? 1 : 3;
}

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { cleanup(); process.exit(code); });
main().then((c) => { cleanup(); process.exit(c); }, (e) => { console.error(`rollback check setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); cleanup(); process.exit(2); });
