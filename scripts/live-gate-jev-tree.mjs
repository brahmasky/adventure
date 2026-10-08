#!/usr/bin/env node
// Live gate — Jev decision tree, stage A (spec §9 "Live gate per stage" + "Stage A PASS criterion"; plan Task 13).
// Runs the REAL Jev, the real memory-lane legs and the real omp planner (profile houge) against a TEMP COPY of the
// live DB (VACUUM INTO under /tmp). The live DB is only read; the daemon is never touched.
//
//   npm run build && HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-jev-tree.mjs [--db <path>] [--keep] [--real-calibration]
//
// --real-calibration: no temp file and no HOUGE_JEV_GATE; the tree arms on the committed CALIBRATED_ROWS, as the daemon
// will. This is the MERGE gate (F9): it first checks that the committed rows arm category, rule, status and memory in zh
// and en, and cases 1 and 2 must ACT (INCONCLUSIVE there is a FAIL). Before Paco's commit it therefore FAILs by design.
//
// Model (Rev 5, as the retired lane 1 gate since c026e5c): the request names TypeSafe's moving alias `jev-latest`;
// calibration rows key on the model Jev REPORTS. So setup first sends ONE probe call (the real client, the six tree
// questions, a trivial state) and uses the reported id. With --real-calibration that id must be one CALIBRATED_ROWS names.
//
// Arming (default): a temp calibration file names the six tree questions plus the status pseudo-row (TREE_STATUS_ARM_ID), zh + en
// (so `rule` arms too), model = the probe's reported id, hashes from dist/ — and HOUGE_JEV_GATE=1. The bars
// (TREE_BAR_DEFAULTS) still apply: Jev's real probabilities must clear them.
//
// Cases (each asserts ledger rows):
//   1  memory rule → lane memory, lane_reply, save_outcome saved, zero planner requests, distill/consolidate on the Tiny role
//   2  status question → lane status, lane_reply, zero planner requests
//   3  bare thanks after a plain answer → ack rule (no Jev call), category answer, Fast; planner answers on the Fast head
//   4  bare "好" after a proposal → the ack rule does NOT fire, Jev is asked
//   5  "好" quoting an older delivered Houge reply (real outbox id in the copy) → quoted_turn_id on the verdict and the
//      user chat turn; never the ack rule
//   6  a lookup that carries a rule (sets_rule) → saved first, then the planner answers
//   7  a correction of a stored rule → planner, nothing saved by the lane
//   8  a request beyond a lookup lane's limits (broad research) → planner on the routed role (Thinking for research)
//   9  roles against the real `omp --profile houge models --json`: every role's head = its list's first CATALOGUED
//      selector on an allowed provider (never openai-codex on a chat role); uncatalogued entries are INFO; Tiny =
//      kimi-code/k3, allow-list before matching, effort clamp, the daily tick
//   10 state parity: a dry-run replay over the copy rebuilds the live `state_hash` of each answered gate turn
//   11 Jev transport down × N → skipped{transport}, one verdict row per turn (category null, fallback, Default), the
//      sweep reports jev_skip_rate
//   12 the live cascade (Decision 14): (a) a stubbed below-bar Jev answer → one real cascade call on the Tiny head,
//      answered and routed (reason cascade) within CASCADE_TIMEOUT_MS; (b) any real-Jev gate turn that went below the
//      bar on its own: cascade attempts precede the planner's, no routed_by (INCONCLUSIVE when none did)
//   probes: two triage-only real-Jev turns, so the skip-rate bar sees ≥ 8 real calls
//   PASS criterion over every gate turn: each planner-lane verdict's first `compose` attempt carries routed_by =
//   verdict_id and answers on the head of its routed candidates with the routed, clamped effort (a silent pin that left
//   the child on the spawn leg, or on the spawn leg's effort, FAILs here); pin_failed = 0; no planner-path verdict left
//   pending after shutdown; ≤ 1 silent Jev skip in ≥ 8 real calls and no jev_skip_rate incident open at the end.
//
// Cannot exercise (hermetic instead): a quote of Paco's own message (resolution through source_reference: Task 4
// tests), a refused pin (`Model not found`: Task 8 fake omp), the broker-supplied Jev key (Task 9 of lane 1), a cascade
// that times out (Task 10's fake-timer test; the live 20 s bound is measured in case 12a).
//
// Budget: Jev calls are metered but tiny; cases 3-8 each run one real planner turn (case 8 may run several tools);
// cases 1 and 6 run the distill + reconcile legs; case 12a runs one Tiny one-shot. Exit: 0 PASS · 1 FAIL · 2 setup error.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Jev's probabilities vary run to run: a message can land under a bar and rightly take another path. That case is
// INCONCLUSIVE for the path it meant to exercise (listed, never a PASS of it); the path the recorded verdict names is
// checked instead, so a code fault still FAILs.
const inconclusive = [];
const noEffort = (s) => (s ?? "").split(":")[0];
const key = (provider, model) => `${provider}/${model}`;

function envFilePath() {
  return process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env");
}

function parseArgs(argv) {
  const a = { db: null, keep: false, realCalibration: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep") a.keep = true;
    else if (argv[i] === "--real-calibration") a.realCalibration = true;
    else if (argv[i] === "--db") a.db = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

async function loadModules() {
  const mods = await Promise.all([
    "config/load-env.js", "config/disarm-posture.js", "core/core-worker.js", "domain/types.js", "gateway/gateway.js",
    "run/run-store.js", "jev/jev-client.js", "jev/questions/tree.js", "jev/questions/types.js", "jev/jev-incidents.js",
    "jev/triage-replay.js", "run/invariant-sweep.js", "omp/model-roles.js", "omp/model-catalog.js", "omp/role-resolver.js",
    "omp/omp-config.js", "omp/model-roles-tick.js", "jev/tree-policy.js", "jev/calibration.js", "omp/omp-version.js"
  ].map((p) => import(`../dist/${p}`)));
  const m = Object.assign({}, ...mods);
  const need = ["loadHougeEnv", "DISARM_FLAGS", "CoreWorker", "buildTypedTaskEvent", "Gateway", "RunStore", "createJevClient", "toJevQuestion", "CALIBRATED_ROWS", "TREE_QUESTIONS",
    "isProposal", "criteriaHash", "JEV_INCIDENT_SUBJECT", "runTreeReplay", "detectViolations", "checkJevSkipRate", "JEV_NOT_ATTEMPT_REASONS",
    "JEV_SILENT_SKIP_REASONS", "ROLE_LISTS", "ALLOWED_PROVIDERS", "CHAT_ROLES", "matchOverride", "clampEffort", "STEP_UP", "readOmpCatalog",
    "RoleResolver", "resolveOmpConfig", "runModelRolesTick", "treeArmed", "TREE_STATUS_ARM_ID", "calibrationRows", "checkOmpVersion", "CASCADE_TIMEOUT_MS", "CATEGORIES"];
  const missing = need.filter((n) => m[n] === undefined);
  if (missing.length > 0) throw new Error(`dist/ lacks ${missing.join(", ")} (build the branch first)`);
  return m;
}

/** One real Jev call (the six tree questions, a trivial state) for the model id the alias currently reports. Audit: in memory. */
async function probeReportedModel(m) {
  const mem = m.RunStore.openInMemory();
  try {
    const jev = m.createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, audit: mem.llmAuditSink({ correlation_id: "gate:jev-probe", role: "" }),
      meteredBreached: () => false, retries: 1, timeoutMs: 15_000 });
    const questions = Object.fromEntries(m.TREE_QUESTIONS.map((q) => [q.id, m.toJevQuestion(q)]));
    const r = await jev({ state: { latest_message: "hello" }, questions });
    if (!r.ok) throw new Error(`model probe failed: ${r.reason}`);
    return r.model;
  } finally { mem.close(); }
}

/** Gate-only calibration: the six tree questions and the status pseudo-row (treeArmed), zh + en, hashes from dist/, model = m.model. */
function writeCalibration(m, root) {
  const category = m.TREE_QUESTIONS.find((q) => q.id === "category");
  const ids = [...m.TREE_QUESTIONS.map((q) => [q.id, m.criteriaHash(q)]), [m.TREE_STATUS_ARM_ID, m.criteriaHash(category)]];
  const rows = ids.flatMap(([question_id, criteria_hash]) => ["zh", "en"].map((lang) =>
    ({ question_id, criteria_hash, model: m.model, lang, approved: "live-gate", evidence: "live-gate (temp file, never committed)" })));
  const file = join(root, "calibration.json");
  writeFileSync(file, JSON.stringify(rows));
  return file;
}

/** No Telegram, every disarm flag off, markers inside the temp root, resolved roles, the tree armed for the gate only. */
function gateEnv(m, root, realCalibration) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  for (const f of m.DISARM_FLAGS) process.env[f] = "false";
  Object.assign(process.env, {
    HOUGE_EPISODIC_ENABLED: "false", HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm",
    HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed"), HOUGE_MODEL_ROLES: "resolved"
  });
  if (realCalibration) { delete process.env.HOUGE_JEV_GATE; delete process.env.HOUGE_JEV_CALIBRATION_FILE; }
  else Object.assign(process.env, { HOUGE_JEV_GATE: "1", HOUGE_JEV_CALIBRATION_FILE: writeCalibration(m, root) });
}

/** A consistent snapshot of the live DB through a read-only connection (WAL-safe; the daemon keeps running). */
function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/**
 * Intake (optionally as a Telegram reply), settle, ledger reads over the COPY. Every worker gets the gate's own
 * RoleResolver (OmpWorkerOptions.roles, Task 7), already refreshed against the real catalog: a worker that built its
 * own would route on an unread catalog (no clamp), and the join checks would compare two different resolutions.
 */
function harness(m, store, repo, root, roles) {
  const makeWorker = (jevFetch) => new m.CoreWorker(store, repo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, { dataDir: root, distDir: DIST, roles, ...(jevFetch ? { jevFetch } : {}) });
  const intake = (chat, text, replyTo) => {
    const msg = 9_000_000 + Math.floor(Math.random() * 1_000_000); const upd = 8_000_000_000 + msg;
    const r = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir: root }).intake(m.buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: "gate" },
      notify: { kind: "telegram", chat_id: chat }, idempotency_key: `telegram:${upd}:${msg}`, source_reference: `telegram:update:${upd}:message:${msg}`,
      metadata: { telegram_update_id: upd, telegram_message_id: msg, ...(replyTo !== undefined ? { reply_to_message_id: replyTo } : {}) } }));
    if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
    return r.run_id;
  };
  const settle = async (run_id, ms = 600_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = store.getRunState(run_id);
      if (s === "completed" || s === "failed" || s === "waiting_for_approval") return s;
      await sleep(500);
    }
    return "timeout";
  };
  const events = (run_id, type) => store.getLedgerEvents(run_id).filter((e) => e.event_type === type);
  const attempts = (run_id, role) => events(run_id, "llm_attempt").filter((e) => role === undefined || e.payload.role === role);
  return { makeWorker, intake, settle, events, attempts, verdict: (run_id) => store.getJevVerdictForRun(run_id) };
}

const show = (label, v) => console.log(`  verdict[${label}] ${JSON.stringify(v ? { category: v.category, lane: v.lane, role: v.role, effort: v.effort,
  reason: v.reason, save: v.save_outcome, route: v.route_outcome, handler: v.handler_outcome, model: v.model, sets_rule: v.sets_rule,
  quoted: v.quoted_turn_id, skip: v.skip_reason } : null)}`);

// Neutral test messages (the repo is public).
const MSG = {
  rule: "从现在起，回复请控制在三句话以内。",
  status: "你刚才重启过吗？现在跑的是哪个版本？",
  plainAnswer: "明天悉尼晴，最高 22 度。",
  thanks: "谢谢",
  proposal: "要不要我帮你把明天悉尼的天气每天早上推送一次？",
  ok: "好",
  ruleLookup: "以后温度都用摄氏度。明天悉尼天气怎么样？",
  correction: "我之前让你回复控制在三句话以内，那条规则不对，删掉它。",
  research: "帮我比较三款适合家用的 NAS，从价格、功耗和软件生态三方面给出推荐。",
  probes: ["明天悉尼天气怎么样？", "今天有什么值得关注的新闻？"]
};

/** A fresh chat whose last Houge turn is `assistantText` (seeded rows: chat_turns holds no FK to runs). */
function seedChat(store, assistantText) {
  const chat = `-4${Date.now() % 1_000_000}${Math.floor(Math.random() * 100)}`;
  const run_id = `run_gateseed_${randomUUID()}`; const t = Date.now();
  store.recordChatTurn({ chat_id: chat, run_id, role: "user", text: "明天悉尼天气怎么样？", created_at: new Date(t - 90_000).toISOString() });
  store.recordChatTurn({ chat_id: chat, run_id, role: "assistant", text: assistantText, intent: "loop", created_at: new Date(t - 60_000).toISOString() });
  return chat;
}

/** Runs one Telegram turn to its end and returns its verdict (shown). */
async function turn(g, label, chat, text, replyTo) {
  const run_id = g.h.intake(chat, text, replyTo); g.worker.submitTurn(run_id);
  const s = await g.h.settle(run_id);
  check(`${label}: turn ended`, s === "completed" || s === "failed" || s === "waiting_for_approval", s);
  const v = g.h.verdict(run_id); show(label, v);
  check(`${label}: exactly one jev_verdicts row`, v !== undefined);
  return { run_id, v, state: s };
}

const laneSaves = (g, run_id) => g.h.events(run_id, "lesson_saved").filter((e) => e.payload.source === "lane").length;
// A request reached Jev = a provider "jev" llm_attempt in the run. Not jev_decisions: the ack rule records its own
// skipped{ack_rule} row there (one decision row per turn, no request sent).
const jevAsked = (g, run_id) => g.h.attempts(run_id).some((e) => e.payload.provider === "jev");
const decisionsOf = (g, run_id) => g.store.listJevDecisions(run_id).map((r) => `${r.status}${r.skip_reason ? `{${r.skip_reason}}` : ""}`).join(",") || "none";

/**
 * The lane took another path than the case meant: INCONCLUSIVE, then the recorded path is checked for consistency.
 * `mustAct` (cases 1, 2): under --real-calibration the merge needs the lanes to act on Paco's rows, so it FAILs (F9).
 */
function otherPath(g, label, run_id, v, o = {}) {
  inconclusive.push(`${label}: Jev's call gave ${v?.category ?? "none"}/${v?.lane ?? "none"} (${v?.reason ?? "no verdict"}); this case's path was not exercised`);
  console.log(`INCONCLUSIVE ${label} — ${v?.category ?? "none"}/${v?.lane ?? "none"}; checking that path instead`);
  const compose = g.h.attempts(run_id, "compose").length;
  if (v?.lane === "planner") check(`${label} [as planner]: the planner answered`, compose > 0, `compose=${compose}`);
  else check(`${label} [as ${v?.lane}]: lane reply, zero planner requests`, v?.handler_outcome === "lane_reply" && compose === 0, `handler=${v?.handler_outcome} compose=${compose}`);
  check(`${label}: lane saves match save_outcome`, (v?.save_outcome === "saved") === (laneSaves(g, run_id) === 1), `save=${v?.save_outcome} saves=${laneSaves(g, run_id)}`);
  if (o.mustAct && g.strict) {
    check(`${label}: the lane acted under --real-calibration (INCONCLUSIVE is a FAIL for the merge)`, false, `${v?.category ?? "none"}/${v?.lane ?? "none"} (${v?.reason ?? "no verdict"})`);
  }
}

/** 1: the memory lane saves the rule on K3 with no planner request. */
async function caseMemory(g) {
  const { run_id, v } = await turn(g, "1 memory", g.chat, MSG.rule);
  if (v?.lane !== "memory") { otherPath(g, "1 memory", run_id, v, { mustAct: true }); return; }
  check("1 memory: lane_reply, saved, act", v.handler_outcome === "lane_reply" && v.save_outcome === "saved" && v.route_outcome === "act");
  check("1 memory: zero planner requests", g.h.attempts(run_id, "compose").length === 0);
  const legs = [...g.h.attempts(run_id, "distill"), ...g.h.attempts(run_id, "consolidate")];
  // Rev 4: Tiny is k3 then gemini-3.8-flash, so a leg that fell through to the second candidate is still the memory lane's
  const tiny = new Set(g.roles.candidates("tiny").map((c) => key(c.provider, c.model)));
  const off = legs.filter((e) => !tiny.has(key(e.payload.provider, e.payload.model)));
  check("1 memory: distill + reconcile ran, all on the Tiny role's candidates", legs.some((e) => e.payload.role === "distill") && off.length === 0,
    legs.map((e) => `${e.payload.role}:${key(e.payload.provider, e.payload.model)}`).join(" "));
  check("1 memory: exactly one lane lesson_saved", laneSaves(g, run_id) === 1);
}

/** 2: the status lane answers from code. */
async function caseStatus(g) {
  const { run_id, v } = await turn(g, "2 status", g.chat, MSG.status);
  if (v?.lane !== "status") { otherPath(g, "2 status", run_id, v, { mustAct: true }); return; }
  check("2 status: lane_reply, act, zero planner requests", v.handler_outcome === "lane_reply" && v.route_outcome === "act" && g.h.attempts(run_id, "compose").length === 0);
}

/** 3: thanks after a plain answer is settled in code (spec §2.1): no Jev call, Fast. Deterministic: a miss is a FAIL. */
async function caseAck(g) {
  const { run_id, v } = await turn(g, "3 ack", seedChat(g.store, MSG.plainAnswer), MSG.thanks);
  check("3 ack: reason ack_rule, category answer, role fast, lane planner", v?.reason === "ack_rule" && v.category === "answer" && v.role === "fast" && v.lane === "planner");
  check("3 ack: no Jev call (no jev llm_attempt; decisions only skipped{ack_rule})", !jevAsked(g, run_id)
    && g.store.listJevDecisions(run_id).every((r) => r.status === "skipped" && r.skip_reason === "ack_rule"), `jev_decisions=${decisionsOf(g, run_id)}`);
}

/** 4: "好" after a proposal is never the ack rule; Jev classifies it. Deterministic gate on the code path. */
async function caseOkAfterProposal(g) {
  const { run_id, v } = await turn(g, "4 好 after proposal", seedChat(g.store, MSG.proposal), MSG.ok);
  check("4 好: the ack rule did not fire, Jev was asked", v?.reason !== "ack_rule" && jevAsked(g, run_id), `reason=${v?.reason}`);
}

/** The quote target: a delivered final_report outbox row in the copy that resolves to one Houge turn (a proposal if any). */
function pickQuote(g) {
  const db = new DatabaseSync(g.dbPath, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`SELECT o.target_json, o.provider_message_id, o.created_at FROM notification_outbox o
      WHERE o.intent_type = 'final_report' AND o.state = 'delivered' AND o.provider_message_id LIKE 'telegram:%'
        AND o.run_id IS NOT NULL AND o.idempotency_key NOT LIKE '%:evolution_report:%' ORDER BY o.created_at DESC LIMIT 200`).all();
  } finally { db.close(); }
  const hits = [];
  for (const r of rows) {
    const chat = String(JSON.parse(r.target_json).chat_id); const id = Number(r.provider_message_id.slice("telegram:".length));
    const q = Number.isInteger(id) ? g.store.resolveQuotedTurn(chat, id) : { ok: false };
    if (q.ok && q.role === "houge") hits.push({ chat, id, turn: q.turn });
  }
  // Older than the newest Houge reply in its chat, so the anchor is not just "the last turn"; a proposal first.
  const older = hits.slice(1);
  return older.find((h) => g.m.isProposal(h.turn.text)) ?? older[0] ?? hits[0];
}

/** 5: a quote of an older delivered Houge reply anchors the turn through the real outbox ids in the copy. */
async function caseQuote(g) {
  const target = pickQuote(g);
  if (!target) { check("5 quote: a resolvable delivered final_report exists in the copy", false); return; }
  console.log(`  quote target: telegram:${target.id} → ${target.turn.turn_id} (proposal=${g.m.isProposal(target.turn.text)}, ${target.turn.created_at})`);
  const { run_id, v } = await turn(g, "5 quote", target.chat, MSG.ok, target.id);
  check("5 quote: verdict.quoted_turn_id = the resolved Houge turn", v?.quoted_turn_id === target.turn.turn_id, `got ${v?.quoted_turn_id}`);
  const user = userTurnOf(g, target.chat, run_id);
  check("5 quote: the user chat turn records quoted_turn_id", user?.quoted_turn_id === target.turn.turn_id, `got ${user?.quoted_turn_id}`);
  check("5 quote: a quote is never settled by the ack rule; Jev was asked", v?.reason !== "ack_rule" && jevAsked(g, run_id), `reason=${v?.reason}`);
}

function userTurnOf(g, chat, run_id) {
  return g.store.getRecentChatTurns(chat, 20).find((t) => t.run_id === run_id && t.role === "user");
}

/** 6: a rule riding on a lookup is saved first, then the planner answers (spec §3 "sets_rule = yes with any category"). */
async function caseRuleOnLookup(g) {
  const { run_id, v } = await turn(g, "6 rule+lookup", g.chat, MSG.ruleLookup);
  if (!(v?.save_outcome === "saved" && v.lane === "planner")) { otherPath(g, "6 rule+lookup", run_id, v); return; }
  check("6 rule+lookup: exactly one lane save, then the planner answered", laneSaves(g, run_id) === 1 && g.h.attempts(run_id, "compose").length > 0);
}

/** 7: a correction is not a rule: memory with sets_rule below yes goes to the planner and the lane saves nothing. */
async function caseCorrection(g) {
  const { run_id, v } = await turn(g, "7 correction", g.chat, MSG.correction);
  if (v?.category === "memory" && (v.sets_rule ?? 0) < 0.8) {
    check("7 correction: memory without a rule → planner, nothing saved by the lane", v.lane === "planner" && v.save_outcome === "none" && laneSaves(g, run_id) === 0);
  } else otherPath(g, "7 correction", run_id, v);
}

/** 8: beyond a lookup's limits → the planner on the routed role; research floors at Thinking (ROLE_FLOOR). */
async function caseOverflow(g) {
  const { run_id, v } = await turn(g, "8 overflow", g.chat, MSG.research);
  if (v?.category !== "research") { otherPath(g, "8 overflow", run_id, v); return; }
  check("8 overflow: research → planner on Thinking", v.lane === "planner" && v.role === "thinking", `${v.lane}/${v.role}`);
  // F15: Thinking shares Default's head; only the pinned effort shows the Thinking pin applied
  const ok = g.h.attempts(run_id, "compose").find((e) => e.payload.outcome === "ok");
  const want = ok && g.roles.candidates("thinking", { effort: v.effort }).find((c) => key(c.provider, c.model) === key(ok.payload.provider, ok.payload.model));
  check("8 overflow: the answering attempt carries Thinking's routed, clamped effort", want !== undefined && ok.payload.effort === want.effort,
    `effort=${ok?.payload.effort} want=${want?.effort ?? "(answered off the Thinking list)"}`);
}

/** Probes: triage-only real-Jev turns (no planner) so the skip-rate bar sees ≥ 8 real calls (F11). */
async function caseJevProbes(g) {
  for (const [k, text] of MSG.probes.entries()) {
    const run_id = g.h.intake(`-6${k}0${Date.now() % 100000}`, text); // one chat each: the gateway rate-limits per chat
    g.triageOnly.add(run_id);
    const claim = g.store.claimRun(run_id, `planner:gate:${run_id}`, 300);
    if (!claim) { check(`probe ${k}: claim`, false); continue; }
    g.worker.buildOmpTools(claim);
    const out = await g.worker.triageTurn({ claim, text, userText: text, modality: "text", posture: null, signal: new AbortController().signal });
    const v = g.h.verdict(run_id); show(`probe ${k}`, v);
    check(`probe ${k}: one verdict row, and the route names it`, v !== undefined && out.route?.verdict_id === v.verdict_id);
  }
}

/** Every model id named by every role list, by role (judges per seat). */
function listSelectors(m) {
  return Object.entries(m.ROLE_LISTS).flatMap(([role, list]) => list.map((s, i) => ({ role: role === "judges" ? `judges:${i}` : role, s: noEffort(s) })));
}

/** The list's first selector the catalog carries (spec §4 step 3 drops the rest); undefined when none is catalogued. */
const firstCatalogued = (list, listed) => (list ?? []).find((sel) => listed.has(noEffort(sel)));

/**
 * 9a (F8): each role's head is the first CATALOGUED selector of its list, on an allowed provider, never openai-codex on a
 * chat role; Tiny stays K3 (the memory lane's model). Uncatalogued list entries are INFO: Decision 3 keeps older ids as
 * resilience and the catalog moves within hours, so their absence is not a fault.
 */
function caseRoleHeads(g, catalog) {
  const listed = new Set(catalog.map((c) => key(c.provider, c.id)));
  const missing = listSelectors(g.m).filter((x) => !listed.has(x.s));
  console.log(`  INFO uncatalogued list entries (resolution drops them): ${missing.map((x) => `${x.role}:${x.s}`).join(", ") || "none"}`);
  const overrides = g.store.latestModelRoleOverrides();
  for (const r of g.roles.resolveAll()) {
    const [role, seat] = String(r.key).split(":");
    if (overrides.has(r.key)) { console.log(`  role ${r.key}: override ${overrides.get(r.key)} in the copy → head ${r.head} (not compared)`); continue; }
    const list = seat !== undefined ? [g.m.ROLE_LISTS[role]?.[Number(seat)]].filter(Boolean) : g.m.ROLE_LISTS[role];
    const want = firstCatalogued(list, listed);
    check(`9 roles: ${r.key} head = its list's first catalogued selector`, want !== undefined && r.source === "list" && noEffort(r.head) === noEffort(want),
      `head=${r.head} want=${want ?? "(none catalogued)"} candidates=${r.candidates.join(",")}`);
    const provider = noEffort(r.head).split("/")[0];
    const chat = g.m.CHAT_ROLES.has(role);
    check(`9 roles: ${r.key} head on an allowed provider${chat ? ", not openai-codex" : ""}`,
      g.m.ALLOWED_PROVIDERS.includes(provider) && !(chat && provider === "openai-codex"), `provider=${provider || "(none)"}`);
  }
  const tiny = g.roles.resolveAll().find((r) => r.key === "tiny");
  check("9 roles: tiny resolves to kimi-code/k3 (memory lane unchanged)", noEffort(tiny?.head) === "kimi-code/k3", String(tiny?.head));
}

/** 9b: allow-list before matching, seat eligibility and the effort clamp, on the real catalog. */
function caseRoleRules(g, catalog) {
  const flash = g.m.matchOverride("gemini-3.8-flash", "fast", catalog);
  check("9 roles: a gemini pattern never matches google/ (allow-list before matching)", flash.length > 0 && flash.every((c) => c.provider === "google-antigravity"),
    flash.map((c) => key(c.provider, c.id)).join(","));
  const chat = ["fast", "default", "thinking", "vision", "tiny"].flatMap((role) => g.roles.candidates(role));
  check("9 roles: no chat seat candidate is openai-codex", chat.length > 0 && chat.every((c) => c.provider !== "openai-codex"));
  const k3 = g.m.clampEffort({ provider: "kimi-code", model: "k3" }, "medium", catalog, "resolved");
  check("9 roles: medium on kimi-code/k3 clamps to high (catalog low/high/max)", k3.effort === "high", JSON.stringify(k3));
}

/** 9c: the daily tick on the copy: resolves, reports no unresolved role, then latches for 24 h. */
async function caseRolesTick(g) {
  const notes = []; const now = new Date().toISOString();
  const first = await g.m.runModelRolesTick({ store: g.store, roles: g.roles, now, notify: (t) => notes.push(t) });
  check("9 tick: ran, no role unresolved", first.ran && first.unresolved.length === 0, JSON.stringify({ ...first, notes }));
  const again = await g.m.runModelRolesTick({ store: g.store, roles: g.roles, now: new Date(Date.parse(now) + 60_000).toISOString(), notify: (t) => notes.push(t) });
  check("9 tick: latched within 24 h", again.ran === false, JSON.stringify(again));
}

/** 10: the replay rebuilds the live state of each answered gate turn exactly (Task 12, dry run, no Jev call). */
async function caseParity(g) {
  const live = g.runIds.flatMap((run_id) => g.store.listJevDecisions(run_id).filter((r) => r.status === "answered" && r.question_id === "category"));
  check("10 parity: answered rows carry thread_cut_at + state_built_at", live.length > 0 && live.every((r) => r.thread_cut_at && r.state_built_at), `answered=${live.length}`);
  const r = await g.m.runTreeReplay({ store: g.store, env: process.env, jev: async () => ({ ok: false, reason: "error" }), outPath: join(g.root, "parity.jsonl"),
    maxUsd: 1, dryRun: true, log: () => {} });
  const byRun = new Map(r.rows.map((x) => [x.run_id, x.state_hash]));
  const comparable = live.filter((l) => byRun.has(l.run_id));
  const miss = comparable.filter((l) => byRun.get(l.run_id) !== l.state_hash);
  check("10 parity: replay state_hash = live state_hash for every comparable gate turn (≥ 1)", comparable.length > 0 && miss.length === 0,
    `comparable=${comparable.length} of ${live.length}; mismatched=${miss.map((l) => l.run_id).join(",") || "none"}`);
}

/** 11: Jev transport down: every turn still leaves one verdict row (the §6 join through an outage); the sweep sees it. */
async function caseSkipRate(g) {
  const worker = g.h.makeWorker(async () => { throw new TypeError("fetch failed"); });
  const started = Date.now() - 1000;
  const before = g.m.checkJevSkipRate(g.store, new Date().toISOString()).attempts;
  const n = Math.max(8, before + 2); let ok = 0;
  try {
    for (let k = 0; k < n; k += 1) {
      const run_id = g.h.intake(`-5${k}0${Date.now() % 100000}`, MSG.rule); // one chat each: the gateway rate-limits per chat
      g.triageOnly.add(run_id);
      const claim = g.store.claimRun(run_id, `planner:gate:${run_id}`, 300);
      if (!claim) { check("11 skip rate: claim", false); return; }
      worker.buildOmpTools(claim);
      const out = await worker.triageTurn({ claim, text: MSG.rule, userText: MSG.rule, modality: "text", posture: null, signal: new AbortController().signal });
      const v = g.h.verdict(run_id);
      if (out.kind === "fallthrough" && out.route?.role === "default" && v?.category === null && v.route_outcome === "fallback" && v.skip_reason === "transport" && v.role === "default") ok += 1;
      else show(`11 skip #${k}`, v);
    }
  } finally { await worker.shutdownPlanners(); }
  check(`11 skip rate: ${n} turns → fallthrough on Default, each with one verdict row {category null, fallback, transport}`, ok === n, `ok=${ok}`);
  const now = new Date().toISOString();
  const rate = g.m.checkJevSkipRate(g.store, now, Date.now() - started);
  check(`11 skip rate: ${n} of ${n} attempts failed silently → open`, rate.open && rate.attempts === n && rate.failed === n, JSON.stringify(rate));
  const viol = g.m.detectViolations(g.store, now, process.env).filter((x) => x.kind === "jev_skip_rate");
  check("11 skip rate: the sweep detector reports jev_skip_rate", viol.length === 1 && viol[0].subject === g.m.JEV_INCIDENT_SUBJECT);
}

/** 12a's stubbed Jev: category under the choice bar (lookup 0.5, research 0.3), no rule, a light gear; it reports the probed model so it arms. */
function belowBarJev(m) {
  const rest = 0.2 / (m.CATEGORIES.length - 2);
  const probabilities = Object.fromEntries(m.CATEGORIES.map((c) => [c, c === "lookup" ? 0.5 : c === "research" ? 0.3 : rest]));
  const n = m.CATEGORIES.length;
  const level = { type: "score", score: 0.9, probabilities: { 0: 0.1, 1: 0.9, 2: 0, 3: 0 }, confidence: 0.8 };
  const body = { model: m.model, usage: { input_tokens: 900, output_tokens: 0 }, answers: {
    category: { type: "choice", choice: "lookup", probabilities, confidence: (0.5 - 1 / n) / (1 - 1 / n) },
    sets_rule: { type: "noul", noul: 0.05 }, rule_scope: { type: "choice", choice: "ask", probabilities: { ask: 0.9, research: 0.1 }, confidence: 0.8 },
    breadth: level, reasoning: level, actions: level } };
  return async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * 12a (Decision 14): a forced below-bar turn makes ONE real cascade call (one attempt_group) whose first leg is the Tiny
 * head, answers within CASCADE_TIMEOUT_MS and routes on the pick. Triage only (no planner); it runs last, after case 11,
 * because the stub's answered rows are not real Jev calls. A failed or timed-out pick FAILs: that is the silent
 * degradation this case exists to catch (the turn would still answer, on Default).
 */
async function caseCascade(g) {
  const worker = g.h.makeWorker(belowBarJev(g.m));
  try {
    const run_id = g.h.intake(`-7${Date.now() % 100000}`, MSG.research); g.triageOnly.add(run_id);
    const claim = g.store.claimRun(run_id, `planner:gate:${run_id}`, 300);
    if (!claim) { check("12 cascade: claim", false); return; }
    worker.buildOmpTools(claim);
    const t0 = Date.now();
    const out = await worker.triageTurn({ claim, text: MSG.research, userText: MSG.research, modality: "text", posture: null, signal: new AbortController().signal });
    const elapsed = Date.now() - t0; const v = g.h.verdict(run_id); show("12 cascade", v);
    const legs = g.h.attempts(run_id, "cascade").map((e) => e.payload); const head = g.roles.candidates("tiny")[0];
    const desc = legs.map((l) => `${key(l.provider, l.model)}:${l.outcome}:${l.latency_ms}ms`).join(" ") || "none";
    check("12 cascade: exactly one cascade call, its first leg on the Tiny head", legs.length > 0 && new Set(legs.map((l) => l.attempt_group)).size === 1
      && head !== undefined && key(legs[0].provider, legs[0].model) === key(head.provider, head.model), `legs=${desc} head=${head ? key(head.provider, head.model) : "(none)"}`);
    check("12 cascade: the Tiny leg answered and the pick routed (reason cascade, cascade tiny, one of the pair)",
      legs.some((l) => l.outcome === "ok") && v?.reason === "cascade" && v.cascade === "tiny" && ["lookup", "research"].includes(v.category),
      `reason=${v?.reason} category=${v?.category} cascade=${v?.cascade}`);
    const legMs = legs.reduce((a, l) => a + (l.latency_ms ?? 0), 0);
    check(`12 cascade: answered within CASCADE_TIMEOUT_MS (${g.m.CASCADE_TIMEOUT_MS} ms)`, elapsed <= g.m.CASCADE_TIMEOUT_MS && legMs <= g.m.CASCADE_TIMEOUT_MS,
      `triageTurn ${elapsed} ms, legs ${legMs} ms`);
    check("12 cascade: the triage event names the pair", g.h.events(run_id, "triage")[0]?.payload.cascade_between?.join(",") === "lookup,research");
    check("12 cascade: the returned route names the verdict", out.route?.verdict_id === v?.verdict_id);
  } finally { await worker.shutdownPlanners(); }
}

/** 12b: a real-Jev gate turn that went below the bar on its own: its cascade attempts precede the planner's, no routed_by. */
function checkNaturalCascades(g) {
  const hits = g.runIds.filter((id) => !g.triageOnly.has(id)).filter((id) => g.h.verdict(id)?.cascade === "tiny");
  if (hits.length === 0) {
    inconclusive.push("12b natural cascade: no real-Jev gate turn went below the choice bar (12a forced the path)");
    console.log("INCONCLUSIVE 12b natural cascade — no real-Jev turn went below the bar");
    return;
  }
  for (const id of hits) {
    const all = g.h.attempts(id).map((e) => e.payload); const firstCompose = all.findIndex((a) => a.role === "compose");
    const casc = all.map((a, k) => ({ a, k })).filter((x) => x.a.role === "cascade");
    check(`12b ${id}: cascade attempts precede the planner's and carry no routed_by`,
      casc.length > 0 && casc.every((x) => (firstCompose < 0 || x.k < firstCompose) && x.a.routed_by === undefined), `cascade=${casc.length} firstCompose=${firstCompose}`);
  }
}

/** The candidates a role may legitimately answer on: its own list, then each stepped-up role's (spec §4 step-up). */
function allowedModels(g, role, effort) {
  const out = []; let r = role;
  while (r) { out.push(...g.roles.candidates(r, { effort })); r = g.m.STEP_UP[r]; }
  return out;
}

/**
 * PASS criterion, per planner-lane gate turn: the first compose attempt carries routed_by = verdict_id, and the first
 * answering model is the routed head unless an earlier attempt failed (then it must be a legitimate walk/step-up).
 * This is the silent-degradation check: a pin that never applied leaves the answer on the spawn leg (Default's head).
 */
function checkRoutedJoins(g) {
  let planner = 0;
  for (const run_id of g.runIds) {
    const v = g.h.verdict(run_id);
    if (!v) { check(`join ${run_id}: has a jev_verdicts row`, false); continue; }
    if (v.lane !== "planner") continue;
    const compose = g.h.attempts(run_id, "compose");
    if (compose.length === 0) continue; // a turn that ended in the triage harness only (case 11) has no planner call
    planner += 1;
    const first = compose[0].payload; const okAt = compose.findIndex((e) => e.payload.outcome === "ok");
    check(`join ${run_id}: first compose attempt routed_by = verdict_id`, first.routed_by === v.verdict_id, `routed_by=${first.routed_by} verdict=${v.verdict_id}`);
    if (okAt < 0) { check(`join ${run_id}: the planner answered`, false, "no ok compose attempt"); continue; }
    const answered = key(compose[okAt].payload.provider, compose[okAt].payload.model);
    const allowed = allowedModels(g, v.role, v.effort); const head = allowed[0];
    const headKey = head ? key(head.provider, head.model) : "(none)";
    const ok = okAt === 0 ? answered === headKey : allowed.some((c) => key(c.provider, c.model) === answered);
    check(`join ${run_id}: answered on the routed ${v.role} head (or a logged walk)`, ok, `answered=${answered} head=${headKey} failedBefore=${okAt}`);
    // F15: Default and Thinking share a head, so the pinned effort is what proves the routed pin applied
    if (okAt === 0) check(`join ${run_id}: the answering attempt carries the routed, clamped effort`, compose[0].payload.effort === head?.effort,
      `effort=${compose[0].payload.effort} want=${head?.effort}`);
    check(`join ${run_id}: verdict.model records the answering model`, noEffort(v.model) === answered, `verdict.model=${v.model}`);
  }
  check("join: at least 3 planner turns were checked", planner >= 3, `planner turns=${planner}`);
  const pinFailed = g.runIds.map((id) => g.h.verdict(id)).filter((v) => v?.route_outcome === "pin_failed");
  check("pin_failed = 0 across every gate turn", pinFailed.length === 0, pinFailed.map((v) => v.run_id).join(","));
}

/**
 * F11: an absolute bar (the live DB holds 4 triage events ever, so a 7-day baseline means nothing): at most one silent
 * skip in at least 8 real Jev calls, and the sweep's window over those calls is closed.
 */
function checkSkipAbsolute(g, from, to) {
  const cur = g.store.countJevCalls("triage", from, to, g.m.JEV_NOT_ATTEMPT_REASONS, g.m.JEV_SILENT_SKIP_REASONS);
  check("skip rate: ≥ 8 real Jev calls during the gate, at most 1 failed silently", cur.attempts >= 8 && cur.failed <= 1, `gate ${cur.failed}/${cur.attempts}`);
  check("skip rate: the sweep's window over the real-Jev calls is closed", !g.m.checkJevSkipRate(g.store, to, Date.parse(to) - Date.parse(from)).open);
}

/** F12: once the planners stop, no gate turn that reached the planner keeps a `pending` verdict (every terminal closes it). */
function checkNoPending(g) {
  const open = g.runIds.filter((id) => !g.triageOnly.has(id)).map((id) => g.h.verdict(id)).filter((v) => v?.handler_outcome === "pending");
  check("no planner-path verdict left pending after shutdown", open.length === 0, open.map((v) => v.run_id).join(",") || "none");
}

/** F9: the merge run needs Paco's committed rows to arm category, rule, status and memory in both languages. */
function checkCommittedArming(g) {
  const rows = g.m.calibrationRows(process.env);
  check(`arming: reported model ${g.m.model} has committed calibration rows (else the alias moved: every decision falls through)`,
    g.m.CALIBRATED_ROWS.some((r) => r.model === g.m.model));
  for (const lang of ["zh", "en"]) {
    const a = g.m.treeArmed(lang, g.m.model, rows);
    check(`arming (${lang}): committed CALIBRATED_ROWS arm category, rule, status and memory`, a.category && a.rule && a.status && a.memory, JSON.stringify(a));
  }
}

async function setup(args) {
  const m = await loadModules();
  m.loadHougeEnv();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (HOUGE_ENV_FILE?)");
  const repo = dirname(resolve(envFilePath())); // the LIVE repo: read for lessons/src scans; its DB is only copied
  const live = resolve(args.db ?? join(repo, "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  m.model = await probeReportedModel(m); // before gateEnv: the temp calibration rows key on it
  const root = mkdtempSync("/tmp/hg-tree-"); // short: bridge sockets must fit sun_path (104 bytes)
  gateEnv(m, root, args.realCalibration);
  const dbPath = join(root, "houge.sqlite");
  copyDb(live, dbPath);
  const store = m.RunStore.open(dbPath);
  const cfg = m.resolveOmpConfig(process.env);
  const version = m.checkOmpVersion(cfg); // an unrunnable or silent omp refuses every planner spawn (no pin: Decision 13)
  if (!version.ok) throw new Error(`omp startup check failed (${version.kind}): ${version.reason}`);
  // Codex plan review 4: the whole config, so the read runs under the production child env (envPassthrough included)
  const catalog = await m.readOmpCatalog(cfg);
  if (!catalog || catalog.length === 0) throw new Error(`omp --profile ${cfg.profile} models --json returned no catalog`);
  const roles = new m.RoleResolver({ store, readCatalog: () => m.readOmpCatalog(cfg) });
  if (!(await roles.refreshCatalog())) throw new Error("RoleResolver.refreshCatalog failed against the real omp");
  const h = harness(m, store, repo, root, roles);
  const g = { m, store, h, root, dbPath, roles, chat: `-1000${Date.now() % 100000}`, worker: h.makeWorker(), runIds: [], triageOnly: new Set(),
    strict: args.realCalibration };
  const intake = h.intake; h.intake = (chat, text, replyTo) => { const id = intake(chat, text, replyTo); g.runIds.push(id); return id; };
  return { g, catalog };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { g, catalog } = await setup(args);
  const now = () => new Date().toISOString();
  console.log(`jev tree live gate — copy ${g.dbPath}, reported model ${g.m.model}, calibration ${args.realCalibration ? "committed CALIBRATED_ROWS (merge gate)" : "temp file"}, catalog ${catalog.length} models\n`);
  try {
    if (g.strict) checkCommittedArming(g);
    caseRoleHeads(g, catalog); caseRoleRules(g, catalog); await caseRolesTick(g);
    const from = now();
    for (const c of [caseMemory, caseStatus, caseAck, caseOkAfterProposal, caseQuote, caseRuleOnLookup, caseCorrection, caseOverflow, caseJevProbes]) await c(g);
    await g.worker.shutdownPlanners();
    const to = now();
    checkRoutedJoins(g);
    checkNaturalCascades(g);
    checkNoPending(g);
    checkSkipAbsolute(g, from, to);
    await caseParity(g);
    await caseSkipRate(g);
    await caseCascade(g); // last: its stubbed Jev rows are not real calls, so they stay out of both skip-rate windows
    check("skip rate: no jev_skip_rate incident open at the end", !g.store.listOpenIncidents().some((i) => i.kind === "jev_skip_rate"));
  } finally { await g.worker.shutdownPlanners(); g.store.close(); }
  if (inconclusive.length > 0) console.log(`\nINCONCLUSIVE (Jev's call, not a code fault):\n  - ${inconclusive.join("\n  - ")}`);
  console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
  if (args.keep || failures.length > 0) console.log(`temp dir kept: ${g.root}`); else rmSync(g.root, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
