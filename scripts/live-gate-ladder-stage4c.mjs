#!/usr/bin/env node
// Live gate — decision ladder Stage 4C, memory.lesson_admit + schedule.admit + memory.correct_preflight (spec 2026-10-30 §7; plan Task 8).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-stage4c.mjs --old-dist <merge-base dist> [--live-db <path>]
// Prints only counts, ids of entries, verdicts and codes from a closed allowlist (anything else prints <other>); an exception prints its
// class name and code, never its message. There is no debug flag.
// Eight lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all eight PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. The live DB is opened read-only, once, by VACUUM INTO a temp copy; every write goes to
// copies of that copy under /tmp/hg-s4d-*, removed on every exit path (finally, SIGINT, SIGTERM, SIGHUP). No env file is loaded
// here (HOUGE_ENV_FILE only locates the DB), no Telegram adapter exists, and every notification stays in the copy's outbox.
// Every input is synthetic and every chat id is a fresh synthetic one, so no row of Paco's is ever read as test input.
// Lines 1-6 and 8 share one copy ("main") so line 8 reads the /status lines over what lines 1-6 recorded; line 7 uses three
// copies of its own. Line 6 drives the real bridge handler (bridgeTurn is ported from tests/helpers/omp-worker.ts, its first use).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, canon, cleanupTemp, initTemp, loadDist, mkTemp, redactForPrint } from "./stage4-diff-lib.mjs";
import { verifyStampedDist } from "./old-dist-provenance.mjs";
import { adminWorker, scheduleRun } from "./stage4-admit-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const STAMP = Date.now() * 1000; // idempotency-key base: unique against any real row on the copy
const PRIOR = "Want me to remember that?"; // a lesson that only restates the prior reply is refused by the backstop
const OPINION = "I think the south side noodle shop is better than the north one";
const FACT = "Paco prefers the south side noodle shop";
const EV = { line: 1, quote: "south side noodle shop is better" };
const J = (o) => JSON.stringify(o);
const BACKSTOP_WITH_FACT = J({ kind: "both", lesson: PRIOR, fact: FACT, evidence: EV });
const CLEAN_RULE = J({ kind: "rule", lesson: "gate-synthetic: end every reply with the word zephyr" });
const SPEC = { kind: "daily", at: "08:00" };
const out = []; // the eight verdicts
const note = (s) => console.error(`# ${s}`);
const ALLOWED = new Set(["scheduled-run", "code-owned", "already_saved_this_turn", "nothing_to_save", "not_offered", "not_operator_turn", "tainted_turn", "too_many", "bad_input",
  "scheduled_run", "code_owned", "lesson_backstop", "create", "exists", "cap", "not_found", "admit", "refuse"]);
const codeOf = (v) => (typeof v === "string" && ALLOWED.has(v) ? v : "<other>"); // a result string is printed only when it is a known code
const G = { d: null, o: null, base: null, root: null, main: null, n: 0, stores: [], baseline: null, expectIds: { admit: 0, sched: 0, pre: 0 } };
const nextN = () => STAMP + ++G.n;
const chatId = () => `-43${String(++G.n).padStart(4, "0")}`; // synthetic, never Paco's chat
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function verdict(n, name, ok, detail) {
  out.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${name} — ${redactForPrint(detail)}`);
}
/** The error's name plus its code when it has a short one; never the message. */
function errCode(e) {
  const name = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "non-Error";
  const code = typeof e?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(e.code) ? ` ${e.code}` : "";
  return `${name}${code}`;
}
/** A line body that returns { ok, detail }; a throw is that line's FAIL (a later line still runs). */
async function runLine(n, name, fn) {
  try { const r = await fn(); verdict(n, name, r.ok, r.detail); } catch (e) { verdict(n, name, false, `threw: ${errCode(e)}`); }
}

// ---- the live-DB copy and the stores opened on copies of it ----
/** VACUUM INTO `to` from `from` (read-only source). The daemon writes the live DB: a lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
/** A store on its own VACUUM copy of the base, opened as cli.ts opens it (storeOptionsFor). */
function openCopy(name, d = G.d) {
  const path = join(mkTemp(`cp-${name}`), "houge.sqlite");
  vacuumInto(G.base, path);
  const store = d.RunStore.open(path, d.storeOptionsFor ? d.storeOptionsFor(undefined) : {});
  G.stores.push(store);
  return store;
}
const countOf = (store, sql, ...args) => store.db.prepare(sql).get(...args).n;
const idRows = (store, id) => countOf(store, "SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", id);
const rowsOf = (store, run_id, id) => store.listDecisionsForRun(run_id).filter((r) => r.entry_id === id).map((r) => [r.verdict, r.reason_code]);
const openFailed = (store, subject) => countOf(store, "SELECT COUNT(*) AS n FROM incidents WHERE kind = 'decision_record_failed' AND subject = ? AND state = 'open'", subject);
const openFailedAll = (store) => countOf(store, "SELECT COUNT(*) AS n FROM incidents WHERE kind = 'decision_record_failed' AND state = 'open'");
const eventCount = (store, run_id, type) => countOf(store, "SELECT COUNT(*) AS n FROM ledger_events WHERE run_id = ? AND event_type = ?", run_id, type);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- runs and the memory-save worker ----
function intake(store, ev, d = G.d) {
  const r = new d.Gateway(store).intake(d.buildTypedTaskEvent(ev));
  if (!r.ok) throw new Error(`intake failed: ${JSON.stringify(r)}`);
  return r.run_id;
}
const BASE = { type: "turn", program: "turn" };
const later = (ms) => new Date(Date.now() + ms).toISOString();
/** A Paco turn (goal = his newest message) or a schedule-born run, on a fresh chat, after an earlier exchange in that chat. */
function seedRun(store, chat, o, d = G.d) {
  const notify = { kind: "telegram", chat_id: chat };
  const earlier = intake(store, { ...BASE, source: "telegram", goal: o.earlier ?? OPINION, requested_by: { kind: "user", id: "paco" }, notify,
    idempotency_key: `s4c:${nextN()}`, source_reference: `telegram:update:${nextN()}:message:1` }, d);
  store.recordChatTurn({ chat_id: chat, run_id: earlier, role: "user", text: o.earlier ?? OPINION, created_at: later(-60_000) });
  store.recordChatTurn({ chat_id: chat, run_id: earlier, role: "assistant", text: PRIOR, created_at: later(-59_000) });
  return o.schedule
    ? intake(store, { ...BASE, source: "schedule", goal: "daily brief: synthetic goal", requested_by: { kind: "schedule", id: "sch_t" }, notify,
      idempotency_key: `s4c:${nextN()}`, source_reference: "scheduled_tasks.sch_t" }, d)
    : intake(store, { ...BASE, source: "telegram", goal: o.goal ?? "remember it", requested_by: { kind: "user", id: "paco" }, notify,
      idempotency_key: `s4c:${nextN()}`, source_reference: `telegram:update:${nextN()}:message:2` }, d);
}
const seat = (distill) => async (input) => {
  const system = String(input.system ?? "");
  const answer = /durable/i.test(system) ? distill : /verdict/i.test(system) ? '{"verdict":"ADD"}' : '{"verdict":"ADD","theme":"format"}';
  return { ok: true, output: { answer } };
};
/** One runMemoryWrite on `store`. o: { distill, goal, earlier, schedule, plant, recorder }. Returns the outcome and the run's lesson_admit rows. */
async function memorySave(store, o, d = G.d) {
  const root = mkTemp("mem");
  if (o.plant) { mkdirSync(join(root, "project", "src"), { recursive: true }); copyFileSync(join(REPO, "src/capabilities/lesson-write.ts"), join(root, "project", "src", "lesson-write.ts")); }
  const worker = adminWorker(d, root, store, { llm: seat(o.distill ?? CLEAN_RULE), embed: async () => new Float32Array([0.1, 0.2]) });
  if (o.recorder) worker.recorderCache = o.recorder; // the lazily-built decision recorder behind the held admit rows
  const chat = chatId();
  const run_id = seedRun(store, chat, o, d);
  const claim = store.claimRun(run_id, `w:${run_id}`, 120);
  if (!claim) throw new Error("claim failed");
  worker.buildOmpTools(claim, chat);
  const res = await worker.runMemoryWrite(claim, chat, {}, { source: "loop" });
  return { res, run_id, rows: rowsOf(store, run_id, "memory.lesson_admit") };
}
const reasonOf = (res) => res.result?.output?.reason ?? null;
const fmt = (rows) => rows.map((x) => x.map(codeOf).join("/")).join(",");
/** The same save through the merge-base build on its own fresh copy: no admit rows there, and the full tool result must equal the new build's. */
async function sameAsOld(name, o, newRes) {
  const old = await memorySave(openCopy(`${name}-old`, G.o), o, G.o);
  return { equal: canon(old.res.result) === canon(newRes.result), oldRows: old.rows.length };
}

// ---- lines 1-4 ----
async function line1() {
  const o = { schedule: true, distill: BACKSTOP_WITH_FACT };
  const r = await memorySave(G.main, o);
  G.expectIds.admit += r.rows.length;
  const old = await sameAsOld("l1", o, r.res);
  const ok = reasonOf(r.res) === "scheduled-run" && same(r.rows, [["refuse", "scheduled_run"]]) && old.equal && old.oldRows === 0;
  return { ok, detail: `result reason ${codeOf(reasonOf(r.res))} · memory.lesson_admit rows ${r.rows.length} [${fmt(r.rows)}] (want 1 [refuse/scheduled_run]) · result equals the merge base's ${old.equal} (its admit rows ${old.oldRows})` };
}
/** The first words of SCHEDULED_RUN_HINT, read from the real src literal (never typed here): a phrase that exists in src/*.ts. */
function realSrcPhrase() {
  const m = /SCHEDULED_RUN_HINT =\s*"([^"]+)"/.exec(readFileSync(join(REPO, "src/capabilities/lesson-write.ts"), "utf8"));
  const phrase = m ? m[1].split(";")[0].trim() : "";
  if (phrase.length < 6 || phrase.includes('"')) throw new SetupError("could not read the SCHEDULED_RUN_HINT literal");
  return phrase;
}
async function line2() {
  const phrase = realSrcPhrase();
  const o = { plant: true, goal: `change the "${phrase}" wording please`, distill: BACKSTOP_WITH_FACT };
  const r = await memorySave(G.main, o);
  G.expectIds.admit += r.rows.length;
  const old = await sameAsOld("l2", o, r.res);
  const ok = reasonOf(r.res) === "code-owned" && same(r.rows, [["refuse", "code_owned"]]) && old.equal && old.oldRows === 0;
  return { ok, detail: `phrase read from src (${phrase.split(" ").length} words) · result reason ${codeOf(reasonOf(r.res))} · rows ${r.rows.length} [${fmt(r.rows)}] (want 1 [refuse/code_owned]) · result equals the merge base's ${old.equal} (its admit rows ${old.oldRows})` };
}
/** Each insertDecision's [entry_id, inside a transaction] while `fn` runs (the spy of tests/core/memory-write-admit.test.ts). */
async function withInsertSpy(store, fn) {
  const real = store.insertDecision.bind(store); const at = [];
  store.insertDecision = (row) => { at.push([row.entry_id, store.db.isTransaction]); return real(row); };
  try { return { value: await fn(), at }; } finally { store.insertDecision = real; }
}
async function line3() {
  const { value: r, at } = await withInsertSpy(G.main, () => memorySave(G.main, { distill: BACKSTOP_WITH_FACT }));
  G.expectIds.admit += r.rows.length;
  const facts = eventCount(G.main, r.run_id, "fact_saved");
  const kindForRun = G.main.listDecisionsForRun(r.run_id).filter((x) => x.entry_id === "memory.kind").length;
  const order = same(at, [["memory.kind", true], ["memory.lesson_admit", false]]);
  const ok = same(r.rows, [["refuse", "lesson_backstop"]]) && facts === 1 && kindForRun === 1 && r.res.saved?.fact !== undefined && order;
  return { ok, detail: `rows [${fmt(r.rows)}] (want refuse/lesson_backstop) · fact_saved ${facts}/1 · memory.kind ${kindForRun}/1 · kind in tx then admit outside: ${order}` };
}
async function line4() {
  const o = { distill: CLEAN_RULE };
  const r = await memorySave(G.main, o);
  G.expectIds.admit += r.rows.length;
  const saved = eventCount(G.main, r.run_id, "lesson_saved");
  const fresh = await memorySave(openCopy("l4-new"), o); // the lesson ids come from the copy: compare like with like
  const old = await sameAsOld("l4", o, fresh.res);
  const ok = r.rows.length === 0 && saved === 1 && r.res.committed === true && old.equal && old.oldRows === 0;
  return { ok, detail: `memory.lesson_admit rows ${r.rows.length} (want 0) · lesson_saved events ${saved} (want 1) · committed ${r.res.committed} · result equals the merge base's ${old.equal} (its admit rows ${old.oldRows})` };
}

// ---- line 5: schedule.admit ----
const mk = (goal) => ({ spec: SPEC, goal, tz: "Australia/Sydney" });
const schedRows = (store, run_id) => rowsOf(store, run_id, "schedule.admit");
/** create, create again, cancel another chat's id (all on `chat`); then the cap on a chat that already holds one schedule. Results against the dist's own builders. */
async function line5() {
  const cw = await import(join(DIST, "core/core-worker.js"));
  const chat = chatId(); const other = chatId(); const capChat = chatId();
  const add = (chat_id, goal) => G.main.addScheduledTask({ chat_id, goal, spec_json: J(SPEC), tz: "Australia/Sydney", next_run_at: "2099-01-01T00:00:00.000Z" }).schedule_id;
  const foreign = add(other, "gate synthetic other chat");
  const a = scheduleRun(G.d, G.main, "telegram", { chat });
  let created, exists, gone;
  try { created = a.call(mk("gate daily brief")); exists = a.call(mk("gate daily brief")); gone = a.call({ cancel: foreign }); add(capChat, "gate synthetic already"); } finally { a.close(); }
  const b = scheduleRun(G.d, G.main, "telegram", { chat: capChat, cap: 1 });
  let cap;
  try { cap = b.call(mk("gate another")); } finally { b.close(); }
  const got = schedRows(G.main, a.run_id); const gotCap = schedRows(G.main, b.run_id);
  G.expectIds.sched += got.length + gotCap.length;
  const mine = G.main.listScheduledTasks(chat); const row = mine[0];
  const digests = mine.length === 1 && created.ok && exists.ok && row.goal === "gate daily brief"
    && created.output.answer === cw.buildScheduleCreatedDigest(row.schedule_id, SPEC, row.tz, row.next_run_at)
    && exists.output.answer === cw.buildScheduleExistsDigest(row.schedule_id, SPEC, row.tz, row.next_run_at);
  const errors = gone.ok === false && gone.error === cw.SCHEDULE_TASK_CANCEL_NOT_FOUND_ERROR && cap.ok === false && cap.error === cw.buildScheduleCapError(1);
  const foreignStill = G.main.getScheduledTask(foreign)?.state === "enabled";
  const ok = same(got, [["admit", "create"], ["exists", "create"], ["refuse", "not_found"]]) && same(gotCap, [["refuse", "cap"]]) && digests && errors && foreignStill;
  return { ok, detail: `rows [${fmt(got)}] · cap [${fmt(gotCap)}] · chat schedules ${mine.length}/1 · digests = builders ${digests} · errors = constants ${errors} · other chat intact ${foreignStill}` };
}

// ---- line 6: memory_correct through the bridge preflight (bridgeTurn ported from tests/helpers/omp-worker.ts; its first use here) ----
const PASS_JUDGE = async (i) => ({ text: i.text, verdict: "pass", withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 0, unanswered: 0, skipped: false, blocked: null, decisionId: null, masked: 0 });
async function loadTurnMods() {
  const get = async (p, k) => (await import(join(DIST, p)))[k];
  return { TURN_ACTIONS: await get("contracts/task-contract.js", "TURN_ACTIONS"), chatWorkspace: await get("omp/workspace.js", "chatWorkspace") };
}
/** Claim the run, build the turn's registry, answer bridge `call` requests through the real bridge handler (policy, budget, approval, preflight). */
function bridgeTurn(d, mods, store, worker, run_id, dataDir) {
  const worker_id = `planner:gate:${run_id}`;
  const claim = store.claimRun(run_id, worker_id, 120);
  if (!claim) throw new Error(`claim failed: ${run_id}`);
  const tools = worker.buildOmpTools(claim);
  const target = store.getRunNotifyTarget(run_id);
  const chat_id = target.kind === "telegram" ? target.chat_id : "";
  const turn = { run_id, worker_id, chat_id, requester: store.getRunRequester(run_id), contract: claim.contract, budget: new d.BudgetLedger(claim.contract.budget),
    registry: tools.registry, signal: new AbortController().signal, cwd: mods.chatWorkspace(dataDir, chat_id), step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: tools.quarantine, setAwaitingApproval: () => undefined, postureOk: () => null, judge: PASS_JUDGE, ...(tools.preflight ? { preflight: tools.preflight } : {}) };
  const decls = d.loadToolDeclarations(d.TOOL_DECLS_DIR);
  if (!decls.ok) throw new Error(decls.error);
  const handle = d.createBridgeHandler({ store, cfg: d.resolveOmpConfig(process.env), ctx: { home: dataDir, repo: join(dataDir, "project"), data: dataDir },
    decls: decls.decls, env: process.env, turnEnvelopeActions: [...mods.TURN_ACTIONS], activeTurn: () => turn });
  let n = 0;
  return { turn, call: async (tool, input) => handle({ id: `r${++n}`, kind: "call", tool, input, toolCallId: `tc${n}` }) };
}
async function line6() {
  const mods = await loadTurnMods();
  const root = mkTemp("bridge");
  const store = G.main; const chat = chatId();
  const worker = adminWorker(G.d, root, store);
  const run_id = seedRun(store, chat, { goal: "forget the synthetic fact" });
  const { call } = bridgeTurn(G.d, mods, store, worker, run_id, root);
  const res = await call("memory_correct", { action: "retire", ids: [2_000_000_001] });
  const rows = rowsOf(store, run_id, "memory.correct_preflight");
  G.expectIds.pre += rows.length;
  const prompts = countOf(store, "SELECT COUNT(*) AS n FROM notification_outbox WHERE run_id = ? AND intent_type = 'approval_prompt'", run_id);
  const approvals = countOf(store, "SELECT COUNT(*) AS n FROM tool_approvals WHERE run_id = ?", run_id);
  const ok = same(rows, [["refuse", "not_offered"]]) && prompts === 0 && approvals === 0 && res.isError === true && String(res.content).startsWith("not_offered");
  return { ok, detail: `rows ${rows.length} [${fmt(rows)}] (want 1 [refuse/not_offered]) · approval_prompt notifications ${prompts} (want 0) · tool_approvals ${approvals} (want 0) · bridge isError ${res.isError} code ${codeOf(String(res.content).split(":")[0])}` };
}

// ---- line 7: the record faults ----
/** console.error captured (not printed) while `fn` runs; the lines are inspected, never echoed. */
async function captured(fn) {
  const real = console.error; const seen = [];
  console.error = (...a) => { seen.push(a.map(String).join(" ")); };
  try { return { value: await fn(), seen }; } finally { console.error = real; }
}
async function line7() {
  const base = await memorySave(openCopy("l7-base"), { schedule: true, distill: BACKSTOP_WITH_FACT });
  const sB = openCopy("l7-store"); let fired = 0; const real = sB.insertDecision.bind(sB);
  sB.insertDecision = (...a) => { if (++fired === 1) throw new Error("gate fault: insertDecision"); return real(...a); };
  const before = openFailed(sB, "memory.lesson_admit");
  const fault = await captured(() => memorySave(sB, { schedule: true, distill: BACKSTOP_WITH_FACT }));
  const opened = openFailed(sB, "memory.lesson_admit") - before;
  const sC = openCopy("l7-rec"); const beforeC = openFailedAll(sC);
  const thrower = { record: () => { throw new Error("gate fault: record"); } };
  const rec = await captured(() => memorySave(sC, { schedule: true, distill: BACKSTOP_WITH_FACT, recorder: thrower }));
  const openedC = openFailedAll(sC) - beforeC;
  const logged = rec.seen.filter((l) => l.startsWith("decisions: memory.lesson_admit record threw past the recorder")).length;
  const sameStore = same(fault.value.res.result, base.res.result); const sameRec = same(rec.value.res.result, base.res.result);
  const ok = fired >= 1 && opened === 1 && sameStore && fault.value.rows.length === 0 && openedC === 0 && sameRec && logged === 1 && rec.value.rows.length === 0 && reasonOf(base.res) === "scheduled-run";
  return { ok, detail: `fault ${fired >= 1 ? "once" : "never"}, incidents +${opened} (want 1), result same ${sameStore}, rows ${fault.value.rows.length} | recorder throw: incidents +${openedC} (want 0), result same ${sameRec}, logged ${logged} (want 1)` };
}

// ---- line 8: /status ----
async function line8() {
  const sv = await import(join(DIST, "decisions/status-view.js"));
  const now = new Date().toISOString(); const since = new Date(Date.parse(now) - 24 * 3_600_000).toISOString();
  const lines = sv.decisionStatusLines(G.main, now);
  const want = { "memory.lesson_admit": G.expectIds.admit, "schedule.admit": G.expectIds.sched, "memory.correct_preflight": G.expectIds.pre };
  const parts = []; let ok = true;
  for (const [id, n] of Object.entries(want)) {
    const mine = lines.filter((l) => l.startsWith(`· ${id} `));
    const shown = mine.length === 1 ? Number(/^· \S+ (\d+) — /.exec(mine[0])?.[1] ?? NaN) : NaN;
    const inWindow = countOf(G.main, "SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ? AND created_at >= ? AND created_at <= ?", id, since, now);
    if (!(mine.length === 1 && n > 0 && shown === inWindow && inWindow >= n)) ok = false;
    parts.push(`${id} lines ${mine.length}, count ${Number.isNaN(shown) ? "none" : shown} (window ${inWindow}, this gate's ${n})`);
  }
  return { ok, detail: parts.join(" · ") };
}

// ---- main ----
async function setup() {
  const oldDist = arg("--old-dist");
  if (!oldDist) throw new SetupError("usage: --old-dist <merge-base dist> [--live-db <path>]");
  try { verifyStampedDist(resolve(oldDist), DIST); } catch (e) { throw new SetupError(e instanceof Error ? e.message : "old dist provenance failed"); }
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  const root = initTemp(false); G.root = root;
  const daemon = join(root, "daemon"); mkdirSync(daemon, { recursive: true, mode: 0o700 });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: daemon, HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_OMP_BIN: "/nonexistent/houge-gate/omp", HOUGE_SCHEDULER_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  delete process.env.HOUGE_SCHEDULER_MAX_PER_CHAT;
  G.base = join(root, "base.sqlite");
  vacuumInto(liveDb, G.base);
  G.d = await loadDist(DIST); G.o = await loadDist(resolve(oldDist));
  for (const k of ["storeOptionsFor", "CoreWorker", "createBridgeHandler", "Gateway"]) if (!G.d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  G.main = openCopy("main");
  const ids = ["memory.lesson_admit", "schedule.admit", "memory.correct_preflight"];
  G.baseline = { kind: idRows(G.main, "memory.kind"), ...Object.fromEntries(ids.map((id) => [id, idRows(G.main, id)])) };
  if (ids.some((id) => G.baseline[id] !== 0)) note("the copy already holds rows of a new id (counts are taken as deltas)");
}
function closeAll() { for (const s of G.stores.splice(0)) { try { s.close(); } catch { /* a closed handle is not a finding */ } } }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { closeAll(); cleanupTemp(); process.exit(code); });

try {
  await setup();
  const lines = [[1, "scheduled-run save", line1], [2, "code-owned phrase", line2], [3, "backstop lesson + saved fact", line3], [4, "clean lesson save", line4],
    [5, "schedule admit/exists/cap/not_found", line5], [6, "memory_correct un-offered id via bridge", line6], [7, "record faults", line7], [8, "/status lines", line8]];
  for (const [n, name, fn] of lines) await runLine(n, name, fn);
  const passed = out.filter(Boolean).length;
  note(`${passed}/8 PASS`);
  process.exitCode = out.length === 8 && passed === 8 ? 0 : 1;
} catch (e) {
  console.error(`setup error: ${e instanceof SetupError ? e.message : "withheld"}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  closeAll();
  cleanupTemp();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
