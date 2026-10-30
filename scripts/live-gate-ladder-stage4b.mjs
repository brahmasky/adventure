#!/usr/bin/env node
// Live gate — decision ladder Stage 4B, approval.bind + secret.redact (spec 2026-10-29 §7; plan Task 11).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-stage4b.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-1451a66/dist [--live-db <path>] [--debug]
// --debug prints error messages and child-gate detail: may print private content; local diagnosis only. Default prints names and codes only.
// Eight lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all eight PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. No --keep: the live DB is read once, by VACUUM INTO a temp copy; every write goes
// to copies of that copy under /tmp/hg-s4d-*, which is removed on every exit path (finally, SIGINT, SIGTERM, SIGHUP).
// The broker is synthetic (the harness's fake strings); no env file is loaded here and no env value or live text is printed.
// Lines 2 and 6 drive the real bridge handler and the real shell adapter (sandbox on) over a copy, taps through
// resolveToolApprovalForTest + the waiter (the seam live-gate-ladder-2b-hooks.mjs:220 uses). Lines 3, 4, 7 compare against --old-dist
// (1451a66, verified) on copies of the same base. Line 5 is the silent-degradation line: the store is built with storeOptionsFor
// (what cli.ts calls) and row counts must equal the calls made.
// Line 8 spawns live-gate-standing-approval.mjs and live-gate-cleanroom-runtime.mjs. Those child gates open stores WITHOUT
// storeOptionsFor, so line 8 proves Stage 4A behaviour on this build (the consume block moved under the standing trial), not the
// secret.redact wiring: lines 4-5 prove that. They may message Paco's own Telegram chat and POST to httpbin.org (inside the test surface).
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAT_MAX, MARK, MASKABLE, SEAM, SHORT, TAIL, hasSecret, oracleStored, pad, payloadFor, scan } from "./stage4-redact-fixture.mjs";
import { INPUT_ONE_BYTE, PACO, W, approvedRow, attempt, contract, makeRun, poke, scrubIds } from "./stage4-bind-fixture.mjs";
import { FAKE_VALUES, SetupError, cleanupTemp, closers, fakeBroker, initTemp, loadDist, mkTemp, redactForPrint, runClosers } from "./stage4-diff-lib.mjs";
import { verifyOldDist } from "./old-dist-provenance.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const argv = process.argv.slice(2);
const DEBUG = argv.includes("--debug"); // may print private content; local diagnosis only
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const CHAT = "-4300"; // not Paco's chat; the gate sends nothing
const OPERATOR = { kind: "user", id: "gate" };
const STAMP = Date.now() * 1000; // idempotency-key base: unique against any real row on the copy
const PASS_JUDGE = async (i) => ({ text: i.text, verdict: "pass", withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 0, unanswered: 0, skipped: false, blocked: null, decisionId: null, masked: 0 });
const out = []; // the eight verdicts
const note = (s) => console.error(`# ${s}`);
const origDaemonTmp = process.env.HOUGE_DAEMON_TMP_DIR; // the child gates must see the caller's value, not ours
const G = { dNew: null, dOld: null, base: null, sNew: null, sOld: null, n: 0, maskableCalls: 0, ompResumes: 0, pending: [], baseline: null, stores: [] };

/** One printed verdict line. The detail goes through the harness redactor and a 200-char cap. */
function verdict(n, name, ok, detail) {
  out.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${name} — ${redactForPrint(detail)}`);
}
/** The error's class name plus its code when it has a short one (e.g. `SqliteError ERR_SQLITE_ERROR`); never the message. */
function errCode(e) {
  const code = typeof e?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(e.code) ? ` ${e.code}` : "";
  return `${e instanceof Error ? e.constructor.name : "non-Error"}${code}`;
}
/** A line body that returns { ok, detail }; a throw is that line's FAIL (a later line still runs). */
async function runLine(n, name, fn) {
  try { const r = await fn(); verdict(n, name, r.ok, r.detail); } catch (e) { verdict(n, name, false, `threw: ${errCode(e)}${DEBUG ? ` — ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` : ""}`); }
}

// ---- the live-DB copy and the stores opened on copies of it ----
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** VACUUM INTO `to` from `from` (read-only source). The daemon writes the live DB: a lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt_ = 1; ; attempt_++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt_ >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
/** A store of dist `d` on its own VACUUM copy of the base. kind: "firewall" (fake broker) | "bare". New dist: storeOptionsFor, as cli.ts. */
function openCopy(d, name, kind) {
  const path = join(mkTemp(`cp-${name}`), "houge.sqlite");
  vacuumInto(G.base, path);
  const broker = kind === "firewall" ? fakeBroker(d) : undefined;
  const opts = d.storeOptionsFor ? d.storeOptionsFor(broker) : broker ? { redact: broker.redact } : {};
  const store = d.RunStore.open(path, opts);
  G.stores.push(store);
  return store;
}
const countRows = (store, id, verdictName) => store.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?${verdictName ? " AND verdict = ?" : ""}`).get(...(verdictName ? [id, verdictName] : [id])).n;
const nextN = () => STAMP + ++G.n;

// ---- the bind fixture over a copy store (bindFixture opens its own temp store, so the object is built by hand) ----
function stubRegistry(d, adapter) {
  const registry = new d.ToolRegistry();
  registry.register({ name: "shell_external", category: "tool", side_effect_level: "external_write", risk_level: "medium", timeout_ms: 5_000, output_limit_bytes: 10_000,
    execute: () => Promise.resolve(adapter.mode === "ok" ? { ok: true, output: { ran: true } } : { ok: false, error: "adapter boom" }) });
  return registry;
}
/** A fresh running run (leased to W) and an omp sink on `store`; the runner is real, the adapter a stub. */
function fixtureOn(d, store) {
  const f = { d, store, opts: {}, seq: 0, adapter: { mode: "ok" }, attempts: [], requester: PACO };
  f.run_id = makeRun(d, store, "user", nextN());
  f.sink = d.createToolApprovalSink({ store, worker_id: W, tool_call_id: "tc_sink", approvalTimeoutMs: 60_000 });
  f.runner = new d.CapabilityRunner(stubRegistry(d, f.adapter), f.sink);
  f.recorder = d.storeRecorder(store);
  return f;
}
const REFUSALS = {
  expired: (f) => approvedRow(f, { expires_in_ms: -1 }),
  action_mismatch: (f) => approvedRow(f, { input: INPUT_ONE_BYTE }),
  lease_lost: (f) => { const id = approvedRow(f); poke(f, `UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`, new Date(Date.now() - 1000).toISOString(), f.run_id); return id; },
  happy: (f) => approvedRow(f)
};
/** One omp-sink resume of a scenario: the attempt record, scrubbed of random ids so two dists compare byte for byte. */
async function resume(d, store, kind) {
  const f = fixtureOn(d, store);
  const rec = await attempt(f, REFUSALS[kind](f));
  if (d === G.dNew) G.ompResumes += 1;
  const view = scrubIds({ before: rec.before, after: rec.after, result: rec.result, threw: rec.threw }, [], [[f.run_id, "RUN"]]);
  return { view, bind: rec.newBind, returned: rec.result !== null && rec.threw === null };
}

// ---- reports ----
const send = (store, w, run_id, text) => w === "final" ? store.enqueueFinalReportNotification(run_id, { text, report_path: "/tmp/r.md" })
  : w === "failure" ? store.enqueueFailureNotification(run_id, text) : store.enqueueEvolutionReportNotification(run_id, "self_write_propose", { text });
/** What one report call left behind: wrapper status, the outbox row, the assistant chat turns, the secret.redact rows for the run. */
function reportOn(d, store, item) {
  const run_id = makeRun(d, store, "schedule", nextN(), false); // telegram intake is rate-limited per chat; the report path is the same
  const res = send(store, item.w, run_id, item.text);
  if (d === G.dNew && store === G.sNew && hasSecret(item.text)) G.maskableCalls += 1;
  const row = store.db.prepare(`SELECT payload_json, payload_hash, state FROM notification_outbox WHERE run_id = ? AND intent_type = 'final_report'`).get(run_id) ?? null;
  const chat = store.db.prepare(`SELECT text FROM chat_turns WHERE run_id = ? AND role = 'assistant'`).all(run_id).map((r) => r.text);
  const rows = store.listDecisionsForRun(run_id).filter((r) => r.entry_id === "secret.redact").map((r) => ({ verdict: r.verdict, reason_code: r.reason_code }));
  return { status: res.status, row: row ? { ...row } : null, chat, rows };
}
const V = FAKE_VALUES.GEMINI_API_KEY;
const ITEMS = [
  { name: "whole marker", w: "final", text: pad(2000) + V + pad(3000 - 2000 - V.length),
    premise: (s) => s.indexOf(MARK) === 2000 && !s.includes(V) && s.split(MARK).length === 2 },
  { name: "cut boundary", w: "final", text: `${"x".repeat(3895)}${V} tail`,
    premise: (s) => s.slice(3895, CHAT_MAX) === MARK.slice(0, CHAT_MAX - 3895) && !s.includes(MARK) && s.endsWith(TAIL) },
  { name: "failure notice", w: "failure", text: `I hit an error on that one: ${V}` },
  { name: "evolution report", w: "evolution", text: `published ${V} to the lane` },
  { name: "clean report", w: "final", text: "all good, nothing secret here", control: true },
  { name: "5-char control", w: "final", text: `key ${SHORT} stays`, control: true }
];
/** The new-side facts of one item against bytes computed independently of the redactor; `armed` false is the firewall-off store. */
function itemProblems(item, r, armed) {
  const bad = [];
  const stored = oracleStored(item.text, armed);
  const want = payloadFor(item.w, stored);
  if (r.status !== "queued" || !r.row || r.row.payload_json !== JSON.stringify(want) || r.row.state !== "queued") bad.push("stored bytes differ from the independent oracle");
  const maskable = armed && hasSecret(item.text);
  if (JSON.stringify(r.rows) !== JSON.stringify(maskable ? [{ verdict: "masked", reason_code: SEAM[item.w] }] : [])) bad.push(`${r.rows.length} secret.redact rows, expected ${maskable ? 1 : 0}`);
  if (JSON.stringify(r.chat) !== JSON.stringify(item.w === "evolution" ? [stored] : [])) bad.push("assistant chat turn differs");
  if (armed && item.premise && !item.premise(stored)) bad.push("premise of the case not met");
  return bad;
}
/** Items on both stores: new facts vs the oracle, old dist byte-equal on payload, hash and chat turns, and the old build writes no row. */
function compareReports(newStore, oldStore, armed, items) {
  const bad = [];
  for (const item of items) {
    const a = reportOn(G.dNew, newStore, item);
    const b = reportOn(G.dOld, oldStore, item);
    bad.push(...itemProblems(item, a, armed).map((x) => `${item.name}: ${x}`));
    const same = a.row?.payload_json === b.row?.payload_json && a.row?.payload_hash === b.row?.payload_hash && JSON.stringify(a.chat) === JSON.stringify(b.chat) && a.status === b.status;
    if (!same) bad.push(`${item.name}: bytes differ from the old dist`);
    if (b.rows.length) bad.push(`${item.name}: old dist wrote a decision row`);
  }
  return bad;
}

// ---- lines 1-5 and 7 ----
async function line1() {
  const reg = await import(join(DIST, "decisions/registry.js"));
  const two = ["approval.bind", "secret.redact"].map((id) => reg.entryById(id));
  const problems = reg.REGISTRY.filter((e) => reg.entryProblems(e).length > 0).map((e) => e.id);
  const sound = two.every((e) => e && e.locked === true && e.ladder.length === 1 && e.ladder[0].kind === "rule");
  const store = openCopy(G.dNew, "l1", "bare");
  const refused = two.map((e) => { try { store.insertLadderMove({ entry_id: e.id, scope: "g", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "paco", granted_via: "gate", paco_callback_id: "cb", revocable: true }); return false; } catch (err) { return err?.code === "locked_entry"; } });
  const ok = reg.REGISTRY.length === 23 && sound && problems.length === 0 && refused.every(Boolean);
  return { ok, detail: `${reg.REGISTRY.length} ids · two locked, one rule rung each: ${sound} · entryProblems non-empty for [${problems}] · insertLadderMove refused locked_entry: ${refused}` };
}
async function line3() {
  const bad = []; const seen = [];
  for (const [kind, code] of [["expired", "expired"], ["action_mismatch", "action_mismatch"], ["lease_lost", "lease_lost"], ["happy", null]]) {
    const a = await resume(G.dNew, G.sNew, kind);
    const b = await resume(G.dOld, G.sOld, kind);
    const want = code ? [{ entry_id: "approval.bind", verdict: "unbound", reason_code: code, tool_call_id: "tc_run" }] : [{ entry_id: "approval.bind", verdict: "bound", reason_code: null, tool_call_id: "tc_run" }];
    if (JSON.stringify(a.bind) !== JSON.stringify(want)) bad.push(`${kind}: new bind rows ${JSON.stringify(a.bind)}`);
    if (JSON.stringify(a.view) !== JSON.stringify(b.view)) bad.push(`${kind}: result differs from the old dist`);
    if (b.bind.length) bad.push(`${kind}: old dist wrote a bind row`);
    if (!a.returned || !b.returned) bad.push(`${kind}: a resume threw or returned no result (new ${a.returned}, old ${b.returned})`);
    seen.push(code ?? "bound");
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join("; ") : `unbound ${seen.slice(0, 3).join("/")} (+ a bound control), results byte-equal to the old dist (ids scrubbed)` };
}
async function line4() {
  const bad = compareReports(G.sNew, G.sOld, true, ITEMS);
  return { ok: bad.length === 0, detail: bad.length ? bad.join("; ") : `${ITEMS.length} cases byte-equal to the old dist and the oracle: whole marker, cut boundary (marker split at ${CHAT_MAX}, truncated tail intact), failure, evolution, 2 controls with no row` };
}
async function line5() {
  const masked = countRows(G.sNew, "secret.redact", "masked") - G.baseline.redact;
  const binds = countRows(G.sNew, "approval.bind") - G.baseline.bind;
  const hits = scan(G.dNew, G.sNew.db, MASKABLE);
  const ok = masked === G.maskableCalls && binds === G.ompResumes && Object.keys(hits).length === 0 && G.maskableCalls > 0 && G.ompResumes > 0;
  return { ok, detail: `secret.redact masked rows ${masked}/${G.maskableCalls} maskable calls · approval.bind rows ${binds}/${G.ompResumes} omp-sink resumes · maskable seeded values left in the copy: ${Object.keys(hits).length === 0 ? 0 : JSON.stringify(hits)}` };
}
async function line7() {
  const a = openCopy(G.dNew, "l7-new", "bare"); const b = openCopy(G.dOld, "l7-old", "bare");
  const bad = compareReports(a, b, false, ITEMS);
  const rows = countRows(a, "secret.redact");
  if (rows !== 0) bad.push(`${rows} secret.redact rows`);
  return { ok: bad.length === 0, detail: bad.length ? bad.join("; ") : `firewall off: ${ITEMS.length} cases byte-equal to the old dist, ${rows} secret.redact rows` };
}

// ---- the bridge cases (lines 2 and 6): the real handler, the real shell adapter, a schedule-born run ----
const BRIDGE_MODS = {};
async function loadBridgeMods() {
  for (const [k, p] of [["writeSeatbeltProfiles", "omp/seatbelt.js"], ["shellToolExecute", "omp/shell-adapter.js"], ["chatWorkspace", "omp/workspace.js"], ["TURN_ACTIONS", "contracts/task-contract.js"]]) {
    BRIDGE_MODS[k] = (await import(join(DIST, p)))[k];
  }
}
/** A copy store, a data dir with the sandbox profiles, the shell registered over the real adapter, the real bridge handler, one claimed schedule run. */
function bridgeEnv(name) {
  const d = G.dNew; const m = BRIDGE_MODS;
  const store = openCopy(d, `br-${name}`, "firewall");
  const data = join(mkTemp(`br-${name}-data`), "data"); const ws = m.chatWorkspace(data, CHAT); mkdirSync(ws, { recursive: true, mode: 0o700 });
  const ctx = { home: homedir(), repo: REPO, data }; m.writeSeatbeltProfiles(ctx);
  const cfg = d.resolveOmpConfig({});
  const decls = d.loadToolDeclarations(d.TOOL_DECLS_DIR); if (!decls.ok) throw new Error(decls.error);
  const shell = m.shellToolExecute({ cfg, ctx, distDir: DIST, cwd: ws, onIncident: (kind, detail) => { store.openIncident({ kind, subject: `chat:${CHAT}`, detail }); } });
  const registry = new d.ToolRegistry();
  for (const [n, meta] of Object.entries(d.OMP_SHELL_META)) registry.register({ name: n, category: "tool", ...meta, timeout_ms: cfg.shellTimeoutMs + 30_000, execute: shell });
  const schedule_id = store.addScheduledTask({ chat_id: CHAT, goal: "stage4b gate", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2099-01-01T00:00:00.000Z" }).schedule_id;
  const e = { store, ws, turn: null, schedule_id };
  e.handle = d.createBridgeHandler({ store, cfg, ctx, decls: decls.decls, env: {}, turnEnvelopeActions: [...m.TURN_ACTIONS], activeTurn: () => e.turn });
  const event = { source: "schedule", type: "turn", program: "turn", goal: "stage4b gate", requested_by: { kind: "schedule", id: schedule_id }, notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: `schedule:${schedule_id}:s4b:${nextN()}`, source_reference: `scheduled_tasks.${schedule_id}` };
  const r = new d.Gateway(store, undefined, undefined, undefined, undefined, { dataDir: data }).intake(d.buildTypedTaskEvent(event));
  if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
  const claim = store.claimRun(r.run_id, `planner:${CHAT}:gate`, 600); if (!claim) throw new Error("claim failed");
  e.run = r.run_id;
  e.turn = { run_id: r.run_id, worker_id: `planner:${CHAT}:gate`, chat_id: CHAT, requester: event.requested_by, approver: OPERATOR, contract: claim.contract, budget: new d.BudgetLedger(claim.contract.budget),
    registry, signal: new AbortController().signal, cwd: ws, step: { n: 0 }, cache: new Map(), unreported: new Map(), quarantine: async (tool) => ({ digest: "d", contains_instructions: false, source_meta: { tool, bytes: 1 } }),
    setAwaitingApproval: () => undefined, postureOk: () => null, judge: PASS_JUDGE };
  return e;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** `launchctl list` (external_write, read-only) through the bridge; the first approval it raises is tapped through the test seam and the waiter. */
async function askLaunchctl(e, tc) {
  const d = G.dNew;
  let settled = null;
  const done = e.handle({ id: `r-${tc}`, kind: "call", tool: "bash", input: { command: "launchctl list" }, toolCallId: tc }).then((r) => { settled = { r }; return settled; }, (err) => { settled = { err }; return settled; });
  let approval_id = null;
  for (let i = 0; i < 600 && !settled && !approval_id; i++) { await wait(25); approval_id = e.store.listPendingApprovalIds()[0] ?? null; }
  if (approval_id) { e.store.resolveToolApprovalForTest(approval_id, "approved"); d.toolApprovalWaiters.resolve(approval_id, "approved"); }
  const res = await done;
  return { approval_id, res };
}
/**
 * Positive evidence the resumed ADAPTER ran to completion, as distinct from a tool_finished the bridge writes for a call that never
 * reached the runner (refuse / recordInvalid, bridge-handler.ts finish() callers). Only handleCall's final finish() passes bytesIn
 * (tool_finished.bytes_in) and a renderShell digest (loop_step.result_digest "exit N, M bytes"); refuse/recordInvalid pass neither
 * (their digest is the reason code). The returned content's trailing "[exit N]" comes from the adapter's exit_code too.
 */
function adapterEvidence(e, tc, res) {
  const evs = e.store.getLedgerEvents(e.run);
  const fin = evs.find((x) => x.event_type === "tool_finished" && x.payload.tool_call_id === tc)?.payload;
  const step = evs.filter((x) => x.event_type === "loop_step").at(-1)?.payload;
  const tail = /\n\[exit (-?\d+)\]$/.exec(res?.r?.content ?? "");
  const ran = fin?.status === "succeeded" && typeof fin.bytes_in === "number" && /^exit -?\d+, \d+ bytes$/.test(step?.result_digest ?? "") && tail !== null;
  return { ran, exit: tail ? tail[1] : null, status: fin?.status ?? "no tool_finished", digest: step?.result_digest ?? "none" };
}
const bindRowsFor = (store, tc) => store.db.prepare(`SELECT verdict FROM decisions WHERE entry_id = 'approval.bind' AND tool_call_id = ?`).all(tc).map((r) => r.verdict);
async function line2() {
  const e = bridgeEnv("l2"); const tc = "s4b-l2";
  const { approval_id, res } = await askLaunchctl(e, tc);
  if (!approval_id) return { ok: false, detail: `no approval was raised (${res.err ? "threw" : res.r.isError ? "refused" : "ran unasked"})` };
  const binds = bindRowsFor(e.store, tc); const consumed = e.store.getToolApproval(approval_id)?.state; const ev = adapterEvidence(e, tc, res);
  const ok = binds.length === 1 && binds[0] === "bound" && consumed === "consumed" && ev.ran && res.r !== undefined && typeof res.r.content === "string";
  return { ok, detail: `bind rows [${binds}] · approval ${consumed} · adapter ran: ${ev.ran} (tool_finished ${ev.status}, loop_step "${ev.digest}") · bridge result returned: ${res.r !== undefined} · exit ${ev.exit} (reported, not asserted)` };
}
const FAULT = (id) => `CREATE TRIGGER s4b_fault_${id.replace(".", "_")} BEFORE INSERT ON decisions WHEN NEW.entry_id = '${id}' BEGIN SELECT RAISE(ABORT, 's4b fault'); END`;
const openFailed = (store, id) => store.db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE kind = 'decision_record_failed' AND subject = ? AND state = 'open'`).get(id).n;
/** The work of line 6: both ids fault, a bridge resume and a masked report still complete. Timed from the call to the last read. */
async function faultWork() {
  const e = bridgeEnv("l6"); const tc = "s4b-l6";
  for (const id of ["approval.bind", "secret.redact"]) e.store.db.exec(FAULT(id));
  const before = [openFailed(e.store, "approval.bind"), openFailed(e.store, "secret.redact")];
  const t0 = Date.now();
  const { approval_id, res } = await askLaunchctl(e, tc);
  const text = `${pad(100)}${V} end`;
  const rep = e.store.enqueueFinalReportNotification(e.run, { text, report_path: "/tmp/r.md" });
  const stored = e.store.db.prepare(`SELECT payload_json FROM notification_outbox WHERE run_id = ? AND intent_type = 'final_report'`).get(e.run)?.payload_json;
  const ev = adapterEvidence(e, tc, res);
  return { ms: Date.now() - t0, before, consumed: approval_id ? e.store.getToolApproval(approval_id)?.state : null, ev, queued: rep.status,
    masked: stored === JSON.stringify(payloadFor("final", oracleStored(text, true))), incidents: [openFailed(e.store, "approval.bind"), openFailed(e.store, "secret.redact")], binds: bindRowsFor(e.store, tc).length };
}
async function line6() {
  const LIMIT = 5_000;
  let timer; const t0 = Date.now(); const work = faultWork();
  const first = await Promise.race([work, new Promise((r) => { timer = setTimeout(() => r("timeout"), LIMIT); })]);
  clearTimeout(timer);
  if (first === "timeout") { G.pending.push(work.catch(() => null)); return { ok: false, detail: `the line did not complete within ${LIMIT} ms (timer expired, verdict at ${Date.now() - t0} ms); its work is drained after the verdict, before teardown` }; }
  const r = first;
  const ok = r.before.join() === "0,0" && r.consumed === "consumed" && r.ev.ran && r.queued === "queued" && r.masked && r.incidents.join() === "1,1" && r.binds === 0 && r.ms < LIMIT;
  return { ok, detail: `consume ${r.consumed} · adapter ran ${r.ev.ran} (exit ${r.ev.exit}) · report ${r.queued}, masked bytes ${r.masked} · open decision_record_failed approval.bind/secret.redact ${r.incidents.join("/")} (before ${r.before.join("/")}) · bind rows ${r.binds} · ${r.ms} ms of ${LIMIT}` };
}

// ---- line 8: the two Stage 4A gates, as child processes ----
const kids = new Set(); // live child gates: killed by the signal handlers so teardown can run
/** One child gate, asynchronously (a sync spawn would block the event loop and defer SIGINT/SIGTERM handling until the child ends). */
function runChild(script, args) {
  const env = { ...process.env }; delete env.HOUGE_DAEMON_TMP_DIR; // ours is a private root; the child gates choose their own
  if (origDaemonTmp !== undefined) env.HOUGE_DAEMON_TMP_DIR = origDaemonTmp;
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(REPO, "scripts", script), ...args], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    kids.add(child);
    let text = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => { text += d.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 900_000);
    child.on("close", (status, signal) => {
      clearTimeout(timer); kids.delete(child);
      const lines = text.split("\n");
      const all = lines.filter((l) => /^(FAIL|INCONCLUSIVE|PARTIAL)/.test(l));
      const flagged = DEBUG ? all.slice(0, 3).map((l) => redactForPrint(l)) : []; // no child text without --debug: the count only
      done({ script, status, signal, tally: `${lines.filter((l) => l.startsWith("PASS")).length} PASS/${lines.filter((l) => l.startsWith("FAIL")).length} FAIL, ${all.length} flagged`, flagged });
    });
  });
}
async function line8(liveDb) {
  const runs = [await runChild("live-gate-standing-approval.mjs", ["--db", liveDb]), await runChild("live-gate-cleanroom-runtime.mjs", [])];
  const ok = runs.every((r) => r.status === 0);
  return { ok, detail: runs.map((r) => `${r.script.replace(/^live-gate-|\.mjs$/g, "")} exit ${r.status ?? r.signal} (${r.tally})${r.flagged.length ? ` ${r.flagged.join(" | ")}` : ""}`).join(" · ") };
}

// ---- main ----
async function setup() {
  const oldDist = resolve(arg("--old-dist") ?? "");
  if (!arg("--old-dist")) throw new SetupError("usage: --old-dist <dist at 1451a66> [--live-db <path>] [--debug] (--debug may print private content; local diagnosis only)");
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  const prov = verifyOldDist(oldDist, DIST, "1451a66", "capabilities/capability-runner.js");
  note(`old dist ${prov.head.slice(0, 7)} capability-runner.js ${prov.oldHash} != ${prov.newHash}`);
  const root = initTemp(false);
  const daemon = join(root, "daemon"); mkdirSync(daemon, { recursive: true, mode: 0o700 });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: daemon, HOUGE_TELEGRAM_CHAT_ID: CHAT, HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  G.base = join(root, "base.sqlite");
  vacuumInto(liveDb, G.base);
  G.dNew = await loadDist(DIST); G.dOld = await loadDist(oldDist);
  for (const k of ["storeOptionsFor", "createBridgeHandler", "OMP_SHELL_META", "toolApprovalWaiters"]) if (!G.dNew[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  await loadBridgeMods();
  G.sNew = openCopy(G.dNew, "s-new", "firewall"); G.sOld = openCopy(G.dOld, "s-old", "firewall");
  G.baseline = { redact: countRows(G.sNew, "secret.redact"), bind: countRows(G.sNew, "approval.bind") };
  if (G.baseline.redact !== 0 || G.baseline.bind !== 0) throw new SetupError(`the copy already holds ${G.baseline.redact} secret.redact / ${G.baseline.bind} approval.bind rows`);
  return liveDb;
}
function closeAll() { for (const s of G.stores.splice(0)) { try { s.close(); } catch { /* a closed handle is not a finding */ } } }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { for (const k of kids) k.kill("SIGKILL"); closeAll(); cleanupTemp(); process.exit(code); });

try {
  const liveDb = await setup();
  await runLine(1, "registry", line1);
  await runLine(2, "bind through the bridge", line2);
  await runLine(3, "bind refusals vs old dist", line3);
  await runLine(4, "redaction vs old dist", line4);
  await runLine(5, "silent degradation counts", line5);
  await runLine(6, "recorder fault", line6);
  await runLine(7, "firewall off", line7);
  await runLine(8, "stage 4A gates", () => line8(liveDb));
  const passed = out.filter(Boolean).length;
  note(`${passed}/8 PASS`);
  process.exitCode = out.length === 8 && passed === 8 ? 0 : 1;
} catch (e) {
  console.error(`setup error: ${e instanceof SetupError || (e instanceof Error && /--old-dist|provenance|not the previous/.test(e.message)) ? e.message : "withheld"}`);
  process.exitCode = 2;
} finally {
  await Promise.race([Promise.all(G.pending), wait(30_000)]); // line 6's late work, drained after its verdict
  closeAll();
  await runClosers();
  cleanupTemp();
}
