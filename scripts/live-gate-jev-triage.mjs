#!/usr/bin/env node
// Live gate — Jev System One lane 1 (spec §5.9 step 5; plan Task 13). Runs the REAL Jev (TYPESAFE_API_KEY from the env),
// the real memory-lane distill/reconcile legs (ticks chain on omp) and, where a turn falls through, the real omp planner,
// all against a TEMP COPY of the live DB (VACUUM INTO under /tmp). The live DB is only read; the daemon is never touched.
//
//   npm run build && HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-jev-triage.mjs [--db <path>] [--keep]
//
// Arming: no calibration rows ship (calibration.ts), so the gate writes a temp calibration file (every lane-1 row kind:
// lane, complete, scope and the status arm row `lane:status`, zh + en, model JEV_MODEL, hashes from dist/) and sets
// HOUGE_JEV_CALIBRATION_FILE + HOUGE_JEV_GATE=1. The §5.4 BARS still apply: Jev's real probabilities must clear them.
//
// Cases (each asserts the LEDGER rows, not only the reply):
//   1  pure memory instruction → triage answered/memory/pure/act, lesson_changes row, card with Undo, zero planner requests
//   1b Undo tapped through the real Gateway callback path (memlane_undo) → lesson retired, lesson_change_undone event
//   2  mixed (memory + question) → triage mixed/act, exactly one lesson_saved, the planner answered (compose attempts > 0)
//   2b forced second lesson_write on a lane-saved turn through the planner's registry entry → already-saved digest, zero
//      additional llm_attempt rows (no second distill/reconcile)
//   3  status question → triage lane=status/act, code-owned reply, zero planner requests
//   4  tombstone posture → triage skipped{posture} (asserted before the planner answers)
//   5  Jev 429 (stubbed fetch) → skipped{rate_limited} + jev_rate_limited incident; the planner still answers
//   6  TYPESAFE_API_KEY removed → skipped{no_key} + jev_no_key incident (the ENV-key path only: this gate's worker has no
//      broker; the broker-supplied key is covered hermetically in tests/core/core-worker-triage.test.ts with a fake broker)
//
// What this gate cannot exercise (covered hermetically instead):
//   - the slot-A steered ack (a bare ack steered into an AWAITING_APPROVAL turn): needs a planner that asks for an external
//     write, which this gate does not force — tests/omp (Task 8);
//   - the broker-supplied key path (firewall armed) — Task 9 test with a fake broker.
//
// Budget: Jev calls are metered but tiny; cases 2, 4, 5, 6 each run one real planner turn; cases 1, 2, 2b run the
// distill + reconcile legs. Exit: 0 PASS · 1 FAIL · 2 setup error.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envFilePath() {
  return process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env");
}

function parseArgs(argv) {
  const a = { db: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep") a.keep = true;
    else if (argv[i] === "--db") a.db = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

async function loadModules() {
  const [env, disarm, core, types, gw, rs, jc, tq, qt, th] = await Promise.all([
    import("../dist/config/load-env.js"), import("../dist/config/disarm-posture.js"), import("../dist/core/core-worker.js"),
    import("../dist/domain/types.js"), import("../dist/gateway/gateway.js"), import("../dist/run/run-store.js"),
    import("../dist/jev/jev-client.js"), import("../dist/jev/questions/triage.js"), import("../dist/jev/questions/types.js"),
    import("../dist/jev/thresholds.js")
  ]);
  return { loadHougeEnv: env.loadHougeEnv, DISARM_FLAGS: disarm.DISARM_FLAGS, CoreWorker: core.CoreWorker, buildTypedTaskEvent: types.buildTypedTaskEvent,
    Gateway: gw.Gateway, RunStore: rs.RunStore, JEV_MODEL: jc.JEV_MODEL, TRIAGE_QUESTIONS: tq.TRIAGE_QUESTIONS, TRIAGE_LANE: tq.TRIAGE_LANE,
    criteriaHash: qt.criteriaHash, TRIAGE_STATUS_ARM_ID: th.TRIAGE_STATUS_ARM_ID };
}

/** The gate-only calibration file: every lane-1 row kind for zh and en, hashes from the BUILT questions. */
function writeCalibration(m, root) {
  const ids = [...m.TRIAGE_QUESTIONS.map((q) => [q.id, m.criteriaHash(q)]), [m.TRIAGE_STATUS_ARM_ID, m.criteriaHash(m.TRIAGE_LANE)]];
  const rows = ids.flatMap(([question_id, criteria_hash]) => ["zh", "en"].map((lang) =>
    ({ question_id, criteria_hash, model: m.JEV_MODEL, lang, approved: "live-gate", evidence: "live-gate (temp file, never committed)" })));
  const file = join(root, "calibration.json");
  writeFileSync(file, JSON.stringify(rows));
  return file;
}

/** No Telegram, every disarm flag off, every marker path inside the temp root; the lane armed for the gate only. */
function gateEnv(m, root) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  for (const f of m.DISARM_FLAGS) process.env[f] = "false";
  Object.assign(process.env, {
    HOUGE_EPISODIC_ENABLED: "false", HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", HOUGE_JEV_GATE: "1",
    HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed"), HOUGE_JEV_CALIBRATION_FILE: writeCalibration(m, root)
  });
}

/** A consistent snapshot of the live DB through a read-only connection (WAL-safe; the daemon keeps running). */
function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/** The gate's view helpers over the COPY: intake, settle, ledger reads. */
function harness(m, store, repo, root) {
  const makeWorker = (jevFetch) => new m.CoreWorker(store, repo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, { dataDir: root, distDir: DIST, ...(jevFetch ? { jevFetch } : {}) });
  const intake = (chat, text) => {
    const r = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir: root }).intake(m.buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: "gate" },
      notify: { kind: "telegram", chat_id: chat }, idempotency_key: `gate:${randomUUID()}`, source_reference: "gate" }));
    if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
    return r.run_id;
  };
  const settle = async (run_id, ms = 300_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const s = store.getRunState(run_id); if (s === "completed" || s === "failed") return s; await sleep(500); }
    return "timeout";
  };
  const events = (run_id, type) => store.getLedgerEvents(run_id).filter((e) => e.event_type === type);
  const triageRow = (run_id) => events(run_id, "triage")[0]?.payload;
  const attempts = (run_id, role) => events(run_id, "llm_attempt").filter((e) => role === undefined || e.payload.role === role).length;
  return { makeWorker, intake, settle, events, triageRow, attempts };
}

/** The reply notifications of a run, read from the copy (the store keeps no public reader by run). */
function replies(dbPath, run_id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare("SELECT payload_json FROM notification_outbox WHERE run_id = ? ORDER BY created_at").all(run_id).map((r) => JSON.parse(r.payload_json)); }
  finally { db.close(); }
}

const show = (label, row) => console.log(`  triage[${label}] ${JSON.stringify(row ?? null)}`);

// Test messages (generic, no personal text). Jev is non-deterministic: a phrasing that misses a bar is a finding to report.
const MSG = {
  pure: "从现在起，回复请控制在三句话以内。",
  mixed: "以后别用敬语。另外，今天悉尼天气怎么样？",
  pure2: "记住：以后回复里不要用表情符号。",
  status: "你刚才重启过吗？现在跑的是哪个版本？",
  posture: "以后回复短一点"
};

/** 1 + 1b: the pure memory lane, then Undo through the real callback path. */
async function casePure(g) {
  const { h, worker, chat, store, dbPath, m, root } = g;
  const run_id = h.intake(chat, MSG.pure); worker.submitTurn(run_id);
  check("1 pure: run completed", (await h.settle(run_id)) === "completed", store.getRunState(run_id));
  const row = h.triageRow(run_id); show("1 pure", row);
  check("1 pure: triage answered/memory/pure/act", row?.status === "answered" && row.lane === "memory" && row.complete === "pure" && row.decision === "act");
  check("1 pure: zero planner requests (compose)", h.attempts(run_id, "compose") === 0, `compose=${h.attempts(run_id, "compose")}`);
  check("1 pure: the lane's own legs ran (distill)", h.attempts(run_id, "distill") > 0, `distill=${h.attempts(run_id, "distill")} consolidate=${h.attempts(run_id, "consolidate")}`);
  const change = store.getLessonChangeByRun(run_id);
  check("1 pure: lesson_changes row + one lesson_saved", !!change && h.events(run_id, "lesson_saved").length === 1, change?.change_id ?? "none");
  const card = replies(dbPath, run_id).map((p) => JSON.stringify(p)).join("\n");
  check("1 pure: the reply is the card with Undo", !!change && card.includes(`memlane:undo:${change.change_id}`));
  if (!change) return;
  const key = randomUUID();
  const tap = m.buildTypedTaskEvent({ source: "telegram", type: "memlane_undo", requested_by: { kind: "user", id: "gate" }, notify: { kind: "telegram", chat_id: chat },
    idempotency_key: `telegram:gate:callback:${key}`, source_reference: `telegram:update:gate:callback:${key}`,
    metadata: { telegram_update_id: 1, telegram_callback_id: key, change_id: change.change_id } });
  const u = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir: root }).intake(tap);
  const undone = store.getLedgerEvents().filter((e) => e.event_type === "lesson_change_undone" && e.payload.change_id === change.change_id);
  check("1b undo via gateway: lesson retired + one lesson_change_undone", u.ok && store.getLesson(change.new_id)?.status === "pruned" && undone.length === 1,
    `intake=${JSON.stringify(u)} status=${store.getLesson(change.new_id)?.status} undone=${undone.length}`);
  if (change.superseded_id !== null) check("1b undo: superseded lesson restored", store.getLesson(change.superseded_id)?.status === "active");
}

/** 2: mixed — saved by the lane, the planner answers with the inform prefix; its own lesson_write (if any) is refused. */
async function caseMixed(g) {
  const { h, worker, chat, store } = g;
  const run_id = h.intake(chat, MSG.mixed); worker.submitTurn(run_id);
  check("2 mixed: run completed", (await h.settle(run_id)) === "completed", store.getRunState(run_id));
  const row = h.triageRow(run_id); show("2 mixed", row);
  check("2 mixed: triage answered/memory/mixed/act", row?.status === "answered" && row.lane === "memory" && row.complete === "mixed" && row.decision === "act");
  check("2 mixed: the planner answered (compose > 0)", h.attempts(run_id, "compose") > 0, `compose=${h.attempts(run_id, "compose")}`);
  check("2 mixed: exactly one lesson_saved", h.events(run_id, "lesson_saved").length === 1, `lesson_saved=${h.events(run_id, "lesson_saved").length}`);
}

/** 2b: a lane-saved turn, then the planner's own registry `lesson_write` entry on the same claim → digest, zero new legs. */
async function caseSecondWrite(g) {
  const { h, worker, store } = g;
  const chat = `-2000${Date.now() % 100000}`;
  const run_id = h.intake(chat, MSG.pure2);
  const claim = store.claimRun(run_id, `planner:gate:${run_id}`, 300);
  if (!claim) { check("2b: claim", false); return; }
  const tools = worker.buildOmpTools(claim);
  const out = await worker.triageTurn({ claim, text: MSG.pure2, userText: MSG.pure2, modality: "text", posture: null, signal: new AbortController().signal });
  show("2b lane", h.triageRow(run_id));
  check("2b: the lane replied (lane_reply)", out.kind === "lane_reply", out.kind);
  const before = h.attempts(run_id);
  const entry = tools.registry.get("lesson_write");
  const r = entry?.execute ? await entry.execute({ scope: "ask" }) : { ok: false, error: "no lesson_write entry" };
  const saved = store.getLessonChangeByRun(run_id);
  check("2b: second lesson_write → already-saved digest naming the lesson", r.ok && r.output?.saved === false && saved !== undefined && r.output?.lesson_id === saved.new_id,
    JSON.stringify(r));
  check("2b: zero additional llm_attempt rows", h.attempts(run_id) === before, `before=${before} after=${h.attempts(run_id)}`);
  check("2b: exactly one lesson_saved", h.events(run_id, "lesson_saved").length === 1);
}

/** 3: status — code-owned reply, no planner. */
async function caseStatus(g) {
  const { h, worker, chat, store } = g;
  const run_id = h.intake(chat, MSG.status); worker.submitTurn(run_id);
  check("3 status: run completed", (await h.settle(run_id)) === "completed", store.getRunState(run_id));
  const row = h.triageRow(run_id); show("3 status", row);
  check("3 status: triage lane=status/act", row?.status === "answered" && row.lane === "status" && row.decision === "act");
  check("3 status: zero planner requests (compose)", h.attempts(run_id, "compose") === 0, `compose=${h.attempts(run_id, "compose")}`);
}

/** 4: the tombstone posture skips triage; the row is asserted before the planner answers, then the marker is removed. */
async function casePosture(g) {
  const { h, worker, chat, store } = g;
  writeFileSync(process.env.HOUGE_TOMBSTONE_PATH, "gate");
  try {
    const run_id = h.intake(chat, MSG.posture); worker.submitTurn(run_id);
    const t0 = Date.now();
    while (!h.triageRow(run_id) && Date.now() - t0 < 60_000) await sleep(200);
    const row = h.triageRow(run_id); show("4 posture", row);
    check("4 posture: skipped{posture}, before any planner answer", row?.status === "skipped" && row.skip_reason === "posture" && store.getRunState(run_id) !== "completed");
    rmSync(process.env.HOUGE_TOMBSTONE_PATH, { force: true });
    const s = await h.settle(run_id);
    check("4 posture: the turn still ended (planner path)", s === "completed" || s === "failed", s);
  } finally { rmSync(process.env.HOUGE_TOMBSTONE_PATH, { force: true }); }
}

/** An open incident of `kind`, and whether one was already open before the case (then the case proves less). */
const incidentOpen = (store, kind) => store.listOpenIncidents().some((i) => i.kind === kind);

/** 5: a 429 from Jev (stubbed fetch) → skipped{rate_limited} + incident; the planner answers. */
async function caseRateLimited(g) {
  const { h, chat, store } = g;
  const pre = incidentOpen(store, "jev_rate_limited");
  const worker = h.makeWorker(async () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } }));
  try {
    const run_id = h.intake(chat, MSG.posture); worker.submitTurn(run_id);
    check("5 429: run completed via the planner", (await h.settle(run_id)) === "completed", store.getRunState(run_id));
    const row = h.triageRow(run_id); show("5 429", row);
    check("5 429: skipped{rate_limited}", row?.status === "skipped" && row.skip_reason === "rate_limited");
    check("5 429: jev_rate_limited incident open", incidentOpen(store, "jev_rate_limited"), pre ? "WARNING: already open in the live copy" : "opened by this case");
  } finally { await worker.shutdownPlanners(); }
}

/** 6: no TYPESAFE_API_KEY (env path; no broker in this gate) → skipped{no_key} + incident. */
async function caseNoKey(g) {
  const { h, chat, store } = g;
  const pre = incidentOpen(store, "jev_no_key");
  const had = Object.prototype.hasOwnProperty.call(process.env, "TYPESAFE_API_KEY"); const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const worker = h.makeWorker();
  try {
    const run_id = h.intake(chat, MSG.posture); worker.submitTurn(run_id);
    const s = await h.settle(run_id);
    const row = h.triageRow(run_id); show("6 no key", row);
    check("6 no key: skipped{no_key}, the turn ended", row?.status === "skipped" && row.skip_reason === "no_key" && (s === "completed" || s === "failed"), s);
    check("6 no key: jev_no_key incident open", incidentOpen(store, "jev_no_key"), pre ? "WARNING: already open in the live copy" : "opened by this case");
  } finally {
    await worker.shutdownPlanners();
    if (had) process.env.TYPESAFE_API_KEY = key; else delete process.env.TYPESAFE_API_KEY;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const m = await loadModules();
  m.loadHougeEnv();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (HOUGE_ENV_FILE?)");
  const repo = dirname(resolve(envFilePath())); // the LIVE repo: read for lessons/src scans; its DB is only copied
  const live = resolve(args.db ?? join(repo, "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  const root = mkdtempSync("/tmp/hg-jev-"); // short: bridge sockets must fit sun_path (104 bytes)
  gateEnv(m, root);
  const dbPath = join(root, "houge.sqlite");
  copyDb(live, dbPath);
  const store = m.RunStore.open(dbPath);
  const h = harness(m, store, repo, root);
  const g = { m, store, h, root, dbPath, chat: `-1000${Date.now() % 100000}`, worker: h.makeWorker() };
  console.log(`jev triage live gate — copy ${dbPath}, model ${m.JEV_MODEL}\n`);
  try {
    for (const c of [casePure, caseMixed, caseSecondWrite, caseStatus, casePosture]) await c(g);
    await g.worker.shutdownPlanners();
    await caseRateLimited(g);
    await caseNoKey(g);
  } finally { await g.worker.shutdownPlanners(); store.close(); }
  console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
  if (args.keep || failures.length > 0) console.log(`temp dir kept: ${root}`); else rmSync(root, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
