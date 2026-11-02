#!/usr/bin/env node
// Live gate — decision ladder remainder R5, context.recall + context.catch_up + context.lessons + turn.clarify_cap (spec 2026-11-02 R5 §7; plan Task 6).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-remainder-r5.mjs [--live-db <path>] [--base-dist <merge-base dist>]
// --base-dist: the merge-base build line 1 compares the loop_started payload's keys against (default .worktrees/base-9c23f084be37/dist).
// Eight lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all eight PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. Only counts, booleans, codes and run labels are printed, never message or prompt text, any wiki
// title, or any id of the live DB.
// The live DB is opened read-only, once, by VACUUM INTO a temp copy under /tmp/hg-s4d-*; a byte copy of that copy (taken before any store opens it)
// is the merge-base build's for line 1. Both are removed on every exit path (finally, SIGINT, SIGTERM, SIGHUP). No env file is loaded (HOUGE_ENV_FILE
// only locates the DB); there is no real omp child (a fake session over the dist PlannerSupervisor for lines 3-5 and 7, tests/fixtures/fake-omp.mjs
// under CoreWorker.submitTurn for lines 1, 2 and 6) and no Telegram client at all. Line 1's embedder is the real one (local Ollama, or its failure);
// line 2's is pointed at a closed local port. Nothing leaves the machine. Safety pins, set before any store opens and restored on exit:
//   HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root (P2), HOUGE_TELEGRAM_CHAT_ID = -1003 (P3: line 7's alert must not page Paco),
//   every HOUGE_*_ENABLED flag and the omp, embed, lesson-cap and clarify variables deleted (lines set the ones they need, then restore),
//   HOUGE_LESSON_CHAR_CAP = 1e9 for CoreWorker spawns and the same in every fixture turn context except line 5's (the copy's real lessons never
//   write a context.lessons row outside line 5, whatever their size today).
// Chats: the fixture supervisor is chat 42 (lines 3, 4, 5, 7); CoreWorker turns run in the stub chat -1003 (lines 1, 2, 6). Every run is its own actor.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, canon, cleanupTemp, initTemp, loadDist, redactForPrint } from "./stage4-diff-lib.mjs";
import { countingRecorder } from "./stage4-sender-fixture.mjs";
import { cleanup, mkSupervisor, req, seedLaneRows, seedLessons } from "./stage4-supervisor-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const FAKE_OMP = resolve(new URL("../tests/fixtures/fake-omp.mjs", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const BASE_DIST = resolve(arg("--base-dist") ?? join(MAIN_CHECKOUT, ".worktrees/base-9c23f084be37/dist"));
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const STUB_CHAT = "-1003"; // numeric (CoreWorker refuses a non-numeric chat id before submit), not a real chat
const FIX_CHAT = "42"; // the fixture supervisor's chat
const RC = "context.recall"; const CU = "context.catch_up"; const LS = "context.lessons"; const CC = "turn.clarify_cap";
const IDS = [RC, CU, LS, CC];
const SHORT = { [RC]: "rc", [CU]: "cu", [LS]: "ls", [CC]: "cc" };
const BIG = 1_000_000_000;
const NO_CAP_ENV = { HOUGE_LESSON_CHAR_CAP: String(BIG) };
const CAP40 = { HOUGE_LESSON_CHAR_CAP: "40" };
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_LESSON_CHAR_CAP"];
const DELETE_PINS = ["HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES", "HOUGE_MODEL_ROLES", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG",
  "HOUGE_EMBED_URL", "HOUGE_EMBED_MODEL", "HOUGE_EMBED_TIMEOUT_MS", "HOUGE_MAX_CONSECUTIVE_CLARIFY", "HOUGE_LESSON_CAP_PER_SCOPE", "HOUGE_CHAT_CONTEXT_TURNS"];
const FAKE_VARS = ["HOUGE_OMP_BIN", "HOUGE_OMP_SANDBOX", "HOUGE_OMP_ENV_PASSTHROUGH", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"];
// Rows this gate writes for the four ids before line 8 (line 7's faulted and thrown records never land; line 1's merge-base turn is on its own copy):
//   context.recall = line 1 + line 2; context.catch_up = line 3; context.lessons = line 5; turn.clarify_cap = line 4 + line 6.
const WROTE = { [RC]: 2, [CU]: 1, [LS]: 1, [CC]: 2 };
const out = [];
const G = { d: null, bd: null, root: null, base: null, baseCopy: null, store: null, saved: null, n: 0, clean: {}, priorAt: {}, tc: null, query: null };
const note = (s) => console.error(`# ${s}`);
const wall = () => new Date().toISOString();
const countOf = (sql, ...args) => G.store.db.prepare(sql).get(...args).n;
const all = (sql, ...args) => G.store.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const idRows = (id) => countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", id);
const decisionMark = (store = G.store) => store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
const outboxN = () => countOf("SELECT COUNT(*) AS n FROM notification_outbox");
const IDS_SQL = IDS.map((i) => `'${i}'`).join(",");
/** The four ids' rows written after `mark`, as [entry, verdict, reason, run, tool_call_id]. */
const r5Rows = (mark, store = G.store) => store.db.prepare(`SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ? AND entry_id IN (${IDS_SQL}) ORDER BY rowid`)
  .all(mark).map((r) => [r.entry_id, r.verdict, r.reason_code, r.run_id, r.tool_call_id]);
const strs = (rows, label = () => "a") => rows.map((r) => `${SHORT[r[0]]}:${r[1]}/${r[2]}@${label(r[3])}`);

function verdict(n, name, ok, detail) {
  out.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${name} — ${redactForPrint(detail)}`);
  // redactForPrint caps a print at 200 chars: the whole detail goes to stderr too, one redacted segment per line, so a FAIL always shows its cause
  for (const seg of String(detail).split(" · ")) for (let i = 0; i < seg.length; i += 190) note(`  ${n}: ${redactForPrint(seg.slice(i, i + 190))}`);
}
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError"]);
/** A thrown value prints as its standard class name only, never its message. */
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");
async function runLine(n, name, fn) {
  try { const r = await fn(); verdict(n, name, r.ok, r.detail); } catch (e) { verdict(n, name, false, `threw: ${errCode(e)}`); }
}
/** console.error captured (not printed) while `fn` runs; the lines are returned for counting, never echoed. */
async function captured(fn) {
  const real = console.error; const seen = [];
  console.error = (...a) => { seen.push(a.map(String).join(" ")); };
  try { return { value: await fn(), seen }; } finally { console.error = real; }
}

// ---- the live-DB copy ----
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** VACUUM INTO `to` from `from` (read-only source). The daemon writes the live DB: a lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
/** Marks every non-final outbox row of `store` failed_terminal (the copies are disposable); returns how many. */
const parkOutbox = (store) => store.db.prepare("UPDATE notification_outbox SET state = 'failed_terminal' WHERE state NOT IN ('delivered', 'failed_terminal')").run().changes;

/** One fresh Telegram turn run on `store` through `d`'s gateway (caps no copy reaches), its own actor; notify chat -1003. */
function mkRun(text, d = G.d, store = G.store) {
  G.n += 1;
  const gw = new d.Gateway(store, { ...d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG });
  const r = gw.intake(d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: `gate-r5-actor-${G.n}` },
    notify: { kind: "telegram", chat_id: STUB_CHAT }, idempotency_key: `gate-r5:${G.n}`, source_reference: `telegram:update:${G.n}:message:${G.n}` }));
  if (!r.ok) throw new Error("gate: run intake refused");
  return r.run_id;
}
/** One clarifying assistant turn in `chat`, dated now: it postdates every earlier answer, so the next turn's trailing-clarify count is 1. */
function seedClarifyNow(chat) {
  G.store.recordChatTurn({ chat_id: chat, run_id: "r0", role: "user", text: "fix the file" });
  G.store.recordChatTurn({ chat_id: chat, run_id: "r0", role: "assistant", text: "Which file do you mean?", intent: "clarify" });
}

// ---- a fixture-supervisor turn (chat 42) ----
const promptsOf = (log) => log.filter(([k]) => k === "prompt").map(([, v]) => v);
/**
 * seed(), then one supervisor (recorder: the counting wrap over `recorder`, default the store recorder; turn-context env NO_CAP_ENV unless given) and
 * one turn "hi" (run "a"). Returns the R5 rows (run labelled), consult tally, the child's ordered log, sink results, run state, outbox delta.
 */
async function fixtureTurn(seed, { env = NO_CAP_ENV, recorder } = {}) {
  const mark = decisionMark(); const out0 = outboxN();
  const counting = countingRecorder(recorder ?? G.d.storeRecorder(G.store));
  let rig = null; let run = null;
  try {
    seed?.();
    rig = mkSupervisor(G.d, G.store, { recorder: counting.recorder, turnContext: { env } });
    run = mkRun("hi"); rig.sup.submit(req(run, "hi")); await rig.sup.whenIdle();
  } finally { await cleanup(); }
  const label = (id) => (id === run ? "a" : "?");
  const o = rig.outcome;
  return { rows: r5Rows(mark).map((r) => [r[0], r[1], r[2], label(r[3]), r[4]]), calls: counting.calls, log: rig.session.log, prompts: promptsOf(rig.session.log),
    done: o.done.map((c) => `${label(c.run_id)}:${c.text}`), failed: o.failed.map((c) => `${label(c.run_id)}:${c.error_type}`), sinkIncidents: o.incidents.map((i) => i.k),
    state: G.store.getRunState(run), outbox: outboxN() - out0, run };
}
/** What the turn did, without the decision rows: the line-7 comparison between the clean turn and a faulted one. */
const effects = (s) => canon({ log: s.log, done: s.done, failed: s.failed, sinkIncidents: s.sinkIncidents, state: s.state });

// ---- a CoreWorker turn on the fake omp (chat -1003) ----
const argvLines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/**
 * One CoreWorker of build `d` (fresh planner) over `store` on the fake omp answering "ok"; `embed` is the 10th constructor argument (undefined = the
 * production embedder, embedText over HOUGE_EMBED_URL). `env` is set for the turn and removed after. Returns the run, its state, the prompts the
 * child got, its loop_started payloads and the R5 rows written since the start.
 */
async function workerTurn({ d = G.d, store = G.store, distDir = DIST, tag, text, env = {}, embed, seed }) {
  const scenFile = join(G.root, `scenario-${tag}.json`); const argvLog = join(G.root, `argv-${tag}.log`);
  writeFileSync(scenFile, JSON.stringify({ "*": { rpcText: "ok" } }));
  Object.assign(process.env, { HOUGE_OMP_BIN: FAKE_OMP, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG", FAKE_OMP_SCENARIO: scenFile, FAKE_OMP_ARGV_LOG: argvLog }, env);
  const work = join(G.root, `work-${tag}`); mkdirSync(work, { recursive: true });
  const mark = decisionMark(store); let worker = null;
  try {
    const stub = async () => ({ ok: true, output: { answer: "stub" } });
    const noNet = async () => { throw new Error("gate: no network"); };
    worker = new d.CoreWorker(store, join(work, "project"), stub, undefined, undefined, undefined, undefined, undefined, undefined, embed, undefined, undefined,
      { dataDir: work, distDir, jevFetch: noNet });
    seed?.();
    const run = mkRun(text, d, store); worker.submitTurn(run);
    await waitTerminal(store, run);
    const loops = store.getLedgerEvents(run).filter((e) => e.event_type === "loop_started").map((e) => e.payload);
    const prompts = argvLines(argvLog).filter((l) => l?.cmd?.type === "prompt").map((l) => l.cmd.message);
    return { run, state: store.getRunState(run), prompts, loops, rows: r5Rows(mark, store) };
  } finally {
    try { await worker?.shutdownPlanners(); } catch { /* a stopped planner is not a finding */ }
    for (const k of [...FAKE_VARS, ...Object.keys(env)]) delete process.env[k];
    process.env.HOUGE_OMP_BIN = "/nonexistent/houge-gate/omp";
  }
}
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
async function waitTerminal(store, run, ms = 30_000) {
  const end = Date.now() + ms;
  while (!TERMINAL.has(store.getRunState(run))) { if (Date.now() > end) throw new Error("gate: run did not finish"); await new Promise((r) => setTimeout(r, 20)); }
}
/** Every key path of a JSON value ("a.b", arrays as "[]"), sorted and unique: the shape, never the values. */
function keyShape(v) {
  const paths = new Set();
  const walk = (x, p) => {
    if (Array.isArray(x)) { for (const e of x) walk(e, `${p}[]`); return; }
    if (x === null || typeof x !== "object") return;
    for (const [k, e] of Object.entries(x)) { paths.add(`${p}.${k}`); walk(e, `${p}.${k}`); }
  };
  walk(v, "");
  return [...paths].sort();
}
const MEMORY_FLAGS = { HOUGE_EPISODIC_ENABLED: "1", HOUGE_WIKI_ENABLED: "1" };
const hasContext = (p) => p.includes("[context]\n");
/** The recall line's shared checks: one prompt, run completed, exactly one context.recall row on the run, include ⇔ the prompt's [context] block. */
function recallFacts(t) {
  const row = t.rows.length === 1 ? t.rows[0] : null;
  const prompt = t.prompts.length === 1 ? t.prompts[0] : null;
  const ctx = prompt !== null && hasContext(prompt);
  const rowOk = row !== null && row[0] === RC && row[3] === t.run && row[4] === null && G.reasons.includes(row[2]);
  const agree = rowOk && (row[1] === "include") === ctx;
  return { row, ctx, ok: rowOk && agree && t.state === "completed" && prompt !== null && t.loops.length === 1,
    detail: `rows ${t.rows.length} [${strs(t.rows, (r) => (r === t.run ? "run" : "?"))}] (want 1 context.recall on the run, tool_call null) · prompts ${t.prompts.length} (want 1) [context] ${ctx} · include ⇔ [context] ${agree} · state ${t.state} (want completed) · loop_started ${t.loops.length} (want 1)` };
}

// ---- line 1: real retrieval over the copy; the merge-base build's loop_started has the same keys ----
async function line1() {
  const t = await workerTurn({ tag: "l1", text: G.query, env: MEMORY_FLAGS });
  const b = await workerTurn({ d: G.bd, store: G.baseStore, distDir: BASE_DIST, tag: "l1-base", text: G.query, env: MEMORY_FLAGS });
  const f = recallFacts(t);
  const newShape = keyShape(t.loops[0]); const baseShape = keyShape(b.loops[0]);
  const same = t.loops.length === 1 && b.loops.length === 1 && canon(newShape) === canon(baseShape);
  const telemetry = newShape.includes(".retrieval.facts.embedding");
  const ok = f.ok && same && telemetry && b.rows.length === 0 && b.state === "completed" && b.prompts.length === 1 && hasContext(b.prompts[0]) === f.ctx;
  return { ok, detail: `loop_started key paths ${newShape.length} vs merge base ${baseShape.length} identical ${same} (retrieval telemetry ${telemetry}) · ${f.detail} · verdict/reason ${f.row ? `${f.row[1]}/${f.row[2]}` : "none"} · merge base: R5 rows ${b.rows.length} (want 0) state ${b.state} [context] ${b.prompts.length === 1 && hasContext(b.prompts[0])} (want same as new ${f.ctx})` };
}

// ---- line 2: the embedder unreachable -> embed_failed or fts_only, never embedded ----
async function line2() {
  const t = await workerTurn({ tag: "l2", text: G.query, env: { ...MEMORY_FLAGS, HOUGE_EMBED_URL: "http://127.0.0.1:1" } });
  const f = recallFacts(t);
  const reasonOk = f.row !== null && ["embed_failed", "fts_only"].includes(f.row[2]);
  const noEmbedding = t.loops[0]?.retrieval?.facts?.embedding === false && t.loops[0]?.retrieval?.pages?.embedding === false;
  return { ok: f.ok && reasonOk && noEmbedding, detail: `${f.detail} · verdict/reason ${f.row ? `${f.row[1]}/${f.row[2]}` : "none"} (want embed_failed or fts_only, never embedded) · telemetry embedding false (facts, pages) ${noEmbedding}` };
}

// ---- line 3: two lane rows after a planner answer -> one inject/all row, the block in the prompt ----
async function line3() {
  const s = await fixtureTurn(() => seedLaneRows(G.d, G.store, FIX_CHAT, ["Houge replied: a1", "Houge replied: a2"]));
  const want = [[CU, "inject", "all", "a", null]];
  const block = s.prompts.length === 1 && s.prompts[0].includes(G.tc.CATCH_UP_OPEN);
  const ok = canon(s.rows) === canon(want) && block && s.calls[CU] === 1 && canon(s.done) === canon(["a:answer"]) && s.failed.length === 0 && s.state === "completed";
  return { ok, detail: `rows ${s.rows.length} [${strs(s.rows)}] (want 1 [cu:inject/all@a]) · catch-up block in the prompt ${block} (want true) · consults catch_up ${s.calls[CU] ?? 0} (want 1) · done ${s.done.length} (want 1) failed ${s.failed.length} (want 0) · state ${s.state}` };
}

// ---- line 4: a clarify turn, then a turn -> one cap/cap_reached row, the notice in the prompt ----
async function line4() {
  const s = await fixtureTurn(() => seedClarifyNow(FIX_CHAT)); G.clean.cap = s;
  const want = [[CC, "cap", "cap_reached", "a", null]];
  const notice = s.prompts.length === 1 && s.prompts[0].includes(G.tc.CLARIFY_CAP_NOTICE);
  const ok = canon(s.rows) === canon(want) && notice && s.calls[CC] === 1 && canon(s.done) === canon(["a:answer"]) && s.failed.length === 0 && s.state === "completed";
  return { ok, detail: `rows ${s.rows.length} [${strs(s.rows)}] (want 1 [cc:cap/cap_reached@a]) · CLARIFY_CAP_NOTICE in the prompt ${notice} (want true) · consults clarify_cap ${s.calls[CC] ?? 0} (want 1) · done ${s.done.length} (want 1) failed ${s.failed.length} (want 0)` };
}

// ---- line 5: lessons over a lowered cap at a spawn -> one capped/char_cap row on the spawning run; lesson_dropped as today ----
const droppedEvents = () => countOf("SELECT COUNT(*) AS n FROM ledger_events WHERE event_type = 'lesson_dropped'");
const openDropped = () => new Set(all("SELECT subject FROM incidents WHERE kind = 'lesson_dropped' AND state = 'open'").map((r) => r.subject));
async function line5() {
  const seeded = seedLessons(G.store, 2, 20);
  // the oracle is the dist's own renderer over the same read and env the spawn uses: the copy's real lessons skip too, not only the seeds
  const expect = G.lr.renderLessonSection(G.store, G.lr.OMP_LESSON_SCOPES, CAP40);
  const wantSubjects = expect.skipped.map((k) => `lesson:${k.lesson_id}`);
  const open0 = openDropped(); const ids0 = new Set(all("SELECT incident_id FROM incidents").map((r) => r.incident_id)); const ev0 = droppedEvents();
  const s = await fixtureTurn(null, { env: CAP40 });
  const freshAll = all("SELECT incident_id, kind, subject FROM incidents").filter((i) => !ids0.has(i.incident_id) && i.kind === "lesson_dropped").map((i) => i.subject).sort();
  const wantFresh = wantSubjects.filter((x) => !open0.has(x)).sort();
  const events = droppedEvents() - ev0;
  const seedsSkipped = seeded.filter((id) => wantSubjects.includes(`lesson:${id}`)).length;
  const want = [[LS, "capped", "char_cap", "a", null]];
  const ok = canon(s.rows) === canon(want) && expect.skipped.length > 0 && events === expect.skipped.length && canon(freshAll) === canon(wantFresh)
    && s.state === "completed" && canon(s.done) === canon(["a:answer"]);
  return { ok, detail: `rows ${s.rows.length} [${strs(s.rows)}] (want 1 [ls:capped/char_cap@a], the spawning run) · renderer at cap 40: rendered ${expect.ids.length} skipped ${expect.skipped.length} (seeds skipped ${seedsSkipped} of 2) · lesson_dropped events +${events} (want ${expect.skipped.length}) · new lesson_dropped incidents ${freshAll.length} (want ${wantFresh.length}: the skipped minus ${wantSubjects.length - wantFresh.length} already open) subjects exact ${canon(freshAll) === canon(wantFresh)} · state ${s.state}` };
}

// ---- line 6: the production wiring, CoreWorker.submitTurn -> line 4's row ----
async function line6() {
  const t = await workerTurn({ tag: "l6", text: "the pdf one", embed: async () => null, seed: () => seedClarifyNow(STUB_CHAT) });
  const mine = t.rows.map((r) => [r[0], r[1], r[2], r[3] === t.run ? "run" : "?", r[4]]);
  const notice = t.prompts.length === 1 && t.prompts[0].includes(G.tc.CLARIFY_CAP_NOTICE);
  const ok = canon(mine) === canon([[CC, "cap", "cap_reached", "run", null]]) && notice && t.state === "completed";
  return { ok, detail: `rows ${t.rows.length} [${strs(t.rows, (r) => (r === t.run ? "run" : "?"))}] (want 1 [cc:cap/cap_reached@run], tool_call null) · notice in the child's prompt ${notice} (want true) · state ${t.state} (want completed)` };
}

// ---- line 7: record faults never change the prompt ----
const failedIncidents = () => all("SELECT incident_id FROM incidents WHERE kind = 'decision_record_failed'").length;
const alertRows = () => all("SELECT notification_id, target_json FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'");
/** line 4's drive with insertDecision faulting: attempts, the incidents and alerts it added (scoped by id against the snapshot before it). */
async function faultedCap() {
  const real = G.store.insertDecision.bind(G.store); let attempts = 0;
  const ids0 = new Set(all("SELECT incident_id FROM incidents").map((r) => r.incident_id)); const alerts0 = new Set(alertRows().map((r) => r.notification_id));
  G.store.insertDecision = () => { attempts += 1; throw new Error("gate fault: insertDecision"); };
  let s;
  try { s = (await captured(() => fixtureTurn(() => seedClarifyNow(FIX_CHAT)))).value; } finally { G.store.insertDecision = real; }
  const fresh = all("SELECT incident_id, kind, subject FROM incidents").filter((i) => !ids0.has(i.incident_id)).map((i) => `${i.kind}/${i.subject}`);
  const alerts = alertRows().filter((r) => !alerts0.has(r.notification_id)).map((r) => String(JSON.parse(r.target_json).chat_id));
  return { s, attempts, fresh, alerts };
}
async function line7() {
  const clean = G.clean.cap;
  const f = await faultedCap();
  const fOk = f.attempts === 1 && canon(f.fresh) === canon([`decision_record_failed/${CC}`]) && f.alerts.length === 1 && f.alerts[0] === STUB_CHAT && f.s.rows.length === 0
    && effects(f.s) === effects(clean) && canon(f.s.prompts) === canon(clean.prompts);
  const inc0 = failedIncidents(); const a0 = alertRows().length;
  const cap = await captured(() => fixtureTurn(() => seedClarifyNow(FIX_CHAT), { recorder: { record: () => { throw new Error("gate fault: record"); } } }));
  const t = cap.value;
  const logged = cap.seen.filter((l) => l.startsWith(`decisions: ${CC} record threw past the recorder`)).length;
  const tOk = failedIncidents() - inc0 === 0 && alertRows().length - a0 === 0 && t.rows.length === 0 && effects(t) === effects(clean) && canon(t.prompts) === canon(clean.prompts) && logged === 1;
  return { ok: fOk && tOk, detail: `insert fault: attempts ${f.attempts} (want 1) new incidents ${f.fresh.length} [${f.fresh}] (want 1 [decision_record_failed/${CC}]) · alerts +${f.alerts.length} (want 1) to the stub ${f.alerts.every((c) => c === STUB_CHAT)} rows ${f.s.rows.length} (want 0) · prompt unchanged ${canon(f.s.prompts) === canon(clean.prompts)} effects unchanged ${effects(f.s) === effects(clean)} · thrown recorder: decision_record_failed +${failedIncidents() - inc0} (want 0) alerts +${alertRows().length - a0} (want 0) rows ${t.rows.length} (want 0) prompt unchanged ${canon(t.prompts) === canon(clean.prompts)} effects unchanged ${effects(t) === effects(clean)} logged for clarify_cap ${logged} (want 1)` };
}

// ---- line 8: /status and the registry ----
async function line8() {
  const sv = await import(join(DIST, "decisions/status-view.js")); const reg = await import(join(DIST, "decisions/registry.js"));
  const now = wall(); const since = new Date(Date.parse(now) - 24 * 3_600_000).toISOString(); // digest.ts decisionWindow: DIGEST_WINDOW_MS = 24 h, rows with since < created_at <= now
  const lines = sv.decisionStatusLines(G.store, now); const parts = []; let ok = true;
  for (const id of IDS) {
    const mine = lines.filter((l) => l.startsWith(`· ${id} `));
    const shown = mine.length === 1 ? Number(/^· \S+ (\d+) — /.exec(mine[0])?.[1] ?? NaN) : NaN;
    const inWindow = countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ?", id, since, now); // the store's own listDecisionsBetween predicate, which /status reads
    const total = idRows(id); const baseline = G.priorAt[id].filter((t) => t > since && t <= now).length; const want = baseline + WROTE[id];
    if (!(mine.length === 1 && shown === want && inWindow === want && total === G.priorAt[id].length + WROTE[id])) ok = false;
    parts.push(`${id} lines ${mine.length} (want 1), count ${Number.isNaN(shown) ? "none" : shown} (want ${want}; in-window baseline ${baseline} + wrote ${WROTE[id]}; SQL in window ${inWindow}; all rows ${total})`);
  }
  const e = IDS.map((id) => reg.entryById(id));
  if (!e.every((x) => x && x.locked !== true && x.stage === "pre_model")) ok = false;
  return { ok, detail: `${parts.join(" · ")} · registry stage/locked ${e.map((x) => `${x?.stage}/${x?.locked === true}`)} (want pre_model/false x4)` };
}

// ---- main ----
function pinEnv(root) {
  const flags = Object.keys(process.env).filter((k) => /^HOUGE_[A-Z0-9_]+_ENABLED$/.test(k) || k.startsWith("HOUGE_OMP_"));
  G.saved = Object.fromEntries([...SET_PINS, ...DELETE_PINS, ...flags, ...MEMORY_FLAGS_KEYS].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(G.saved)) delete process.env[k];
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT,
    HOUGE_OMP_BIN: "/nonexistent/houge-gate/omp", ...NO_CAP_ENV });
}
const MEMORY_FLAGS_KEYS = Object.keys(MEMORY_FLAGS);
function restoreEnv() {
  if (!G.saved) return;
  for (const k of [...FAKE_VARS, "HOUGE_EMBED_URL", ...MEMORY_FLAGS_KEYS]) delete process.env[k];
  for (const [k, v] of Object.entries(G.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  G.saved = null;
}
const killFiles = () => [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
/** Line 1's query: the title of the copy's lowest-id active wiki page (wiki pages are global; episodic facts are per chat and -1003 has none). Never printed. */
function pickQuery() {
  const row = G.store.db.prepare("SELECT title FROM wiki_pages WHERE status = 'active' ORDER BY id LIMIT 1").get();
  return row?.title ? String(row.title) : "what did we decide about the mac mini";
}
async function openStores() {
  G.d = await loadDist(DIST); G.bd = await loadDist(BASE_DIST);
  for (const k of ["storeOptionsFor", "RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "storeRecorder", "PlannerSupervisor", "CoreWorker", "lessonSetFingerprint", "ToolRegistry", "parseModelString", "selectorKey", "resolveOmpConfig"]) if (!G.d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  for (const k of ["storeOptionsFor", "RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "CoreWorker"]) if (!G.bd[k]) throw new SetupError(`${k} missing from the merge-base dist`);
  if (!existsSync(join(BASE_DIST, "omp/shell-wrapper.sh"))) throw new SetupError("merge-base dist has no omp/shell-wrapper.sh");
  G.store = G.d.RunStore.open(G.base, G.d.storeOptionsFor(undefined, {}));
  G.baseStore = G.bd.RunStore.open(G.baseCopy, G.bd.storeOptionsFor(undefined, {}));
  G.tc = await import(join(DIST, "omp/turn-context.js")); G.lr = await import(join(DIST, "run/lesson-render.js"));
  G.reasons = (await import(join(DIST, "decisions/entries/context-recall.js"))).RECALL_REASONS;
  if (!G.tc.CLARIFY_CAP_NOTICE || !G.tc.CATCH_UP_OPEN || !G.lr.renderLessonSection || !G.reasons) throw new SetupError("R5 exports missing from dist: rebuild");
}
async function setup() {
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  if (killFiles() !== 0) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  const root = initTemp(false); G.root = root;
  pinEnv(root);
  G.base = join(root, "houge.sqlite"); G.baseCopy = join(root, "merge-base.sqlite");
  vacuumInto(liveDb, G.base);
  copyFileSync(G.base, G.baseCopy); // before any store opens the copy: the merge-base turn sees the same rows line 1 does
  await openStores();
  const pending = parkOutbox(G.store) + parkOutbox(G.baseStore);
  G.query = pickQuery();
  // Line 8's baseline must be what /status counts: rows inside its window. One synthetic row per id dated 2 days ago is seeded on the copy
  // so a baseline over ALL rows fails line 8; the status window ignores them.
  const reg = await import(join(DIST, "decisions/registry.js"));
  for (const [id, v, reason] of [[RC, "none", "unscored"], [CU, "inject", "all"], [LS, "capped", "char_cap"], [CC, "cap", "cap_reached"]]) {
    const e = reg.entryById(id);
    G.store.insertDecision({ entry_id: id, entry_version: e.version, run_id: null, tool_call_id: null, stage: e.stage, rung: "rule", verdict: v, p: null, reason_code: reason,
      fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0, created_at: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString() });
  }
  G.priorAt = Object.fromEntries(IDS.map((id) => [id, all("SELECT created_at FROM decisions WHERE entry_id = ?", id).map((r) => r.created_at)]));
  note(`copy: ${pending} non-final outbox row(s) parked on the copies; prior rows of the four ids ${IDS.map((id) => G.priorAt[id].length).join(",")}`);
}
function closeAll() {
  for (const k of ["store", "baseStore"]) { try { G[k]?.close(); } catch { /* a closed handle is not a finding */ } G[k] = null; }
}
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });

try {
  await setup();
  const lines = [[1, "real recall over the copy, merge-base loop_started keys", line1], [2, "embedder unreachable is never embedded", line2], [3, "catch-up of two lane rows", line3],
    [4, "clarify cap reached", line4], [5, "lessons over a lowered cap at a spawn", line5], [6, "CoreWorker wiring writes the cap row", line6], [7, "record faults", line7],
    [8, "/status and the registry", line8]];
  for (const [n, name, fn] of lines) await runLine(n, name, fn);
  const tomb = killFiles();
  if (tomb !== 0) { out.push(false); console.log(`FAIL post houge.kill — found ${tomb} (want 0)`); }
  const passed = out.filter(Boolean).length;
  note(`${passed}/8 PASS · houge.kill in cwd/main checkout ${tomb} (want 0)`);
  process.exitCode = out.length === 8 && passed === 8 ? 0 : 1;
} catch (e) {
  console.error(e instanceof SetupError ? `setup_failed: ${e.message}` : `setup_failed: ${errCode(e)}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  await cleanup().catch(() => undefined);
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
