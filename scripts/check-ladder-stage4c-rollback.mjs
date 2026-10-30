#!/usr/bin/env node
// Rollback check — decision ladder Stage 4C, memory.lesson_admit + schedule.admit + memory.correct_preflight (spec 2026-10-30 §7; plan Task 9).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-ladder-stage4c-rollback.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-c558413/dist [--old-base <full sha>] [--live-db <path>]
// --old-base <full sha>: the base the old build must be pinned to; required once the branch is merged (merge-base of HEAD and main is then HEAD itself).
// 4C adds record-only decision rows (no migration, no table). Two VACUUM copies of the live DB: A (this build writes one row of each new id
// through its own call sites, as scripts/live-gate-ladder-stage4c.mjs does; then the merge base c558413 opens it; then this build reopens it)
// and F (only c558413 ever opens it; VACUUMed from A before A is touched). c558413 does the same things on both: open (the schema must be
// byte-identical before and after: no migration), render /status + digest + /status decisions, and refuse review_ok outcomes naming each
// new id (outcomes.ts validates against its own ENTRY_IDS). insertLadderMove is NOT id-validated (plan P2) and is not probed.
// PASS = nothing throws, no row count drops, the seeded rows are byte-identical after the old build, and A and F differ only in the stated
// way: A's /status carries a count line per new id (F's carry none) and every other count line equals F's plus the seed's own per-entry delta.
// Dropped from the 4B check (4C touches none of them): the bind/redact/standing seeds and their survival line, the approval resolve, the
// resume and masked-report probes, the schedule tick probe, and the "old build writes no bind/redact row" line. The 4A standing rows are not
// a 4C surface, and the old build's own behaviour is unchanged by rows it does not know. Kept: A/F structure, count-line delta, row identity,
// growth equality, review_ok refusal, reopen by this build.
// Exit 0 PASS · 1 FAIL · 2 setup error. There is no debug flag. The live DB is read only by VACUUM INTO; every write goes to the copies, which
// live under /tmp/hg-s4d-* and are removed on every exit path (pass, FAIL, throw, SIGINT, SIGTERM, SIGHUP). Every chat and text is synthetic,
// nothing is sent anywhere (no Telegram adapter exists). Rendered text may hold Paco's data: nothing here prints it, only line names, entry
// ids, counts, verdicts and codes from closed sets; an exception prints a class name and code from closed sets, never its message.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { mergeBaseOf, provenanceText, verifyStampedDist } from "./old-dist-provenance.mjs";
import { adminWorker, scheduleRun } from "./stage4-admit-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
let phase = "setup";

const NEW_IDS = ["memory.lesson_admit", "schedule.admit", "memory.correct_preflight"];
const TABLES = ["decisions", "decision_outcomes", "scheduled_tasks", "tool_approvals", "notification_outbox"];
const COUNT_RE = /^· ([a-z_]+(?:\.[a-z_]+)+) (\d+) — /;
const STAMP = Date.now() * 1000;
const failures = [];
const J = (o) => JSON.stringify(o);
const same = (a, b) => J(a) === J(b);
const keyOf = (...v) => v.join("|");
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
let seq = 0;
const nextN = () => STAMP + ++seq;
const chatId = () => `-43${String(++seq).padStart(4, "0")}`; // synthetic, never Paco's chat
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const handles = [];
const yieldLoop = () => new Promise((r) => setImmediate(r)); // lets a SIGINT/SIGTERM handler run during an otherwise synchronous run
const later = (ms) => new Date(Date.now() + ms).toISOString();

/** Closed sets (never the message): a standard error class name, and a Node/SQLite system code shape; anything else prints `<other>`. */
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError", "AbortError"]);
/** A literal closed set of Node and SQLite error codes (a code outside it prints <other>). */
const SYSTEM_CODES = new Set(["ERR_SQLITE_ERROR", "ERR_MODULE_NOT_FOUND", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_STATE", "ERR_ASSERTION",
  "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CONSTRAINT", "SQLITE_CORRUPT", "SQLITE_FULL", "SQLITE_IOERR", "SQLITE_READONLY", "SQLITE_CANTOPEN",
  "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOSPC", "EBUSY", "EISDIR", "ENOTDIR", "EMFILE", "ETIMEDOUT", "ECONNREFUSED", "ESRCH"]);
function errCode(e) {
  const name = e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error";
  const code = typeof e?.code === "string" ? (SYSTEM_CODES.has(e.code) ? ` ${e.code}` : " <other>") : "";
  return `${name}${code}`;
}

/** VACUUM INTO `to` from `from` (read-only source); a daemon write lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt_ = 1; ; attempt_++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt_ >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
/** A store of dist `d` on `path`, opened as cli.ts opens it (storeOptionsFor when the dist has it). */
function openStore(d, path) {
  const store = d.RunStore.open(path, d.storeOptionsFor ? d.storeOptionsFor(undefined) : {});
  handles.push(store);
  return store;
}
const closeStore = (s) => { try { s.close(); } catch { /* a closed handle is not a finding */ } };
const ro = (path, fn) => { const db = new DatabaseSync(path, { readOnly: true }); try { return fn(db); } finally { db.close(); } };
const counts = (path) => ro(path, (db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])));
const entryCount = (path, id) => ro(path, (db) => db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?`).get(id).n);
/** The schema as a hash (every object's type, name, sql) plus user_version: a migration changes it. */
const schemaOf = (path) => ro(path, (db) => ({
  uv: db.prepare("PRAGMA user_version").get().user_version,
  hash: createHash("sha256").update(J(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all())).digest("hex").slice(0, 12),
}));
/** The seeded decision rows, whole, as one hash: a changed or rewritten row differs. */
const rowsHash = (path, ids) => ro(path, (db) => createHash("sha256").update(J(ids.map((id) => db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(id) ?? null))).digest("hex").slice(0, 12));

// ---- the new build's call sites (copied from live-gate-ladder-stage4c.mjs: importing that script runs its main) ----
const PRIOR = "Want me to remember that?";
const OPINION = "I think the south side noodle shop is better than the north one";
const FACT = "Paco prefers the south side noodle shop";
const BACKSTOP_WITH_FACT = J({ kind: "both", lesson: PRIOR, fact: FACT, evidence: { line: 1, quote: "south side noodle shop is better" } });
const SPEC = { kind: "daily", at: "08:00" };
const BASE_EV = { type: "turn", program: "turn" };
function intake(store, ev, d) {
  const r = new d.Gateway(store).intake(d.buildTypedTaskEvent(ev));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}
/** A Paco turn (or schedule-born run) on a fresh chat, after an earlier exchange in it. */
function seedRun(store, chat, o, d) {
  const notify = { kind: "telegram", chat_id: chat };
  const earlier = intake(store, { ...BASE_EV, source: "telegram", goal: OPINION, requested_by: { kind: "user", id: "paco" }, notify,
    idempotency_key: `s4c-rb:${nextN()}`, source_reference: `telegram:update:${nextN()}:message:1` }, d);
  store.recordChatTurn({ chat_id: chat, run_id: earlier, role: "user", text: OPINION, created_at: later(-60_000) });
  store.recordChatTurn({ chat_id: chat, run_id: earlier, role: "assistant", text: PRIOR, created_at: later(-59_000) });
  return o.schedule
    ? intake(store, { ...BASE_EV, source: "schedule", goal: "daily brief: synthetic goal", requested_by: { kind: "schedule", id: "sch_t" }, notify,
      idempotency_key: `s4c-rb:${nextN()}`, source_reference: "scheduled_tasks.sch_t" }, d)
    : intake(store, { ...BASE_EV, source: "telegram", goal: o.goal ?? "remember it", requested_by: { kind: "user", id: "paco" }, notify,
      idempotency_key: `s4c-rb:${nextN()}`, source_reference: `telegram:update:${nextN()}:message:2` }, d);
}
const seat = (distill) => async (input) => {
  const system = String(input.system ?? "");
  const answer = /durable/i.test(system) ? distill : /verdict/i.test(system) ? '{"verdict":"ADD"}' : '{"verdict":"ADD","theme":"format"}';
  return { ok: true, output: { answer } };
};
const rowsOf = (store, run_id, id) => store.listDecisionsForRun(run_id).filter((r) => r.entry_id === id).map((r) => [r.verdict, r.reason_code]);
/** A scheduled-run lesson save: one memory.lesson_admit refuse/scheduled_run row. */
async function writeLessonAdmit(d, store) {
  const worker = adminWorker(d, mkTemp("mem"), store, { llm: seat(BACKSTOP_WITH_FACT), embed: async () => new Float32Array([0.1, 0.2]) });
  const chat = chatId();
  const run_id = seedRun(store, chat, { schedule: true }, d);
  const claim = store.claimRun(run_id, `w:${run_id}`, 120);
  if (!claim) throw new Error("claim failed");
  worker.buildOmpTools(claim, chat);
  const res = await worker.runMemoryWrite(claim, chat, {}, { source: "loop" });
  return { ok: res.result?.output?.reason === "scheduled-run", rows: rowsOf(store, run_id, "memory.lesson_admit") };
}
/** A schedule_task create on a fresh chat: one schedule.admit admit/create row. */
function writeScheduleAdmit(d, store) {
  const chat = chatId();
  const a = scheduleRun(d, store, "telegram", { chat });
  let created;
  try { created = a.call({ spec: SPEC, goal: "rollback synthetic brief", tz: "Australia/Sydney" }); } finally { a.close(); }
  return { ok: created.ok === true, rows: rowsOf(store, a.run_id, "schedule.admit") };
}
const PASS_JUDGE = async (i) => ({ text: i.text, verdict: "pass", withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 0, unanswered: 0, skipped: false, blocked: null, decisionId: null, masked: 0 });
/** Claim the run, build the turn's registry, answer bridge `call` requests through the real bridge handler (bridgeTurn of the 4C gate). */
async function writePreflight(d, store, root) {
  const worker = adminWorker(d, root, store);
  const chat = chatId();
  const run_id = seedRun(store, chat, { goal: "forget the synthetic fact" }, d);
  const worker_id = `planner:rb:${run_id}`;
  const claim = store.claimRun(run_id, worker_id, 120);
  if (!claim) throw new Error("claim failed");
  const tools = worker.buildOmpTools(claim);
  const chatWorkspace = (await import(join(DIST, "omp/workspace.js"))).chatWorkspace;
  const TURN_ACTIONS = (await import(join(DIST, "contracts/task-contract.js"))).TURN_ACTIONS;
  const turn = { run_id, worker_id, chat_id: chat, requester: store.getRunRequester(run_id), contract: claim.contract, budget: new d.BudgetLedger(claim.contract.budget),
    registry: tools.registry, signal: new AbortController().signal, cwd: chatWorkspace(root, chat), step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: tools.quarantine, setAwaitingApproval: () => undefined, postureOk: () => null, judge: PASS_JUDGE, ...(tools.preflight ? { preflight: tools.preflight } : {}) };
  const decls = d.loadToolDeclarations(d.TOOL_DECLS_DIR);
  if (!decls.ok) throw new Error("tool declarations failed");
  const handle = d.createBridgeHandler({ store, cfg: d.resolveOmpConfig(process.env), ctx: { home: root, repo: join(root, "project"), data: root },
    decls: decls.decls, env: process.env, turnEnvelopeActions: [...TURN_ACTIONS], activeTurn: () => turn });
  const res = await handle({ id: "r1", kind: "call", tool: "memory_correct", input: { action: "retire", ids: [2_000_000_001] }, toolCallId: "tc1" });
  return { ok: res.isError === true && String(res.content).startsWith("not_offered"), rows: rowsOf(store, run_id, "memory.correct_preflight") };
}

/** Step 1, this build on A: one row of each new id through its own call site. Returns the seed's per-entry and per-decider delta and its rows. */
async function seedA(dNew, path, root) {
  const s = openStore(dNew, path);
  const t0 = new Date().toISOString();
  const lesson = await writeLessonAdmit(dNew, s); await yieldLoop();
  const sched = writeScheduleAdmit(dNew, s); await yieldLoop();
  const pre = await writePreflight(dNew, s, root); await yieldLoop();
  const rows = s.db.prepare(`SELECT decision_id, entry_id, rung FROM decisions WHERE created_at >= ?`).all(t0);
  const ids = new Set(rows.map((r) => r.decision_id));
  const seedRows = s.listRecentDecisions(500).filter((r) => ids.has(r.decision_id)); // newest first, as the list renders them
  closeStore(s);
  const delta = {}; const rungs = {};
  for (const r of rows) { delta[r.entry_id] = (delta[r.entry_id] ?? 0) + 1; ((rungs[r.entry_id] ??= {})[r.rung] = (rungs[r.entry_id][r.rung] ?? 0) + 1); }
  return { delta, rungs, seedRows, seedKeys: rows.map((r) => r.decision_id), results: { lesson, sched, pre } };
}

// ---- primary-key identity of the tracked tables ----
function keysOfFull(path) {
  return ro(path, (db) => Object.fromEntries(TABLES.map((t) => {
    const pk = db.prepare(`PRAGMA table_info(${t})`).all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const cols = pk.length ? pk : ["rowid"];
    return [t, new Set(db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${t}`).all().map((r) => cols.map((c) => String(r[c])).join("|")))];
  })));
}
const lost = (before, after) => Object.fromEntries(TABLES.map((t) => [t, [...before[t]].filter((k) => !after[t].has(k)).length]));
function identity(name, before, after) {
  const l = lost(before, after);
  check(`row identity: every key of ${name} still present`, TABLES.every((t) => l[t] === 0), TABLES.map((t) => `${t} ${before[t].size} keys, ${l[t]} lost`).join(" · "));
}
const noDrop = (name, before, after) => {
  const dropped = TABLES.filter((t) => after[t] < before[t]);
  check(`row counts never drop: ${name}`, dropped.length === 0, dropped.length ? dropped.map((t) => `${t} ${before[t]} -> ${after[t]}`).join(", ") : TABLES.map((t) => `${t} ${before[t]}->${after[t]}`).join(" · "));
};

// ---- rendering and comparison (as the 4B check; no secret.redact suffix in 4C) ----
const norm = (l) => l.replace(/\b\d\d-\d\d \d\d:\d\d\b/g, "<ts>").replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, "<id>").replace(/\b(run|tool|op|dec)_[0-9A-Za-z-]+/g, "<id>").replace(/ run [0-9a-f]{8}\b/g, " run <id>")
  .replace(/\d{4}-\d\d-\d\d(?:T[\d:.]+Z?)?/g, "<ts>").replace(/\b\d\d:\d\d\b/g, "<ts>");
function render(m, store, now) {
  const dg = m.buildDecisionDigest(store, now, { ...process.env, HOUGE_IMPROVE_ENABLED: "false" });
  return { status: m.decisionStatusLines(store, now), digest: dg && dg.text ? dg.text.split("\n") : null, list: m.decisionListText(store, process.env).split("\n") };
}
const RUNGS = ["rule", "system_one", "model", "paco", "fail"];
function fmtCount(id, m, label) {
  const known = RUNGS.filter((k) => m.has(k)).map((k) => `${label(k)} ${m.get(k)}`);
  const other = [...m.keys()].filter((k) => !RUNGS.includes(k)).sort().map((k) => `${k} ${m.get(k)}`);
  return `· ${id} ${[...m.values()].reduce((a, b) => a + b, 0)} — ${[...known, ...other].join(" · ")}`;
}
function parseCount(line, label) {
  const m = /^· (\S+) \d+ — (.*)$/.exec(line);
  const byLabel = new Map(RUNGS.map((k) => [label(k), k]));
  return [m[1], new Map(m[2].split(" · ").map((part) => { const [lab, n] = [part.slice(0, part.lastIndexOf(" ")), Number(part.slice(part.lastIndexOf(" ") + 1))]; return [byLabel.get(lab) ?? lab, n]; }))];
}
const countLinesOf = (lines) => lines.filter((l) => COUNT_RE.test(l));
const countMap = (lines) => new Map(lines.flatMap((l) => { const m = COUNT_RE.exec(l); return m ? [[m[1], Number(m[2])]] : []; }));
/** A's /status against F's. Non-count lines equal; each count line is F's plus the seed's per-decider delta, compared whole. */
function cmpStatus(a, f, rungs, label) {
  const bad = [];
  const [oa, of] = [a.filter((l) => !COUNT_RE.test(l)).map(norm), f.filter((l) => !COUNT_RE.test(l)).map(norm)];
  if (!same(oa, of)) bad.push(`non-count lines differ (A ${oa.length}, F ${of.length})`);
  const base = new Map(countLinesOf(f).map((l) => parseCount(l, label)));
  for (const id of NEW_IDS) if (base.has(id)) bad.push(`${id}: F carries a line`);
  for (const [id, byRung] of Object.entries(rungs)) {
    const m = base.get(id) ?? new Map();
    for (const [k, n] of Object.entries(byRung)) m.set(k, (m.get(k) ?? 0) + n);
    base.set(id, m);
  }
  const want = [...base.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([id, m]) => fmtCount(id, m, label));
  const got = countLinesOf(a);
  const [gm, wm] = [new Map(got.map((l) => [COUNT_RE.exec(l)[1], l])), new Map(want.map((l) => [COUNT_RE.exec(l)[1], l]))];
  for (const id of new Set([...gm.keys(), ...wm.keys()])) {
    if (gm.get(id) !== wm.get(id)) bad.push(`${id}: A total ${COUNT_RE.exec(gm.get(id) ?? "")?.[2] ?? "absent"}, expected ${COUNT_RE.exec(wm.get(id) ?? "")?.[2] ?? "absent"}${gm.has(id) && wm.has(id) ? " (breakdown differs)" : ""}`);
  }
  if (!same(got.map((l) => COUNT_RE.exec(l)[1]), want.map((l) => COUNT_RE.exec(l)[1]))) bad.push("count line order differs");
  return bad;
}
const cmpDigest = (a, f) => {
  if (!a || !f || a.length === 0 || f.length === 0) return [`digest did not render (A ${a ? a.length : "null"}, F ${f ? f.length : "null"})`];
  return same(a.map(norm), f.map(norm)) ? [] : [`digest lines differ (A ${a.length}, F ${f.length})`];
};
const listLine = (r, label) => `<ts> · ${r.entry_id} · ${label(r.rung)} → ${r.verdict} · p ${r.p === null ? "–" : r.p.toFixed(2)} · run ${r.run_id ? "<id>" : "–"}`;
/** The newest-10 list, whole: the old build's own rows (newest), then the seed's rows, then F's older rows, cut at 10. */
function cmpList(a, f, seedRows, oldRows, label) {
  const [head, ...frows] = f.map(norm);
  const mine = oldRows.map((r) => listLine(r, label));
  const want = [head, ...mine, ...seedRows.map((r) => listLine(r, label)), ...frows.slice(mine.length)].slice(0, 1 + 10);
  const got = a.map(norm);
  if (!same(frows.slice(0, mine.length), mine)) return ["recent-decisions list: F's newest rows are not the old build's own rows"];
  const at = got.findIndex((l, i) => l !== want[i]);
  return got.length === want.length && at < 0 ? [] : [`recent-decisions list: A has ${got.length - 1} rows, expected ${want.length - 1}; first difference at row ${at < 0 ? "end" : at}`];
}
function cmpRenders(tag, ra, rf, seed, oldRows, label) {
  const bad = [...cmpStatus(ra.status, rf.status, seed.rungs, label), ...cmpDigest(ra.digest, rf.digest), ...cmpList(ra.list, rf.list, seed.seedRows, oldRows, label)];
  const seen = NEW_IDS.map((id) => `${id} ${countMap(ra.status).get(id) ?? 0}`).join(" · ");
  check(`A vs F at ${tag}: full /status count lines = F + seed delta per decider, digest equal, recent list = expected newest 10`, bad.length === 0,
    bad.length ? bad.join("; ") : `A carries [${seen}], F carries none; ${countLinesOf(ra.status).length} count lines compared whole; digest ${ra.digest?.length ?? 0} lines equal; list ${ra.list.length - 1} rows`);
}

// ---- step 2: the merge base on one copy ----
/** review_ok naming a new id must be refused by the old build's own ENTRY_IDS; a valid id is accepted, so the refusal is about the value. */
function outcomeProbes(store) {
  const decision_id = store.db.prepare(`SELECT decision_id FROM decisions WHERE entry_id NOT IN (${NEW_IDS.map(() => "?").join(",")}) ORDER BY rowid LIMIT 1`).get(...NEW_IDS)?.decision_id;
  if (!decision_id) throw new Error("the copy holds no decision row to attach an outcome to");
  const probe = (value) => {
    try { return `inserted:${store.insertDecisionOutcome({ decision_id, signal: "review_ok", value, source: "code" }).inserted}`; }
    catch (e) { return e?.constructor?.name === "OutcomeRejected" && /^value not allowed for review_ok$/.test(e.message) ? "OutcomeRejected:value not allowed for review_ok" : `error:${errCode(e)}`; }
  };
  return Object.fromEntries([...NEW_IDS, "tool.policy"].map((v) => [v, probe(v)]));
}
async function oldSteps(ctx, path, now, tOld) {
  const { dOld, mOld } = ctx;
  const s = openStore(dOld, path); // the old build opens the copy; its migrations ran
  const r = { schemaAfterOpen: schemaOf(path), before: render(mOld, s, now), decisionsBefore: s.db.prepare("SELECT COUNT(*) AS n FROM decisions").get().n };
  await yieldLoop();
  r.outcomes = outcomeProbes(s);
  r.after = render(mOld, s, now);
  r.oldRows = s.listRecentDecisions(10).filter((x) => x.created_at >= tOld);
  r.listedAll = s.listRecentDecisions(100_000).length;
  closeStore(s);
  return r;
}

async function setup() {
  if (!DIST.includes("/.worktrees/")) throw new SetupError(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
  if (!arg("--old-dist")) throw new SetupError("usage: --old-dist <merge-base dist> [--old-base <full sha>] [--live-db <path>]");
  const oldDist = resolve(arg("--old-dist"));
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  let prov, base;
  try { base = mergeBaseOf(DIST, arg("--old-base")); prov = verifyStampedDist(oldDist, DIST, base); } catch (e) { throw new SetupError(provenanceText(e)); }
  console.log(`old build pinned to merge base ${base.slice(0, 7)}: worktree HEAD ${prov.head.slice(0, 7)}, stamped dist ${prov.hash.slice(0, 12)}`);
  const root = initTemp(false);
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_OMP_BIN: "/nonexistent/houge-rollback/omp", HOUGE_SCHEDULER_ENABLED: "1", HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  delete process.env.HOUGE_SCHEDULER_MAX_PER_CHAT;
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  for (const k of ["storeOptionsFor", "CoreWorker", "createBridgeHandler", "Gateway"]) if (!dNew[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  if (!dOld.RunStore) throw new SetupError("RunStore missing from the old dist");
  const mods = async (dist) => ({ ...(await import(join(dist, "decisions/digest.js"))), ...(await import(join(dist, "decisions/status-view.js"))) });
  const [mNew, mOld] = [await mods(DIST), await mods(oldDist)];
  const A = join(mkTemp("copy-A"), "houge.sqlite"); const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, A);
  vacuumInto(A, F); // F is cut from the untouched A, so a daemon write between two live reads cannot separate them
  return { dNew, dOld, mNew, mOld, A, F, root };
}

async function run(ctx) {
  const { dNew, A, F, root, mNew } = ctx;
  phase = "snapshot F"; const snap = { f0: counts(F), kf0: keysOfFull(F), schemaF0: schemaOf(F), newF0: NEW_IDS.map((id) => entryCount(F, id)) };
  phase = "seed A"; const seed = await seedA(dNew, A, root);
  Object.assign(snap, { a1: counts(A), ka1: keysOfFull(A), schemaA1: schemaOf(A), hashA1: rowsHash(A, seed.seedKeys) });
  const r = seed.results;
  const oneEach = NEW_IDS.every((id) => seed.delta[id] === 1 && entryCount(A, id) === snap.newF0[NEW_IDS.indexOf(id)] + 1);
  check("this build seeded A through its own call sites: one row of each new id with the expected verdict, the F copy holds none",
    oneEach && r.lesson.ok && r.sched.ok && r.pre.ok && same(r.lesson.rows, [["refuse", "scheduled_run"]]) && same(r.sched.rows, [["admit", "create"]]) && same(r.pre.rows, [["refuse", "not_offered"]])
    && snap.a1.decisions - snap.f0.decisions === Object.values(seed.delta).reduce((a, b) => a + b, 0),
    `seed delta by entry ${J(seed.delta).replace(/"/g, "")} · by decider ${J(seed.rungs).replace(/"/g, "")} · F rows of new ids ${snap.newF0.join("/")} (want 0/0/0 or the copy's own)`);
  await yieldLoop();
  const now = new Date(Date.now() + 10 * 60_000).toISOString(); // ahead of every row this run writes
  const tOld = new Date().toISOString();
  phase = "c558413 on A"; const a = await oldSteps(ctx, A, now, tOld);
  await yieldLoop();
  phase = "c558413 on F"; const f = await oldSteps(ctx, F, now, tOld);
  check("c558413 opened both copies and every step completed without throwing", true);
  phase = "compare";
  const [schemaA2, schemaF2] = [schemaOf(A), schemaOf(F)];
  check("c558413 ran no migration: the schema (every object's sql and user_version) is identical before and after its open, on A and F",
    same(snap.schemaA1, a.schemaAfterOpen) && same(snap.schemaF0, f.schemaAfterOpen) && same(snap.schemaA1, schemaA2) && same(snap.schemaF0, schemaF2) && same(snap.schemaA1, snap.schemaF0),
    `A ${snap.schemaA1.hash} uv ${snap.schemaA1.uv} -> ${schemaA2.hash} uv ${schemaA2.uv} · F ${snap.schemaF0.hash} uv ${snap.schemaF0.uv} -> ${schemaF2.hash} uv ${schemaF2.uv}`);
  const [a2, f1] = [counts(A), counts(F)];
  noDrop("A, seed -> after c558413", snap.a1, a2);
  noDrop("F, before -> after c558413", snap.f0, f1);
  const grew = (x, y) => TABLES.map((t) => y[t] - x[t]);
  check("c558413 added exactly the same rows to A and F (per table growth equal), and none to decisions",
    same(grew(snap.a1, a2), grew(snap.f0, f1)) && a2.decisions === snap.a1.decisions && f1.decisions === snap.f0.decisions && a.decisionsBefore === snap.a1.decisions,
    `growth ${TABLES.map((t, i) => `${t} ${grew(snap.a1, a2)[i]}/${grew(snap.f0, f1)[i]}`).join(" · ")} (A/F) · decisions on open ${a.decisionsBefore}/${snap.a1.decisions}`);
  const [ka2, kf1] = [keysOfFull(A), keysOfFull(F)];
  identity("A at the seed boundary after c558413", snap.ka1, ka2);
  identity("F at its start after c558413", snap.kf0, kf1);
  const hashA2 = rowsHash(A, seed.seedKeys);
  check("the seeded rows (one of each new id and the rest of the seed) are byte-identical after c558413, and its list reads every decision row",
    hashA2 === snap.hashA1 && seed.seedKeys.every((k) => ka2.decisions.has(k)) && a.listedAll === a2.decisions && f.listedAll === f1.decisions,
    `${seed.seedKeys.length} seeded rows, hash ${snap.hashA1} -> ${hashA2} · old list reads ${a.listedAll}/${a2.decisions} rows on A, ${f.listedAll}/${f1.decisions} on F`);
  const label = mNew.deciderLabel;
  cmpRenders("start of the c558413 steps", a.before, f.before, seed, [], label);
  cmpRenders("end of the c558413 steps", a.after, f.after, seed, f.oldRows, label);
  const refused = (x) => NEW_IDS.every((id) => x.outcomes[id] === "OutcomeRejected:value not allowed for review_ok") && x.outcomes["tool.policy"] === "inserted:true";
  check("c558413 refuses review_ok naming memory.lesson_admit, schedule.admit and memory.correct_preflight (normal OutcomeRejected, no crash; a valid id is accepted) on both copies",
    refused(a) && refused(f) && same(a.outcomes, f.outcomes), `A ${J(a.outcomes)} · F ${J(f.outcomes)}`.replace(/"/g, ""));
  phase = "reopen A"; const s = openStore(dNew, A);
  const re = mNew.decisionStatusLines(s, now);
  const reRows = s.listRecentDecisions(100_000).length;
  closeStore(s);
  noDrop("A, after c558413 -> reopened by this build", a2, counts(A));
  const ka3 = keysOfFull(A);
  identity("A after c558413 (to the reopen by this build)", ka2, ka3);
  const exact = NEW_IDS.every((id) => re.includes(fmtCount(id, new Map(Object.entries(seed.rungs[id])), label)));
  check("this build reopens A: the seeded rows are intact, every decision row is listed, and the three new-id /status lines are exact (decider breakdown)",
    exact && NEW_IDS.every((id) => entryCount(A, id) === snap.newF0[NEW_IDS.indexOf(id)] + 1) && rowsHash(A, seed.seedKeys) === snap.hashA1 && seed.seedKeys.every((k) => ka3.decisions.has(k)) && reRows === a2.decisions,
    NEW_IDS.map((id) => `${id} ${entryCount(A, id)}`).join(" · ") + ` · rows listed ${reRows}/${a2.decisions}`);
}

function onSignal(code) { for (const h of handles.splice(0)) closeStore(h); cleanupTemp(); process.exit(code); }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => onSignal(code));

export async function main() {
  let root;
  try {
    const ctx = await setup(); root = ctx.root;
    try { await run(ctx); } catch (e) { check(`run — unexpected error at ${phase}: ${errCode(e)}`, false); }
    console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(`setup error: ${e instanceof SetupError ? e.message.split("\n")[0] : `withheld (${errCode(e)})`}`);
    process.exitCode = 2;
  } finally {
    for (const h of handles.splice(0)) closeStore(h);
    await runClosers();
    cleanupTemp();
    if (root) console.error(`# temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
