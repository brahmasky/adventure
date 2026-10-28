#!/usr/bin/env node
// Live gate — decision ladder Stage 4A, standing approval (spec 2026-10-28 §10; plan Task 11).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-standing-approval.mjs [--db <path>] [--keep] [--only main,deny,…]
// The real bridge (createBridgeHandler), the real shell adapter, wrapper, sandbox-exec and clean room, on VACUUM copies of the
// live DB (one per case) under /tmp/hg-4a-*; rooms under a gate root <real cache>/gate-sa-* (HOUGE_DAEMON_TMP_DIR, set before
// any runtime import). Taps through resolveToolApprovalForTest + the waiter; delivery through a real dispatcher with the
// daemon's onDelivered and a stub adapter; Revoke through normalizeTelegramUpdate → Gateway.intake. Telegram tokens deleted; the
// gate chat (-4300) is not Paco's; no planner model is called. Third-party write: POST a=1 to httpbin.org (as Slice 1's gate).
// PASS = every line PASS, including line 4 (the fifth run asks nothing, reason standing, cleanroom.sb selected), which fails on
// silent degradation to an ordinary approval. Unsandboxed control POST not 200 → INCONCLUSIVE (exit 2, rerun once).
// Exit 0 PASS (every case) · 1 FAIL · 2 INCONCLUSIVE · 3 PARTIAL (--only: what ran passed; never a shipping PASS). Never opens the
// live DB for writing. Removes only its own roots; another gate's root is touched only when its owner pid is dead and not --keep.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const keep = argv.includes("--keep");
// a bare --only (no value, or another flag next) is an empty filter — a setup error below (exit 2), never "no filter" and a full PASS
const onlyArg = argv.includes("--only") ? (arg("--only") ?? "") : null;
const only = onlyArg === null ? null : new Set(onlyArg.startsWith("--") ? [] : onlyArg.split(",").map((x) => x.trim()).filter(Boolean));
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);
// a setup error, before anything runs or any root is made: an unknown --only name would otherwise skip every case
const CASE_IDS = ["main", "deny", "sandbox", "exit", "teardown", "check", "failed", "tamper"]; // CASES below must match (asserted)
const unknownOnly = only ? [...only].filter((id) => !CASE_IDS.includes(id)) : [];
if (unknownOnly.length > 0 || (only && only.size === 0)) {
  console.log(`setup error: --only names no known case (${unknownOnly.join(",") || "empty"}); known: ${CASE_IDS.join(",")}`);
  console.log(JSON.stringify({ ok: false, setup_error: "unknown --only" })); process.exit(2);
}
let fails = 0; let inconclusive = false; const notes = []; const ran = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); if (!ok) { fails++; process.exitCode = 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHAT = "-4300"; const OTHER_CHAT = "-4301";
const OPERATOR = { kind: "user", id: "gate" };
const CMD = "curl -s -m 10 -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post"; // the Alishan shape
const CMD_BYTE = CMD.replace("a=1", "a=2");
const CMD_500 = "curl -s -f -m 10 -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/status/500"; // curl -f: non-zero (22 over HTTP/1.1; 56 from curl 8.7.1 over HTTP/2, probed)
const ALLOWLIST = { users: [{ telegram_user_id: 111, identity_id: "gate" }],
  chats: [{ telegram_chat_id: Number(CHAT), label: "gate", allowed_identity_ids: ["gate"] }, { telegram_chat_id: Number(OTHER_CHAT), label: "other", allowed_identity_ids: ["gate"] }] };
const PASS_JUDGE = async (i) => ({ text: i.text, verdict: "pass", withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 0, unanswered: 0, skipped: false, blocked: null, decisionId: null, masked: 0 });

// .env first (it may name HOUGE_DAEMON_TMP_DIR), then the real root and its cleanroom/ names, then the override, then the runtime
const { loadHougeEnv } = await import(join(DIST, "config/load-env.js"));
loadHougeEnv();
const live = resolve(arg("--db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
const envRoot = process.env.HOUGE_DAEMON_TMP_DIR?.trim();
const realRoot = envRoot && isAbsolute(envRoot) ? envRoot : join(homedir(), "Library", "Caches", "houge-daemon");
const realCr = join(realRoot, "cleanroom");
const names = (d) => (existsSync(d) ? readdirSync(d).sort().join(",") : "<absent>");
const realCrBefore = names(realCr);
mkdirSync(realRoot, { recursive: true, mode: 0o700 });
/** Another gate's root is never touched while its owner lives or when it was kept; a dead, unkept owner's root is removed. */
function sweepDeadGateRoots(root) {
  for (const d of readdirSync(root).filter((n) => n.startsWith("gate-sa-"))) {
    const dir = join(root, d); let owner = null;
    try { owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")); } catch { console.log(`gate root without an owner file left in place: ${dir}`); continue; }
    if (owner.keep === true || !Number.isInteger(owner.pid)) continue;
    let alive = true; try { process.kill(owner.pid, 0); } catch (e) { alive = e?.code === "EPERM"; }
    if (!alive) { rmSync(dir, { recursive: true, force: true }); console.log(`removed a dead gate's root: ${dir} (pid ${owner.pid})`); }
  }
}
sweepDeadGateRoots(realRoot);
const gateRoot = mkdtempSync(join(realRoot, "gate-sa-"));
writeFileSync(join(gateRoot, "owner.json"), JSON.stringify({ pid: process.pid, keep }));
const dataRoot = mkdtempSync("/tmp/hg-4a-");
for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: gateRoot, HOUGE_TELEGRAM_CHAT_ID: CHAT, HOUGE_TOMBSTONE_PATH: join(dataRoot, "houge.kill"),
  HOUGE_PARK_MARKER_PATH: join(dataRoot, "houge.parked"), HOUGE_DISARM_PATH: join(dataRoot, "houge.disarm"), HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_TRIAGE_ENABLED: "off" });
const cleanup = () => { if (keep) { console.log(`kept (holds live-DB copies): ${dataRoot} ${gateRoot}`); return; } rmSync(dataRoot, { recursive: true, force: true }); rmSync(gateRoot, { recursive: true, force: true }); };
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

const m = Object.assign({}, ...(await Promise.all(["run/run-store.js", "gateway/gateway.js", "domain/types.js", "omp/bridge-handler.js", "omp/tool-approval-sink.js", "omp/tool-decls.js",
  "omp/omp-config.js", "omp/shell-adapter.js", "omp/seatbelt.js", "omp/workspace.js", "omp/cleanroom.js", "core/omp-turn-wiring.js", "contracts/task-contract.js", "decisions/trust.js",
  "budget/budget-ledger.js", "tools/tool-registry.js", "capabilities/capability-runner.js", "notifications/notification-dispatcher.js", "notifications/notification-outbox.js",
  "telegram/telegram-daemon.js", "triggers/telegram-trigger-adapter.js"].map((p) => import(join(DIST, p))))));
for (const k of ["STANDING_TRIAL_LINE", "actionFingerprint", "createOutboxDispatcher", "shellToolExecute", "OMP_SHELL_META"]) if (m[k] === undefined) throw new Error(`${k} missing from dist: rebuild`);
const CFG = m.resolveOmpConfig(process.env);
const DECLS = (() => { const r = m.loadToolDeclarations(m.TOOL_DECLS_DIR); if (!r.ok) throw new Error(r.error); return r.decls; })();
const fpOf = (command) => m.actionFingerprint("shell_external", m.OMP_SHELL_META.shell_external, { command });
const roomsLeft = () => (existsSync(m.cleanroomRoot()) ? readdirSync(m.cleanroomRoot()).filter((n) => /^(room|home)-/.test(n)) : []);
const statOf = (p) => (existsSync(p) ? `${statSync(p).size}:${statSync(p).mtimeMs}` : "absent");

/** The daemon is writing the live DB: a VACUUM INTO that meets its lock is retried (5 × 1 s); only ever into the gate's data root. */
function copyDb(from, to) {
  if (!resolve(to).startsWith(`${dataRoot}/`)) throw new Error(`refusing to write outside the gate's data root: ${to}`);
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000); }
    finally { src.close(); }
  }
}

// ---- one case environment: a copy, a data dir, a schedule, the real shell with seams, the bridge, an approver, a dispatcher ----
function openEnv(name, o = {}) {
  const dir = join(dataRoot, name); mkdirSync(dir, { recursive: true });
  const path = join(dir, "houge.sqlite"); copyDb(join(dataRoot, "base.sqlite"), path);
  const data = join(dir, "data"); const ws = m.chatWorkspace(data, CHAT); mkdirSync(ws, { recursive: true, mode: 0o700 });
  const ctx = { home: homedir(), repo: REPO, data }; m.writeSeatbeltProfiles(ctx); // the unsealed runs' profile, as the worker writes it
  const store = m.RunStore.open(path);
  const schedule_id = store.addScheduledTask({ chat_id: CHAT, goal: "Alishan check-in (gate)", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2099-01-01T00:00:00.000Z" }).schedule_id;
  const e = { name, path, store, data, ws, schedule_id, runs: [], approvals: [], cards: [], sidecars: [], turn: null, fp: fpOf(o.command ?? CMD), decide: o.decide ?? (() => "approved") };
  const cleanroomDeps = { afterSidecar: (dirs) => { e.sidecars.push(existsSync(join(dirs.home, "cleanroom.sb"))); }, ...(o.cleanroomDeps ?? {}) }; // observes only
  const cfg = { ...CFG, sandbox: o.sandbox ?? CFG.sandbox };
  const shell = m.shellToolExecute({ cfg, ctx, distDir: DIST, cwd: ws, onIncident: (kind, detail) => { store.openIncident({ kind, subject: `chat:${CHAT}`, detail }); }, cleanroomDeps });
  e.registry = new m.ToolRegistry();
  for (const [n, meta] of Object.entries(m.OMP_SHELL_META)) e.registry.register({ name: n, category: "tool", ...meta, timeout_ms: cfg.shellTimeoutMs + 30_000, execute: shell });
  e.handle = m.createBridgeHandler({ store, cfg, ctx, decls: DECLS, env: process.env, turnEnvelopeActions: [...m.TURN_ACTIONS], activeTurn: () => e.turn });
  const stub = { send: async (n) => { e.cards.push(n); return { provider_message_id: `gate:${n.notification_id}` }; } }; // records, never sends
  e.dispatcher = m.createOutboxDispatcher(store, { local: stub, telegram: stub }); // the daemon's own sender, onDelivered included
  e.stopApprover = approver(e);
  return e;
}
async function closeEnv(e) { await e.stopApprover(); e.store.close(); }

/** Approval cards: each new one is answered by the env's rule; the "Why:" line and the fingerprint are kept (2b gate seam). */
function approver(e) {
  const seen = new Set(); let stop = false;
  const card = (id) => { // read-only, as the 2b gate reads it: the card row lands with the request
    const db = new DatabaseSync(e.path, { readOnly: true });
    try { const row = db.prepare(`SELECT payload_json FROM notification_outbox WHERE approval_id = ?`).get(id); return row ? String(JSON.parse(row.payload_json).text ?? "") : null; } finally { db.close(); }
  };
  const loop = (async () => {
    while (!stop) {
      for (const run of [...e.runs]) for (const ev of e.store.getLedgerEvents(run).filter((x) => x.event_type === "approval_requested")) {
        const id = ev.payload.approval_id; if (seen.has(id)) continue;
        const text = card(id); if (text === null) continue;
        seen.add(id);
        const why = /^Why: (.*)$/m.exec(text)?.[1] ?? null; const fp = ev.payload.action_fingerprint; const decision = e.decide({ fp, why, run });
        e.approvals.push({ run, id, why, fp, decision });
        e.store.resolveToolApprovalForTest(id, decision); m.toolApprovalWaiters.resolve(id, decision);
      }
      await sleep(50);
    }
  })();
  return async () => { stop = true; await loop; };
}

/** A run through the real gateway, claimed, with the ActiveTurn the supervisor would build (scheduled: the operator approves). */
let seq = 0;
function startRun(e, kind = "schedule") {
  const n = `${Date.now()}-${++seq}`;
  const event = kind === "schedule"
    ? { source: "schedule", type: "turn", program: "turn", goal: "Alishan check-in (gate)", requested_by: { kind: "schedule", id: e.schedule_id }, notify: { kind: "telegram", chat_id: CHAT },
        idempotency_key: `schedule:${e.schedule_id}:gate4a:${n}`, source_reference: `scheduled_tasks.${e.schedule_id}` }
    : { source: "telegram", type: "turn", program: "turn", goal: "post it", requested_by: OPERATOR, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `gate4a:telegram:${n}`, source_reference: `gate4a:${n}` };
  const r = new m.Gateway(e.store, undefined, undefined, undefined, undefined, { dataDir: e.data }).intake(m.buildTypedTaskEvent(event));
  if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
  const worker_id = `planner:${CHAT}:gate`; const claim = e.store.claimRun(r.run_id, worker_id, 600); if (!claim) throw new Error("claim failed");
  e.turn = { run_id: r.run_id, worker_id, chat_id: CHAT, requester: event.requested_by, ...(kind === "schedule" ? { approver: OPERATOR } : {}), contract: claim.contract,
    budget: new m.BudgetLedger(claim.contract.budget), registry: e.registry, signal: new AbortController().signal, cwd: e.ws, step: { n: 0 }, cache: new Map(), unreported: new Map(),
    quarantine: async (tool) => ({ digest: "d", contains_instructions: false, source_meta: { tool, bytes: 1 } }), setAwaitingApproval: () => undefined, postureOk: () => null, judge: PASS_JUDGE,
    trust: new m.TurnTrust({ store: e.store, run_id: r.run_id, chat_id: CHAT, born: kind === "schedule" ? "schedule" : "telegram", env: {} }) };
  e.runs.push(r.run_id);
  return r.run_id;
}
const call = (e, command, tc) => e.handle({ id: `r-${tc}`, kind: "call", tool: "bash", input: { command }, toolCallId: tc });
const queuedRows = (e) => { const db = new DatabaseSync(e.path, { readOnly: true }); try { return db.prepare(`SELECT COUNT(*) AS n FROM notification_outbox WHERE state = 'queued'`).get().n; } finally { db.close(); } };
/** Dispatch until this run's own final_report is delivered, at most one pass per queued row (the copy may carry older rows); never a silent miss. */
async function deliver(e, run) {
  for (let i = 0, bound = queuedRows(e); i < bound && e.store.finalReportState(run) !== "delivered"; i++) if ((await e.dispatcher.dispatchOnce("gate")).status === "idle") break;
  if (e.store.finalReportState(run) !== "delivered") throw new Error(`${run}:final_report not delivered (${e.store.finalReportState(run) ?? "none"})`);
}
/** A row queued by a delivery's own settlement (the grant card): dispatch until it is delivered, at most one pass per queued row; the caller's check asserts the state. */
async function deliverNotification(e, notification_id) {
  for (let i = 0, bound = queuedRows(e); i < bound && e.store.getNotification(notification_id)?.state !== "delivered"; i++) if ((await e.dispatcher.dispatchOnce("gate")).status === "idle") break;
}
/** Terminal state and its one notice (success and failure share the key, §2), then delivery through the daemon's dispatcher options. */
async function finish(e, run, ok = true) {
  if (ok) { e.store.finishRun({ run_id: run, expected_worker_id: e.turn.worker_id, next: "completed", report_ref: `runs/gate4a-${run}.md`, duration_ms: 1, tool_calls: 1 }); e.store.enqueueFinalReportNotification(run, { text: "200", report_path: `runs/gate4a-${run}.md` }); }
  else { e.store.finishRun({ run_id: run, expected_worker_id: e.turn.worker_id, next: "failed", error_type: "planner_exit", error_ref: "gate" }); e.store.enqueueFailureNotification(run, "I hit an error on that one: gate"); }
  await deliver(e, run);
}
const evs = (e, run, type) => e.store.getLedgerEvents(run).filter((x) => x.event_type === type);
const fin = (e, run, tc) => evs(e, run, "tool_finished").find((x) => x.payload.tool_call_id === tc)?.payload;
const reasons = (e, run, tc) => e.store.listDecisionsForRun(run).filter((d) => d.entry_id === "tool.policy" && d.tool_call_id === tc).map((d) => d.reason_code);
const facts = (f) => (f?.cleanroom ? JSON.stringify(f.cleanroom) : "no facts");
const keyOf = (e, fp = e.fp) => ({ schedule_id: e.schedule_id, chat_id: CHAT, action_fingerprint: fp });
function seedRow(e, state, fp = e.fp) {
  const move_id = state === "standing" ? e.store.insertLadderMove({ entry_id: "tool.policy", scope: "gate", from_rung: "paco", to_rung: "rule", evidence: ["g1", "g2", "g3"], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true }) : null;
  return e.store.insertStandingApprovalForTest({ ...keyOf(e, fp), state, credited_runs_json: '["g-r1","g-r2","g-r3"]', approval_ids_json: '["g-a1","g-a2","g-a3"]',
    ...(move_id ? { move_id, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() } : {}) });
}
let cbn = 0;
function tapRevoke(e, chat, data) {
  const r = m.normalizeTelegramUpdate({ update_id: 900_000 + ++cbn, callback_query: { id: `gate-cb-${cbn}`, from: { id: 111 }, message: { message_id: cbn, chat: { id: Number(chat) } }, data } }, ALLOWLIST);
  if (!r.ok) return r;
  return new m.Gateway(e.store, undefined, undefined, undefined, undefined, { dataDir: e.data }).intake(r.event);
}

// ---- cases ----
async function caseMain(e) {
  for (let i = 1; i <= 3; i++) { const run = startRun(e); await call(e, CMD, `s${i}`); await finish(e, run); }
  const c = e.store.standingFor(keyOf(e));
  check("1 three approvals consumed on three distinct scheduled runs → candidate", c?.state === "candidate" && JSON.parse(c.credited_runs_json).length === 3 && e.approvals.length === 3 && e.approvals.every((a) => a.fp === e.fp && a.decision === "approved"),
    `${c?.state ?? "no row"} · approvals ${e.approvals.length} · streak events ${e.runs.flatMap((r) => evs(e, r, "standing_streak").map((x) => x.payload.streak)).join(",")}`);
  if (!c) return;
  const run4 = startRun(e); const s0 = e.sidecars.length; await call(e, CMD, "s4"); const f4 = fin(e, run4, "s4"); const a4 = e.approvals.at(-1); const r4 = e.store.getStandingApproval(c.standing_id);
  check("2 the fourth run asks with the trial line; approved, it runs sealed (exit 0, ran, torn down, a room- name) and leaves no room behind; the row is sealing on that call",
    a4?.run === run4 && a4.why === m.STANDING_TRIAL_LINE && a4.fp === e.fp && f4?.executor === "cleanroom" && f4.cleanroom.ran === true && f4.cleanroom.torn_down === true && f4.cleanroom.exit_code === 0
      && /^room-/.test(f4.cleanroom.room ?? "") && e.sidecars.length === s0 + 1 && r4?.state === "sealing" && r4.sealed_tool_call_id === "s4" && roomsLeft().length === 0,
    `why ${JSON.stringify(a4?.why)} · ${facts(f4)} · row ${r4?.state} · rooms left ${roomsLeft().length}`);
  await finish(e, run4);
  // the report's delivery settles the trial and only then queues the grant card: deliver that card too before line 3 asserts it
  const queuedCard = e.store.getStandingApproval(c.standing_id)?.grant_notification_id;
  if (queuedCard) await deliverNotification(e, queuedCard);
  const g = e.store.getStandingApproval(c.standing_id); const move = g?.move_id ? e.store.getLadderMove(g.move_id) : undefined; const card = g?.grant_notification_id ? e.store.getNotification(g.grant_notification_id) : undefined;
  const ev = move ? JSON.parse(move.evidence_json) : [];
  check("3 completed run + delivered report → standing at once (Decision 1-A): auto move on tool.policy via approval.standing, evidence approvals → decision → run → call, the grant card delivered with Revoke",
    g?.state === "standing" && move?.granted_by === "auto" && move.granted_via === "approval.standing" && move.state === "active" && ev.length === 7 && String(ev[4]).startsWith("dec_") && ev[5] === run4 && ev[6] === "s4"
      && card?.state === "delivered" && card.payload.buttons?.[0]?.data === `dec:sa:${c.standing_id}:revoke`, `${g?.state} · move ${move?.granted_by}/${move?.granted_via} · evidence ${ev.length} · card ${card?.state}`);
  if (g?.state !== "standing") return;
  const jar = statOf(join(e.ws, "cj.txt"));
  const run5 = startRun(e); const s5 = e.sidecars.length; const out5 = await call(e, CMD, "s5"); const f5 = fin(e, run5, "s5");
  check("4 the fifth run: zero approval_requested, tool.policy reason standing, cleanroom.sb selected (a sidecar in a fresh home, executor cleanroom, ran, exit 0), one standing use, the workspace jar untouched",
    evs(e, run5, "approval_requested").length === 0 && reasons(e, run5, "s5").includes("standing") && e.sidecars.length === s5 + 1 && e.sidecars.at(-1) === true && f5?.executor === "cleanroom"
      && f5.cleanroom.ran === true && f5.cleanroom.exit_code === 0 && out5.isError === false && evs(e, run5, "standing_used").length === 1 && statOf(join(e.ws, "cj.txt")) === jar,
    `asks ${evs(e, run5, "approval_requested").length} · reasons [${reasons(e, run5, "s5").join(",")}] · ${facts(f5)} · jar ${jar === statOf(join(e.ws, "cj.txt")) ? "untouched" : "CHANGED"}`);
  await call(e, CMD, "s5b"); const f5b = fin(e, run5, "s5b");
  check("5 a second call of the same bytes in the same run asks (one use per run, reason standing_mismatch); approved, it still runs sealed",
    evs(e, run5, "approval_requested").length === 1 && reasons(e, run5, "s5b").includes("standing_mismatch") && f5b?.executor === "cleanroom" && evs(e, run5, "standing_used").length === 1,
    `asks ${evs(e, run5, "approval_requested").length} · reasons [${reasons(e, run5, "s5b").join(",")}] · executor ${f5b?.executor}`);
  await finish(e, run5);
  e.decide = ({ fp }) => (fp === e.fp ? "approved" : "denied");
  const run6 = startRun(e); await call(e, CMD_BYTE, "s6"); const asked6 = evs(e, run6, "approval_requested");
  check("6 one byte changed asks (another fingerprint; denied, the grant on the original bytes stands)", asked6.length === 1 && asked6[0].payload.action_fingerprint === fpOf(CMD_BYTE) && fpOf(CMD_BYTE) !== e.fp
    && evs(e, run6, "standing_used").length === 0 && e.store.getStandingApproval(c.standing_id)?.state === "standing", `asks ${asked6.length} · row ${e.store.getStandingApproval(c.standing_id)?.state}`);
  await finish(e, run6);
  const data = card.payload.buttons[0].data;
  const foreign = tapRevoke(e, OTHER_CHAT, data); const stillStanding = e.store.getStandingApproval(c.standing_id)?.state === "standing";
  const mine = tapRevoke(e, CHAT, data); const ended = e.store.getStandingApproval(c.standing_id);
  const run7 = startRun(e); await call(e, CMD, "s7");
  check("7 Revoke from the row's chat ends the row and its move in one tap (a tap from another chat changes nothing); the next run asks again",
    foreign.ok === true && stillStanding && mine.ok === true && ended?.state === "ended" && ended.ended_reason === "revoked" && e.store.getLadderMove(g.move_id)?.state === "ended"
      && evs(e, run7, "approval_requested").length === 1 && evs(e, run7, "standing_used").length === 0, `foreign kept ${stillStanding} · ${ended?.state}/${ended?.ended_reason} · next run asks ${evs(e, run7, "approval_requested").length}`);
  await finish(e, run7);
}

async function caseDeny(e) {
  const row = seedRow(e, "standing");
  e.decide = ({ run }) => (e.store.getRunForWorker(run)?.source === "telegram" ? "denied" : "approved");
  const u = startRun(e, "user"); await call(e, CMD, "u1"); await finish(e, u);
  const after = e.store.getStandingApproval(row.standing_id);
  const blockDays = after?.denied_until ? (Date.parse(after.denied_until) - Date.parse(after.ended_at)) / 86_400_000 : 0;
  const r = startRun(e); await call(e, CMD, "u2"); await finish(e, r);
  check("8 a deny from a user turn on the same bytes ends the schedule's grant and its move with a 30-day block; the next scheduled approval starts no streak",
    after?.state === "ended" && after.ended_reason === "denied" && Math.round(blockDays) === 30 && e.store.getLadderMove(row.move_id)?.state === "ended" && e.store.standingFor(keyOf(e)) === undefined
      && e.store.standingDenied(CHAT, e.fp, new Date().toISOString()), `${after?.state}/${after?.ended_reason} · block ${blockDays.toFixed(2)} d · live row ${e.store.standingFor(keyOf(e))?.state ?? "none"}`);
}

async function caseSandboxOff(e) {
  seedRow(e, "standing"); e.decide = () => "denied"; // never run the command without the sandbox
  const r = startRun(e); await call(e, CMD, "o1"); await finish(e, r);
  check("9 sandbox off → asks (no clean room, so no standing selector and no use)", evs(e, r, "approval_requested").length === 1 && evs(e, r, "standing_used").length === 0 && !reasons(e, r, "o1").includes("standing"),
    `asks ${evs(e, r, "approval_requested").length} · reasons [${reasons(e, r, "o1").join(",")}]`);
}

/** A seeded candidate; the fourth call is approved and runs sealed with the case's seam; the trial must end, never grant. */
async function noSeal(e, tag, title, o) {
  const c = seedRow(e, "candidate", fpOf(o.command ?? CMD));
  const run = startRun(e); await call(e, o.command ?? CMD, "t4"); const f = fin(e, run, "t4"); const mid = e.store.getStandingApproval(c.standing_id)?.state;
  await finish(e, run, o.ok !== false);
  const after = e.store.getStandingApproval(c.standing_id);
  // the run's notice (success or failure) was delivered, so the row ended on the seal facts, never for want of a delivery
  check(`${tag} ${title} → no seal`, mid === "sealing" && f?.executor === "cleanroom" && o.why(f) && e.store.finalReportState(run) === "delivered" && after?.state === "ended"
    && after.ended_reason === "sealed_trial_failed" && after.move_id === null && !e.cards.some((n) => n.idempotency_key.startsWith("urgent:standing_grant:")),
    `row ${mid} → ${after?.state}/${after?.ended_reason} · ${facts(f)} · notice ${e.store.finalReportState(run)}`);
}

const CASES = [
  ["main", "lines 1–7", {}, caseMain],
  ["deny", "line 8", {}, caseDeny],
  ["sandbox", "line 9", { sandbox: false }, caseSandboxOff],
  ["exit", "line 10", { command: CMD_500 }, (e) => noSeal(e, "10", "a non-zero exit through the real bridge", { command: CMD_500, why: (f) => f.cleanroom.exit_code !== 0 && f.cleanroom.ran === true })],
  ["teardown", "line 11", { cleanroomDeps: { rm: (p) => { if (!/\/room-[^/]+$/.test(p)) rmSync(p, { recursive: true, force: true }); } } },
    (e) => noSeal(e, "11", "a teardown failure (rm seam leaves the room)", { why: (f) => f.cleanroom.torn_down === false })],
  ["check", "line 12", { cleanroomDeps: { lsof: () => { throw new Error("lsof seam: gate"); } } }, (e) => noSeal(e, "12", "a check_error (lsof seam throws)", { why: (f) => f.cleanroom.check_failed === true })],
  ["failed", "line 13", {}, (e) => noSeal(e, "13", "a failed run whose failure notice was delivered", { ok: false, why: (f) => f.cleanroom.exit_code === 0 && f.cleanroom.torn_down === true && !f.cleanroom.tampered })],
  ["tamper", "line 14", { cleanroomDeps: { afterSpawn: (dirs) => writeFileSync(join(dirs.home, ".curlrc"), "# gate plant\n") } }, (e) => noSeal(e, "14", "a .curlrc planted in the home mid-run", { why: (f) => f.cleanroom.tampered === true })]
];

async function main() {
  const control = spawnSync("/usr/bin/curl", ["-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-d", "a=1", "https://httpbin.org/post"], { encoding: "utf8" });
  if (control.status === null || control.error) return check("network: unsandboxed control curl runs", false, `curl unavailable: ${control.error?.message ?? control.signal}`);
  if (control.status !== 0 || control.stdout !== "200") {
    inconclusive = true; notes.push(`INCONCLUSIVE network: unsandboxed POST to httpbin.org exit ${control.status} http ${control.stdout} (offline?) — rerun once; ship only with the diagnosis in the report`);
    return console.log(notes.at(-1));
  }
  copyDb(live, join(dataRoot, "base.sqlite"));
  for (const [id, title, opts, fn] of CASES) {
    if (only && !only.has(id)) continue;
    const e = openEnv(`case-${id}`, opts);
    try { await fn(e); ran.push(id); } catch (err) { check(`${id} (${title}) ran to the end`, false, String(err?.stack ?? err)); }
    finally { await closeEnv(e); }
  }
}

/** Line 15, after cleanup: both roots gone, the real cleanroom/ exactly as before. */
function nothingLeft() {
  const after = names(realCr);
  check("15 nothing left", !existsSync(gateRoot) && !existsSync(dataRoot) && after === realCrBefore, `gate root exists ${existsSync(gateRoot)} · data root exists ${existsSync(dataRoot)} · real cleanroom/ before [${realCrBefore}] after [${after}]`);
}

if (CASES.map(([id]) => id).join(",") !== CASE_IDS.join(",")) { cleanup(); throw new Error("CASE_IDS and CASES disagree: fix the gate"); }
try { await main(); } catch (e) { check("gate ran to the end", false, String(e?.stack ?? e)); }
finally { cleanup(); }
if (!keep) nothingLeft();
// a shipping PASS needs every case to have run: --only, or a case that threw before ran.push, is never ok
const partial = ran.length < CASES.length;
if (inconclusive && fails === 0) process.exitCode = 2;
else if (partial && fails === 0) { process.exitCode = 3; console.log(`PARTIAL ran [${ran.join(",")}] of [${CASES.map(([id]) => id).join(",")}] — not a shipping PASS`); }
console.log(JSON.stringify({ ok: fails === 0 && !inconclusive && !partial, fails, inconclusive, partial, cases: ran, notes }));
