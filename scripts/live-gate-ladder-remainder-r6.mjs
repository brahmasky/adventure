#!/usr/bin/env node
// Live gate — decision ladder remainder R6, lookup.rewrite + lookup.thin + turn.model (spec 2026-11-03 R6 §7; plan Task 6).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-remainder-r6.mjs [--live-db <path>]
// Seven lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all seven PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. Only counts, booleans, codes and run labels are printed, never message text or any id of the live DB.
// The live DB is opened read-only, once, by VACUUM INTO a temp copy under /tmp/hg-s4d-*, removed on every exit path (finally, SIGINT, SIGTERM, SIGHUP,
// SIGQUIT, uncaughtException, unhandledRejection). No env file is loaded (HOUGE_ENV_FILE only locates the DB). There is no real omp child (a fake session
// over the dist PlannerSupervisor for line 3 and line 6's pin, tests/fixtures/fake-omp.mjs under CoreWorker.submitTurn for lines 4 and 5), no web search, no
// reader or Tiny call (every network and model dep of the lookup lane is scripted), no subscription call and no Telegram client. Synthetic text only.
// Safety pins, set before any store opens and restored on exit: HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root (P2),
//   HOUGE_TELEGRAM_CHAT_ID = -1003 (P3: line 6's alert must not page Paco), every HOUGE_*_ENABLED flag and the omp, model-roles and embed variables deleted.
// Chats: the fixture supervisor is chat 42 (line 3, line 6's pin); lanes and CoreWorker turns run in the stub chat -1003. Every run is its own actor.
// Line 3 and the CoreWorker turns use a REAL RoleResolver over the copy (its model_tiers and overrides); only `readCatalog` is injected (the neutral
// tests/fixtures/omp-models.json through the dist's own parser), so no omp process answers a catalog query.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, canon, cleanupTemp, initTemp, loadDist, redactForPrint } from "./stage4-diff-lib.mjs";
import { cleanup, cleanupSettled, fakeSession, mkSupervisor, modelRefusal, removeDataDirsSync, req } from "./stage4-supervisor-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const FAKE_OMP = resolve(new URL("../tests/fixtures/fake-omp.mjs", import.meta.url).pathname);
const CATALOG_FIXTURE = resolve(new URL("../tests/fixtures/omp-models.json", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const STUB_CHAT = "-1003"; // numeric (CoreWorker refuses a non-numeric chat id before submit), not a real chat
const FIX_CHAT = "42"; // the fixture supervisor's chat
const RW = "lookup.rewrite"; const TH = "lookup.thin"; const TM = "turn.model"; const TR = "turn.retry"; const WALL = "tool.wall"; const FAM = "reader.family";
const IDS = [RW, TH, TM];
const BIG = 1_000_000_000;
const COMPOSE_RESERVE_MS = 15_000; // lookup-lane.ts COMPOSE_RESERVE_MS
const LATE_BOUND_MS = 40; // the rewrite's real-time bound in line 1's late drive (now() is frozen, so deadlineAt - reserve - now() is exactly this)
const SET_PINS = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID"];
const DELETE_PINS = ["HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_RATING_PENDING_MINUTES", "HOUGE_MODEL_ROLES", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG",
  "HOUGE_EMBED_URL", "HOUGE_EMBED_MODEL", "HOUGE_EMBED_TIMEOUT_MS", "HOUGE_MAX_CONSECUTIVE_CLARIFY", "HOUGE_LESSON_CAP_PER_SCOPE", "HOUGE_CHAT_CONTEXT_TURNS"];
const FAKE_VARS = ["HOUGE_OMP_BIN", "HOUGE_OMP_SANDBOX", "HOUGE_OMP_ENV_PASSTHROUGH", "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"];
// Rows this gate writes for the three ids before line 7 (a faulted or thrown record never lands):
//   lookup.rewrite = line 1 (2) + line 2 (2) = 4 (line 6's faulted-rewrite drive writes none, its thrown-recorder drive none);
//   lookup.thin    = line 1 (2) + line 2 (2) + line 6's faulted-rewrite drive (1: only the rewrite insert faults) = 5;
//   turn.model     = line 3 (static refused + resolved refused = 2) + line 4 (1) + line 5 (1) = 4 (line 6's pin drives write none).
const WROTE = { [RW]: 4, [TH]: 5, [TM]: 4 };
const out = [];
const G = { d: null, root: null, base: null, store: null, saved: null, n: 0, priorAt: {}, catalog: null, RR: null, worker: null, clean: {} };
const note = (s) => console.error(`# ${s}`);
const wall = () => new Date().toISOString();
const countOf = (sql, ...args) => G.store.db.prepare(sql).get(...args).n;
const all = (sql, ...args) => G.store.db.prepare(sql).all(...args).map((r) => ({ ...r }));
const idRows = (id) => countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", id);
const outboxN = () => countOf("SELECT COUNT(*) AS n FROM notification_outbox");

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
/** Marks every non-final outbox row of `store` failed_terminal (the copy is disposable); returns how many. */
const parkOutbox = (store) => store.db.prepare("UPDATE notification_outbox SET state = 'failed_terminal' WHERE state NOT IN ('delivered', 'failed_terminal')").run().changes;

/** One fresh Telegram turn run through the dist's gateway, its own actor; notify chat -1003. */
function mkRun(text) {
  G.n += 1;
  const gw = new G.d.Gateway(G.store, { ...G.d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG });
  const r = gw.intake(G.d.buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: `gate-r6-actor-${G.n}` },
    notify: { kind: "telegram", chat_id: STUB_CHAT }, idempotency_key: `gate-r6:${G.n}`, source_reference: `telegram:update:${G.n}:message:${G.n}` }));
  if (!r.ok) throw new Error("gate: run intake refused");
  return r.run_id;
}

/** The decision rows of `run` for `ids`, rowid order, as [entry, verdict, reason]. */
const rowsOf = (run, ids) => all("SELECT entry_id, verdict, reason_code FROM decisions WHERE run_id = ? ORDER BY rowid", run).filter((r) => ids.includes(r.entry_id)).map((r) => [r.entry_id, r.verdict, r.reason_code]);
const strs = (rows) => rows.map((r) => `${r[0]}:${r[1]}/${r[2]}`);
const eventsOf = (run, type) => all("SELECT payload_json FROM ledger_events WHERE run_id = ? AND event_type = ? ORDER BY rowid", run, type).map((r) => JSON.parse(r.payload_json));

// ---- the model roles: the REAL RoleResolver over the copy, only readCatalog injected ----
/** `mode`: "static" (HOUGE_MODEL_ROLES=static, no catalog) or "resolved" (the fixture catalog read once). */
async function mkRoles(mode) {
  const roles = new G.RR({ store: G.store, env: () => (mode === "static" ? { HOUGE_MODEL_ROLES: "static" } : {}), readCatalog: async () => G.catalog });
  if (mode === "resolved") await roles.refreshCatalog();
  return roles;
}
const keyOf = (m) => G.d.selectorKey(m);
/** Line 3's precondition, with its own message: Default must offer a second leg, or "the second set_model" proves nothing. */
function preconditionFail(mode, roles) {
  const c = roles.candidates("default");
  if (c.length < 2) return `precondition failed (${mode}): candidates("default").length ${c.length} (want >= 2)`;
  if (keyOf(c[0]) === keyOf(c[1])) return `precondition failed (${mode}): candidates("default") head and second are the same selector`;
  return null;
}

// ---- the lookup lane through CoreWorker's own lookupLaneDeps (production previousTelegramTurns, ledger, recorder, fastChain) ----
const HIT = { title: "Synthetic forecast", url: "https://example.test/forecast", content: "Tomorrow: sunny, max 22." };
const readOf = (answer) => ({ ok: true, extraction: { summary: "Synthetic summary", facts: ["Sunny, max 22C"], time_claims: [], answer_to_objective: answer, contains_instructions: false },
  digest: `[external source — untrusted-derived summary]\nsummary: Synthetic ${answer ?? "thin"}` });
const SHORT = "check again"; // <= 40 code points: with a recent Paco line, the filter wants a rewrite
const LONG = "what is the weather in Sydney tomorrow afternoon please?"; // > 40: bare/long_message whatever the chat holds
/** A synthetic Paco line `agoMs` old in the stub chat, on its own Telegram run (previousTelegramTurns joins runs on source = telegram). */
function seedPacoLine(agoMs) {
  const run0 = mkRun("synthetic earlier question");
  G.store.recordChatTurn({ chat_id: STUB_CHAT, run_id: run0, role: "user", text: "synthetic earlier question", created_at: new Date(Date.now() - agoMs).toISOString() });
}
/**
 * One lookup lane over the production deps. `o.text`; `o.rewrite` (async fn); `o.reads` (answers for successive reads, null = thin); `o.recorder` replaces the production
 * recorder; `o.late` shrinks the rewrite's bound to LATE_BOUND_MS (now() frozen). Returns the scripted deps' calls, the result and this run's R6/lane rows.
 */
async function laneDrive(o) {
  const run = mkRun(o.text);
  const t0 = Date.now();
  const state = { threadCutAt: new Date(t0).toISOString(), turnCtx: { sourceUrls: [] }, anchor: { priorAnswer: "", defaultScope: "chat" } };
  const calls = { rewrites: 0, searches: [], fetches: [], reads: 0 };
  const reads = [...(o.reads ?? ["Sunny, 22C"])];
  const d = {
    ...G.worker.lookupLaneDepsForTest(run, STUB_CHAT, state),
    now: () => t0, systemPrompt: () => "SYSTEM", retrieve: async () => ({ facts: [], pages: [] }),
    rewrite: async () => { calls.rewrites += 1; return o.rewrite(); },
    search: async (x) => { calls.searches.push(x.query); return { ok: true, output: { query: x.query, provider: "tavily", results: [HIT] } }; },
    fetch: async (x) => { calls.fetches.push(x.url); return { ok: true, output: { url: x.url, status: 200, bytes: 512, content: "page text" } }; },
    read: async () => { calls.reads += 1; return readOf(reads.length > 0 ? reads.shift() : "Sunny, 22C"); },
    compose: async () => ({ ok: true, provider: "anthropic", model: "claude-sonnet-5-5", answer: "Sunny tomorrow [1]." }),
    ...(o.recorder ? { recorder: o.recorder } : {})
  };
  const input = { run_id: run, chat_id: STUB_CHAT, userText: o.text, recentTurns: [], turnChars: 400, quoted: null, effort: "low", verdict_id: "jv_1", note: null,
    signal: new AbortController().signal, deadlineAt: t0 + COMPOSE_RESERVE_MS + (o.late ? LATE_BOUND_MS : 60_000) };
  const result = await G.d.runLookupLane(input, d);
  const rows = rowsOf(run, [WALL, FAM, RW, TH]);
  return { run, result, calls, rows, httpFetch: eventsOf(run, "http_fetch_performed").length, webSearch: eventsOf(run, "web_search_performed").length };
}
const answers = (text) => async () => ({ ok: true, provider: "kimi-code", model: "k3", answer: text });
const later = (ms, text) => () => new Promise((r) => setTimeout(() => r({ ok: true, provider: "kimi-code", model: "k3", answer: text }), ms));
/** The comparable face of a lane result (a reply's text, model, sources, catch-up). */
const resultOf = (r) => canon(r);

// ---- line 1 ----
const REWRITTEN = "Sydney weather tomorrow";
async function line1() {
  seedPacoLine(5 * 60_000);
  const a = await laneDrive({ text: SHORT, rewrite: answers(REWRITTEN) }); G.clean.rewrite = a;
  const b = await laneDrive({ text: SHORT, rewrite: later(300, "Late Sydney query"), late: true });
  const aOk = canon(a.calls.searches) === canon([REWRITTEN]) && a.calls.rewrites === 1 && canon(a.rows.map((r) => r.slice(0, 3))) === canon([[WALL, "crosses", null], [FAM, "fallback", null], [RW, "rewrite", "rewritten"], [TH, "none", "answered"]]);
  const bOk = canon(b.calls.searches) === canon([SHORT]) && b.calls.rewrites === 1 && b.rows.some((r) => r[0] === RW && r[1] === "bare" && r[2] === "late") && b.rows.filter((r) => r[0] === RW).length === 1;
  await new Promise((r) => setTimeout(r, 350)); // the late answer has landed by now: it must never have been searched
  const lateSearched = b.calls.searches.length;
  return { ok: aOk && bOk && lateSearched === 1 && a.result.kind === "reply" && b.result.kind === "reply",
    detail: `rewritten: rows [${strs(a.rows)}] (want tool.wall:crosses/null, reader.family:fallback/null, lookup.rewrite:rewrite/rewritten, lookup.thin:none/answered) searched ${a.calls.searches.length} (want 1, the scripted answer ${canon(a.calls.searches) === canon([REWRITTEN])}) rewrites ${a.calls.rewrites} (want 1) · late: rewrite row ${b.rows.filter((r) => r[0] === RW).map((r) => `${r[1]}/${r[2]}`)} (want bare/late) searched ${lateSearched} (want 1, the bare message ${canon(b.calls.searches) === canon([SHORT])}) result ${b.result.kind} (want reply)` };
}

// ---- line 2 ----
async function line2() {
  const thin = await laneDrive({ text: LONG, reads: [null, "Sunny, 22C"], rewrite: answers("unused") });
  const ans = await laneDrive({ text: LONG, reads: ["Sunny, 22C"], rewrite: answers("unused") });
  const order = [WALL, FAM, WALL, FAM, RW, TH];
  const thinOk = canon(thin.rows.map((r) => r[0])) === canon(order) && thin.rows[4][1] === "bare" && thin.rows[4][2] === "long_message" && thin.rows[5][1] === "fetch" && thin.rows[5][2] === "thin"
    && canon(thin.calls.fetches) === canon([HIT.url]) && thin.httpFetch === 1 && thin.calls.reads === 2 && thin.calls.rewrites === 0;
  const ansOk = canon(ans.rows.map((r) => r[0])) === canon([WALL, FAM, RW, TH]) && ans.rows[3][1] === "none" && ans.rows[3][2] === "answered" && ans.calls.fetches.length === 0 && ans.httpFetch === 0 && ans.calls.reads === 1;
  return { ok: thinOk && ansOk, detail: `thin read: rows [${strs(thin.rows)}] (want ${order.join(",")} with lookup.rewrite bare/long_message, lookup.thin fetch/thin) fetches ${thin.calls.fetches.length} (want 1, the first listed URL ${canon(thin.calls.fetches) === canon([HIT.url])}) http_fetch_performed ${thin.httpFetch} (want 1) reads ${thin.calls.reads} (want 2) · answered read: rows [${strs(ans.rows)}] (want tool.wall,reader.family,lookup.rewrite,lookup.thin with lookup.thin none/answered) fetches ${ans.calls.fetches.length} (want 0) http_fetch_performed ${ans.httpFetch} (want 0)` };
}

// ---- a fixture-supervisor turn on the chat-42 fake child (lines 3 and 6) ----
/**
 * One supervisor turn "hi" (run "a") with `roles` and a fake child whose set_model refuses `refuse` (that dist's PlannerRpcError). `recorder` defaults to the store
 * recorder. Returns the turn.model rows, the child's set_model targets in order, what the sink saw and the run state.
 */
async function pinTurn({ roles, refuse = [], recorder }) {
  let rig = null; let run = null;
  const session = fakeSession({ setModel: async (_m, k) => { if (refuse.includes(k)) throw modelRefusal(G.d, k); } });
  try {
    rig = mkSupervisor(G.d, G.store, { recorder: recorder ?? G.d.storeRecorder(G.store), session, extra: { roles } });
    run = mkRun("hi"); rig.sup.submit(req(run, "hi")); await rig.sup.whenIdle();
  } finally { await cleanup(); }
  const o = rig.outcome;
  return { run, rows: rowsOf(run, [TM]), targets: session.models.slice(), done: o.done.map((c) => c.text), failed: o.failed.map((c) => c.error_type), incidents: o.incidents.map((i) => i.k), state: G.store.getRunState(run) };
}
const pinEffects = (s) => canon({ targets: s.targets, done: s.done, failed: s.failed, incidents: s.incidents, state: s.state });

// ---- line 3 ----
async function line3() {
  const parts = []; let ok = true;
  for (const mode of ["static", "resolved"]) {
    const roles = await mkRoles(mode);
    const pre = preconditionFail(mode, roles);
    if (pre) return { ok: false, detail: pre };
    const c = roles.candidates("default"); const head = keyOf(c[0]); const second = keyOf(c[1]);
    const refused = await pinTurn({ roles, refuse: [head] }); if (mode === "resolved") G.clean.pin = refused;
    const accepted = await pinTurn({ roles });
    const rOk = canon(refused.rows) === canon([[TM, "fallback", "refused"]]) && refused.targets.length === 2 && refused.targets[0] === head && refused.targets[1] === second && refused.done.length === 1 && refused.failed.length === 0;
    const aOk = accepted.rows.length === 0 && canon(accepted.targets) === canon([head]) && accepted.done.length === 1;
    if (!(rOk && aOk)) ok = false;
    parts.push(`${mode}: candidates ${c.length} (want >= 2) · head refused: rows [${strs(refused.rows)}] (want turn.model:fallback/refused) set_model ${refused.targets.length} (want 2) first is head ${refused.targets[0] === head} second is candidates("default")[1] ${refused.targets[1] === second} · head accepted: turn.model rows ${accepted.rows.length} (want 0) set_model ${accepted.targets.length} (want 1)`);
  }
  return { ok, detail: parts.join(" · ") };
}

// ---- a CoreWorker turn on the fake omp (chat -1003) ----
const argvLines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
async function waitTerminal(run, ms = 30_000) {
  const end = Date.now() + ms;
  while (!TERMINAL.has(G.store.getRunState(run))) { if (Date.now() > end) throw new Error("gate: run did not finish"); await new Promise((r) => setTimeout(r, 20)); }
}
/** One CoreWorker (production deps; `roles` the real resolver) over the copy, the fake omp answering per `scenario`. Returns the run, its state, the set_model targets the child got and the rows. */
async function workerTurn({ tag, scenario, roles }) {
  const scenFile = join(G.root, `scenario-${tag}.json`); const argvLog = join(G.root, `argv-${tag}.log`);
  writeFileSync(scenFile, JSON.stringify(scenario));
  Object.assign(process.env, { HOUGE_OMP_BIN: FAKE_OMP, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG", FAKE_OMP_SCENARIO: scenFile, FAKE_OMP_ARGV_LOG: argvLog });
  const work = join(G.root, `work-${tag}`); mkdirSync(work, { recursive: true });
  let worker = null;
  try {
    const stub = async () => ({ ok: true, output: { answer: "stub" } });
    const noNet = async () => { throw new Error("gate: no network"); };
    worker = new G.d.CoreWorker(G.store, join(work, "project"), stub, undefined, undefined, undefined, undefined, undefined, undefined, async () => null, undefined, undefined,
      { dataDir: work, distDir: DIST, jevFetch: noNet, roles });
    const run = mkRun("first"); worker.submitTurn(run);
    await waitTerminal(run);
    const targets = argvLines(argvLog).map((l) => l.cmd).filter((c) => c?.type === "set_model").map((c) => `${c.provider}/${c.modelId}`);
    return { run, state: G.store.getRunState(run), targets, rows: rowsOf(run, [TM, TR]) };
  } finally {
    try { await worker?.shutdownPlanners(); } catch { /* a stopped planner is not a finding */ }
    for (const k of FAKE_VARS) delete process.env[k];
    process.env.HOUGE_OMP_BIN = "/nonexistent/houge-gate/omp";
  }
}

// ---- line 4 ----
async function line4() {
  const roles = await mkRoles("resolved");
  const pre = preconditionFail("resolved", roles); if (pre) return { ok: false, detail: pre };
  const c = roles.candidates("default"); const head = keyOf(c[0]); const second = keyOf(c[1]);
  const t = await workerTurn({ tag: "l4", scenario: { rpcSetModelRefuse: [head], "*": { rpcText: "ok" } }, roles });
  const ok = canon(t.rows) === canon([[TM, "fallback", "refused"]]) && t.state === "completed" && t.targets.length === 2 && t.targets[0] === head && t.targets[1] === second;
  return { ok, detail: `rows [${strs(t.rows)}] (want turn.model:fallback/refused, written through CoreWorker.submitTurn) · set_model ${t.targets.length} (want 2) head first ${t.targets[0] === head} second is candidates("default")[1] ${t.targets[1] === second} · state ${t.state} (want completed)` };
}

// ---- line 5 ----
async function line5() {
  const roles = await mkRoles("resolved");
  const pre = preconditionFail("resolved", roles); if (pre) return { ok: false, detail: pre };
  const head = keyOf(roles.candidates("default")[0]);
  const t = await workerTurn({ tag: "l5", scenario: { [head]: { rpcErrorText: "429 usage limit reached" }, "*": { rpcText: "ok" } }, roles });
  const ok = canon(t.rows) === canon([[TR, "retry", "quota"], [TM, "fallback", "next_leg"]]) && t.state === "completed";
  return { ok, detail: `rows in write order [${strs(t.rows)}] (want turn.retry:retry/quota then turn.model:fallback/next_leg) · state ${t.state} (want completed)` };
}

// ---- line 6: record faults never change the query or the pin ----
const failedIncidents = () => all("SELECT incident_id FROM incidents WHERE kind = 'decision_record_failed'").length;
const alertRows = () => all("SELECT notification_id, target_json FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'");
/** `drive` with insertDecision throwing for `entry` only: attempts, the incidents and alerts it added (scoped by id against the snapshot before it). */
async function faulted(entry, drive) {
  const real = G.store.insertDecision.bind(G.store); let attempts = 0;
  const ids0 = new Set(all("SELECT incident_id FROM incidents").map((r) => r.incident_id)); const alerts0 = new Set(alertRows().map((r) => r.notification_id));
  G.store.insertDecision = (row) => { if (row.entry_id === entry) { attempts += 1; throw new Error("gate fault: insertDecision"); } return real(row); };
  let value;
  try { value = (await captured(drive)).value; } finally { G.store.insertDecision = real; }
  const fresh = all("SELECT incident_id, kind, subject FROM incidents").filter((i) => !ids0.has(i.incident_id)).map((i) => `${i.kind}/${i.subject}`);
  const alerts = alertRows().filter((r) => !alerts0.has(r.notification_id)).map((r) => String(JSON.parse(r.target_json).chat_id));
  return { value, attempts, fresh, alerts };
}
const throwingRecorder = { record: () => { throw new Error("gate fault: record"); } };
async function line6() {
  const cleanLane = G.clean.rewrite; const cleanPin = G.clean.pin;
  const roles = await mkRoles("resolved");
  const pre = preconditionFail("resolved", roles); if (pre) return { ok: false, detail: pre };
  const head = keyOf(roles.candidates("default")[0]);
  const laneRun = () => laneDrive({ text: SHORT, rewrite: answers(REWRITTEN) });
  const pinRun = (recorder) => pinTurn({ roles, refuse: [head], ...(recorder ? { recorder } : {}) });
  const fl = await faulted(RW, laneRun); const fp = await faulted(TM, () => pinRun());
  const want = (entry) => canon([`decision_record_failed/${entry}`]);
  const laneOk = fl.attempts === 1 && canon(fl.fresh) === want(RW) && fl.alerts.length === 1 && fl.alerts[0] === STUB_CHAT && !fl.value.rows.some((r) => r[0] === RW)
    && canon(fl.value.calls.searches) === canon(cleanLane.calls.searches) && resultOf(fl.value.result) === resultOf(cleanLane.result) && fl.value.rows.some((r) => r[0] === TH);
  const pinOk = fp.attempts === 1 && canon(fp.fresh) === want(TM) && fp.alerts.length === 1 && fp.alerts[0] === STUB_CHAT && fp.value.rows.length === 0 && pinEffects(fp.value) === pinEffects(cleanPin);
  const inc0 = failedIncidents(); const a0 = alertRows().length;
  const tp = await captured(() => pinRun(throwingRecorder));
  // the lane's recorder is the deps' own: the throwing one replaces the production recorder for this drive
  const tl2 = await captured(() => laneDrive({ text: SHORT, rewrite: answers(REWRITTEN), recorder: throwingRecorder }));
  const logs = { [RW]: tl2.seen.filter((l) => l.startsWith(`decisions: ${RW} record threw past the recorder`)).length, [TH]: tl2.seen.filter((l) => l.startsWith(`decisions: ${TH} record threw past the recorder`)).length,
    [TM]: tp.seen.filter((l) => l.startsWith(`decisions: ${TM} record threw past the recorder`)).length };
  const t = tl2.value;
  const thrownOk = failedIncidents() - inc0 === 0 && alertRows().length - a0 === 0 && !t.rows.some((r) => r[0] === RW || r[0] === TH) && tp.value.rows.length === 0
    && canon(t.calls.searches) === canon(cleanLane.calls.searches) && resultOf(t.result) === resultOf(cleanLane.result) && pinEffects(tp.value) === pinEffects(cleanPin)
    && logs[RW] === 1 && logs[TH] === 1 && logs[TM] === 1;
  return { ok: laneOk && pinOk && thrownOk, detail: `lane insert fault: attempts ${fl.attempts} (want 1) new incidents [${fl.fresh}] (want decision_record_failed/${RW}) alerts +${fl.alerts.length} (want 1) to the stub ${fl.alerts.every((x) => x === STUB_CHAT)} rewrite row absent ${!fl.value.rows.some((r) => r[0] === RW)} query unchanged ${canon(fl.value.calls.searches) === canon(cleanLane.calls.searches)} result unchanged ${resultOf(fl.value.result) === resultOf(cleanLane.result)} · pin insert fault: attempts ${fp.attempts} (want 1) new incidents [${fp.fresh}] (want decision_record_failed/${TM}) alerts +${fp.alerts.length} (want 1) to the stub ${fp.alerts.every((x) => x === STUB_CHAT)} turn.model rows ${fp.value.rows.length} (want 0) pin unchanged ${pinEffects(fp.value) === pinEffects(cleanPin)} · thrown recorder: decision_record_failed +${failedIncidents() - inc0} (want 0) alerts +${alertRows().length - a0} (want 0) lane R6 rows ${t.rows.filter((r) => r[0] === RW || r[0] === TH).length} (want 0) pin rows ${tp.value.rows.length} (want 0) query unchanged ${canon(t.calls.searches) === canon(cleanLane.calls.searches)} pin unchanged ${pinEffects(tp.value) === pinEffects(cleanPin)} logged rewrite/thin/model ${logs[RW]}/${logs[TH]}/${logs[TM]} (want 1/1/1)` };
}

// ---- line 7: /status and the registry ----
async function line7() {
  const sv = await import(join(DIST, "decisions/status-view.js")); const reg = await import(join(DIST, "decisions/registry.js"));
  const now = wall(); const since = new Date(Date.parse(now) - 24 * 3_600_000).toISOString(); // digest.ts decisionWindow: 24 h, rows with since < created_at <= now
  const lines = sv.decisionStatusLines(G.store, now); const parts = []; let ok = true;
  for (const id of IDS) {
    const mine = lines.filter((l) => l.startsWith(`· ${id} `));
    const shown = mine.length === 1 ? Number(/^· \S+ (\d+) — /.exec(mine[0])?.[1] ?? NaN) : NaN;
    const inWindow = countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ? AND created_at > ? AND created_at <= ?", id, since, now); // the store's own listDecisionsBetween predicate
    const total = idRows(id); const baseline = G.priorAt[id].filter((t) => t > since && t <= now).length; const want = baseline + WROTE[id];
    if (!(mine.length === 1 && shown === want && inWindow === want && total === G.priorAt[id].length + WROTE[id])) ok = false;
    parts.push(`${id} lines ${mine.length} (want 1), count ${Number.isNaN(shown) ? "none" : shown} (want ${want}; in-window baseline ${baseline} + wrote ${WROTE[id]}; SQL in window ${inWindow}; all rows ${total})`);
  }
  const e = IDS.map((id) => reg.entryById(id));
  if (!e.every((x) => x && x.locked !== true && x.stage === "pre_model")) ok = false;
  return { ok, detail: `${parts.join(" · ")} · registry stage/locked ${e.map((x) => `${x?.stage}/${x?.locked === true}`)} (want pre_model/false x3)` };
}

// ---- main ----
function pinEnv(root) {
  const flags = Object.keys(process.env).filter((k) => /^HOUGE_[A-Z0-9_]+_ENABLED$/.test(k) || k.startsWith("HOUGE_OMP_"));
  G.saved = Object.fromEntries([...SET_PINS, ...DELETE_PINS, ...flags].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(G.saved)) delete process.env[k];
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT, HOUGE_OMP_BIN: "/nonexistent/houge-gate/omp" });
}
function restoreEnv() {
  if (!G.saved) return;
  for (const k of FAKE_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(G.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  G.saved = null;
}
const killFiles = () => [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
async function openStore() {
  G.d = await loadDist(DIST);
  for (const k of ["storeOptionsFor", "RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS", "storeRecorder", "PlannerSupervisor", "CoreWorker", "selectorKey", "PlannerRpcError", "runLookupLane", "parseModelString"]) if (!G.d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  G.RR = (await import(join(DIST, "omp/role-resolver.js"))).RoleResolver;
  const parse = (await import(join(DIST, "omp/model-catalog.js"))).parseOmpCatalog;
  G.catalog = parse(readFileSync(CATALOG_FIXTURE, "utf8"));
  if (!G.RR || !G.catalog) throw new SetupError("RoleResolver or the catalog fixture missing: rebuild");
  G.store = G.d.RunStore.open(G.base, G.d.storeOptionsFor(undefined, {}));
}
async function setup() {
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  if (killFiles() !== 0) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  const root = initTemp(false); G.root = root;
  pinEnv(root);
  G.base = join(root, "houge.sqlite");
  vacuumInto(liveDb, G.base);
  await openStore();
  const pending = parkOutbox(G.store);
  // a CoreWorker for the lane deps seam (lines 1, 2, 6): the real resolver (fast and tiny chains), the fake omp binary never spawned (every model dep is scripted)
  const work = join(root, "work-lane"); mkdirSync(work, { recursive: true });
  const roles = await mkRoles("resolved");
  G.worker = new G.d.CoreWorker(G.store, join(work, "project"), async () => ({ ok: true, output: { answer: "stub" } }), undefined, undefined, undefined, undefined, undefined, undefined,
    async () => null, undefined, undefined, { dataDir: work, distDir: DIST, jevFetch: async () => { throw new Error("gate: no network"); }, roles });
  // Line 7's baseline must be what /status counts: rows inside its window. One synthetic row per id dated 2 days ago so a baseline over ALL rows fails it.
  const reg = await import(join(DIST, "decisions/registry.js"));
  for (const [id, v, reason] of [[RW, "bare", "no_recent_line"], [TH, "none", "answered"], [TM, "fallback", "refused"]]) {
    const e = reg.entryById(id);
    if (!e) throw new SetupError(`${id} missing from the registry: rebuild`);
    G.store.insertDecision({ entry_id: id, entry_version: e.version, run_id: null, tool_call_id: null, stage: e.stage, rung: "rule", verdict: v, p: null, reason_code: reason,
      fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0, created_at: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString() });
  }
  G.priorAt = Object.fromEntries(IDS.map((id) => [id, all("SELECT created_at FROM decisions WHERE entry_id = ?", id).map((r) => r.created_at)]));
  note(`copy: ${pending} non-final outbox row(s) parked; prior rows of the three ids ${IDS.map((id) => G.priorAt[id].length).join(",")}`);
}
function closeAll() { try { G.store?.close(); } catch { /* a closed handle is not a finding */ } G.store = null; }
// PlannerSupervisor.shutdown can wait ~5 s on a draining turn before it stops the session; the bound covers that plus margin.
const SETTLE_BOUND_MS = 15_000;
/** Every exit path removes the copy and the fixture's hsv-* workdirs: the signals (SIGKILL cannot be caught), and an exception or rejection that escapes the main try. */
function bail(code) {
  Promise.race([cleanupSettled().catch(() => undefined), new Promise((r) => setTimeout(r, SETTLE_BOUND_MS))])
    .finally(() => { removeDataDirsSync(); closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });
}
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]]) process.on(sig, () => bail(code));
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.error(`${ev}: ${errCode(e)}`); bail(2); });

try {
  await setup();
  const lines = [[1, "rewrite: rewritten, then late", line1], [2, "thin read fetches once, answered does not", line2], [3, "real RoleResolver: refused head falls to the second", line3],
    [4, "CoreWorker wiring writes the refused row", line4], [5, "quota retry then next_leg", line5], [6, "record faults", line6], [7, "/status and the registry", line7]];
  for (const [n, name, fn] of lines) await runLine(n, name, fn);
  const tomb = killFiles();
  if (tomb !== 0) { out.push(false); console.log(`FAIL post houge.kill — found ${tomb} (want 0)`); }
  const passed = out.filter(Boolean).length;
  note(`${passed}/7 PASS · houge.kill in cwd/main checkout ${tomb} (want 0)`);
  process.exitCode = out.length === 7 && passed === 7 ? 0 : 1;
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
