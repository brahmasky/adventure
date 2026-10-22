#!/usr/bin/env node
// Live gate — decision ladder stage 1 (spec 2026-10-12 §6.2 P6, §13 row 1).
//
//   Run from the feature worktree, after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-decisions-parity.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/p6-base/dist [--db <path>] [--limit 200] [--keep]
//
// P6 dual run: for each of the last Telegram user texts in chat_turns, the same triage input — the text, its stored
// previous turns (within the context window, minus a 10-minute margin) seeded into a fresh chat at the same offsets, one
// fixed clock for both builds — goes through CoreWorker.triageTurn in the pre-stage-1 dist (copy A) and in this build's
// dist (copy B). Jev record/replay (controller ruling 2026-10-12, after the probe showed Jev drifts run to run on a
// byte-identical request): the old build calls the real Jev through a recording `ompOptions.jevFetch`; the new build gets a
// replaying `jevFetch` that serves the recorded responses (or recorded throws) strictly in recorded call order, each only
// for the identical request body. The gate asks "does stage-1 code make the same decisions from the same Jev answers"; Jev's own drift is not its
// subject. A request the old build never sent (other body, extra call) or a recorded call the new build never made is a
// MISMATCH. Replay halves the TypeSafe calls (≈ 200 for the full run, plus retries), under Paco's approval below.
// Admission: a turn one build admits and the other refuses is a MISMATCH (each side's refusal is printed); only a turn both
// builds refuse identically is skipped, and those are counted. Lanes, planner, Telegram and the outbox are stubbed: the
// cascade stub picks the first candidate, every other seat fails, search and fetch fail. Later jev_verdicts mutations are
// covered by the Task 2 pin and Task 8b tests, not here.
// Compared projection: the whole returned triage outcome (kind, route presence, role, effort, the inform note, a lane
// reply's text and buttons, the quote line), every jev_decisions and jev_verdicts column the OLD schema has, and the
// triage event payload, except ids, created/updated_at and latency_ms. The outcome's route.verdict_id and the triage
// event's verdict_id are compared as links to the run's own persisted verdict row; uuids elsewhere in the outcome (a quote's
// turn id, button data) are masked. state_built_at is compared as its offset from the shared clock (both builds read it
// from ompOptions.jevNow). thread_cut_at is compared by presence only: both builds stamp it with the wall clock when
// buildOmpTools claims the turn (core-worker.ts `new Date()`), not with the shared clock, so its value differs by design.
// Classification (codex B2, re-review #2): structure first — the outcome kind, question order, statuses, skip reasons,
// verdict presence and the triage link. With replay both sides see the same Jev answers, so any replay miss, structural
// difference, differing Jev answer or differing projection is a MISMATCH. An old-side Jev failure is replayed as the same
// failure; such a pair is compared structurally (a difference is a mismatch) and, when identical, retried once with a
// fresh chat and clock; still both-failed and identical, it is inconclusive — never a deterministic pair, never a pass.
// PASS: ≥ 190 deterministic pairs before 200 decided (candidates over-fetched by 30), 0 mismatches; the coverage floor
// (every answered row reports a calibrated model; ≥ 100 armed turn.handler verdicts; the cascade rung ran); every stage-1
// verdict and Jev row links its turn.handler decision; /status's decision counts (decisionStatusLines) show turn.handler;
// the digest (2b-ii: Improvements today / Proposals waiting / Unsure / Watch) is either no message (an empty day) or the header plus
// only those four section headers, renders through the Telegram adapter with every button inside Telegram's 64 bytes, and
// the tick sends once, each ✅ n / ❌ n pair is exactly `dec:rv:<offered id>:ok` / `:bad` (follow-up 1: the review taps are back), the button LABELLED ❌ writes one
// review_bad outcome, the one labelled ✅ then writes nothing, and a stranger's tap is refused. Exit: 0 PASS · 1 FAIL · 2 setup error · 3 INCONCLUSIVE. Never opens the live DB
// for writing: it is opened read-only, only for `VACUUM INTO` copies under the gate's temp root.
// Egress (senior S8): CoreWorker is built without a broker, so the replayed Telegram texts and their stored context reach
// TypeSafe redacted by shape only (sanitizeJevText), not by known secret values — the jev-tree gate's class. Approved by
// Paco 2026-10-12 ("Yes, 200 messages"): replay the last 200 Telegram messages through Jev with shape-only redaction.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

import { DEFAULT_OLD_BASE, verifyOldDist } from "./old-dist-provenance.mjs";

const NEW_DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const inconclusive = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
/** A required check that could not run: never a PASS (exit 3 unless something failed). */
const cannotRun = (name, why) => { console.log(`INCONCLUSIVE ${name} — ${why}`); inconclusive.push(`${name}: ${why}`); };
const SILENT = new Set(["timeout", "transport", "parse", "error", "rate_limited", "overloaded", "auth", "no_key", "fused", "malformed_question"]);
const ID_COLS = new Set(["decision_id", "run_id", "verdict_id", "ladder_decision_id", "created_at", "updated_at", "latency_ms"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** The live-DB copies' temp root: removed on every exit path unless --keep (they hold Paco's messages). */
const temp = { root: null, keep: false };
function cleanup() {
  if (!temp.root) return;
  if (temp.keep) console.log(`temp dir kept (--keep; it holds copies of the live DB, delete it when done): ${temp.root}`);
  else rmSync(temp.root, { recursive: true, force: true });
  temp.root = null;
}
const MARGIN_MS = 10 * 60_000;
const PACE_MS = 250;
const OVERFETCH = 30;
const MIN_DETERMINISTIC = 190;
const MIN_ARMED = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { oldDist: null, oldBase: DEFAULT_OLD_BASE, db: null, limit: 200, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--old-dist") a.oldDist = resolve(argv[++i]);
    else if (argv[i] === "--old-base") a.oldBase = argv[++i];
    else if (argv[i] === "--db") a.db = resolve(argv[++i]);
    else if (argv[i] === "--limit") {
      a.limit = Number(argv[++i]);
      if (!Number.isInteger(a.limit) || a.limit <= 0) throw new Error(`--limit must be a positive integer (got ${argv[i]})`);
    }
    else if (argv[i] === "--keep") a.keep = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!NEW_DIST.includes("/.worktrees/")) throw new Error(`run from the feature worktree (this dist is ${NEW_DIST}); never build in the main checkout`);
  if (!a.oldDist || !existsSync(join(a.oldDist, "core/core-worker.js"))) throw new Error("--old-dist <pre-stage-1 dist> is required (see the header)");
  const prov = verifyOldDist(a.oldDist, NEW_DIST, a.oldBase);
  console.log(`old build: worktree HEAD ${prov.head.slice(0, 12)}, core-worker.js ${prov.oldHash} (new ${prov.newHash})`);
  return a;
}

async function loadBuild(dist, extra = []) {
  const paths = ["core/core-worker.js", "gateway/gateway.js", "run/run-store.js", "domain/types.js", "capabilities/intent.js", ...extra];
  const m = Object.assign({}, ...(await Promise.all(paths.map((p) => import(join(dist, p))))));
  for (const n of ["CoreWorker", "Gateway", "RunStore", "buildTypedTaskEvent", "resolveChatContextTurns", "chatContextSince"]) {
    if (m[n] === undefined) throw new Error(`${dist} lacks ${n}`);
  }
  return m;
}

/** A consistent snapshot through a read-only connection (WAL-safe; the daemon keeps running). */
function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

function guardCopy(path, root, live) {
  if (resolve(path) === live || !resolve(path).startsWith(`${resolve(root)}/`)) throw new Error(`refusing to write outside the gate's temp copy: ${path}`);
}

/**
 * No Telegram, every disarm flag off, markers in the temp root, the tree armed on the committed rows (no calibration
 * file), the answer and lookup lanes on for coverage (both builds see the same env; the live .env is untouched).
 */
function gateEnv(m, root) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID", "HOUGE_JEV_CALIBRATION_FILE", "HOUGE_JEV_GATE", "HOUGE_JEV_LANES_OFF"]) delete process.env[k];
  for (const f of m.DISARM_FLAGS) process.env[f] = "false";
  Object.assign(process.env, {
    HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed")
  });
}

/** The last N (+ over-fetch) Telegram user texts, oldest first, each with its stored previous turns inside the context window (gaps kept). */
function pickTexts(m, basePath, n) {
  const db = new DatabaseSync(basePath, { readOnly: true });
  try {
    const texts = db.prepare(`SELECT t.chat_id, t.text, t.created_at FROM chat_turns t JOIN runs r ON r.run_id = t.run_id
      WHERE t.role = 'user' AND r.source = 'telegram' ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`).all(n).reverse();
    const ctx = m.resolveChatContextTurns(process.env);
    const prior = db.prepare(`SELECT role, text, intent, created_at FROM chat_turns WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?`);
    return texts.map((t, k) => {
      const at = Date.parse(t.created_at);
      const windowMs = at - Date.parse(m.chatContextSince(process.env, new Date(at)));
      const turns = prior.all(t.chat_id, t.created_at, ctx).reverse().map((p) => ({ role: p.role, text: p.text, intent: p.intent, gapMs: at - Date.parse(p.created_at) }))
        .filter((p) => p.gapMs < windowMs - MARGIN_MS);
      return { k, text: t.text, prior: turns };
    });
  } finally { db.close(); }
}

const firstCandidate = (system) => /nothing else: ([a-z_]+), ([a-z_]+)\./.exec(String(system ?? ""))?.[1] ?? "";
/** The cascade picks the first candidate (deterministic, so the model rung runs); every other seat fails the same way on both sides. */
const stubLlm = async (input) => (/exactly one of these two words/.test(String(input.system ?? ""))
  ? { ok: true, output: { answer: firstCandidate(input.system) } } : { ok: false, error: "stubbed in the parity gate" });
const stubTool = async () => ({ ok: false, error: "stubbed in the parity gate" });

/**
 * The per-attempt Jev tape: the old side records each real call (status, retry-after, raw body; or the throw's name), the
 * new side replays the entry whose request body hash matches, first unused first. A miss throws as a transport error and
 * is counted: the new build asked Jev something the old build did not.
 */
function makeTape() {
  const tape = { entries: [], misses: 0 };
  const keyOf = (url, init) => createHash("sha256").update(`${String(url)}\n${String(init?.body ?? "")}`).digest("hex");
  tape.record = async (url, init) => {
    const entry = { key: keyOf(url, init), used: false };
    tape.entries.push(entry);
    try {
      const res = await fetch(url, init);
      Object.assign(entry, { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.text() });
    } catch (e) { entry.thrown = e instanceof Error ? e.name : "Error"; throw e; }
    return replayed(entry);
  };
  tape.replay = async (url, init) => {
    const entry = tape.entries.find((x) => !x.used); // strictly the next recorded call; its request must be identical
    if (!entry || entry.key !== keyOf(url, init)) { tape.misses += 1; throw new Error("parity gate: no recorded Jev response for this request"); }
    entry.used = true;
    return replayed(entry);
  };
  return tape;
}

function replayed(entry) {
  if (entry.thrown) { const e = new Error(`replayed ${entry.thrown}`); e.name = entry.thrown; throw e; }
  return new Response(entry.body, { status: entry.status, headers: entry.retryAfter ? { "retry-after": entry.retryAfter } : {} });
}

function makeSide(m, dbPath, dist, root, name, clock, jevFetch) {
  const store = m.RunStore.open(dbPath);
  const dir = join(root, name); mkdirSync(join(dir, "project"), { recursive: true });
  const worker = new m.CoreWorker(store, join(dir, "project"), stubLlm, stubTool, undefined, undefined, stubTool, undefined, undefined, async () => null,
    undefined, undefined, { dataDir: dir, distDir: dist, jevNow: () => new Date(clock.t), jevFetch });
  return { m, store, worker, name, dir };
}

/** Seeds the previous turns into a fresh chat (per attempt) at the same offsets from the shared clock, then admits and claims the turn. */
function admit(side, item, clock, attempt) {
  const chat = `-100${7_000_000 + item.k * 10 + attempt}`; // numeric like a real Telegram chat: the lanes refuse anything else
  for (const p of item.prior) {
    side.store.recordChatTurn({ chat_id: chat, run_id: `run_p6seed_${item.k}_${attempt}`, role: p.role, text: p.text, ...(p.intent ? { intent: p.intent } : {}),
      created_at: new Date(clock.t - p.gapMs).toISOString() });
  }
  const upd = 900_000 + item.k * 10 + attempt;
  const r = new side.m.Gateway(side.store, undefined, undefined, undefined, undefined, { dataDir: side.dir }).intake(side.m.buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: item.text, requested_by: { kind: "user", id: "p6" }, notify: { kind: "telegram", chat_id: chat },
    idempotency_key: `telegram:${upd}:${item.k}`, source_reference: `telegram:update:${upd}:message:${item.k}`, metadata: { telegram_update_id: upd, telegram_message_id: item.k } }));
  if (!r.ok || r.status !== "created") return { refused: JSON.stringify({ ...r, run_id: undefined }) };
  const claim = side.store.claimRun(r.run_id, "p6", 120);
  side.worker.buildOmpTools(claim, chat);
  return { run_id: r.run_id, input: { claim, text: item.text, userText: item.text, modality: "text", posture: null, signal: new AbortController().signal } };
}

/** Clock columns: state_built_at as an offset from the shared clock, thread_cut_at by presence (see the header). */
function clockCol(c, value, clockT) {
  if (value === null || value === undefined) return null;
  return c === "state_built_at" ? Date.parse(value) - clockT : "<set>";
}
const pick = (cols, clockT) => (row) => Object.fromEntries(cols.filter((c) => !ID_COLS.has(c))
  .map((c) => [c, c === "state_built_at" || c === "thread_cut_at" ? clockCol(c, row[c], clockT) : row[c]]));
const linkOf = (id, v) => (id === null || id === undefined ? null : v && id === v.verdict_id ? "<own verdict>" : "<other>");

/** The whole returned outcome; route.verdict_id as a link to the run's own verdict, uuids elsewhere masked. */
function outcomeOf(out, v) {
  const linked = out.route ? { ...out, route: { ...out.route, verdict_id: linkOf(out.route.verdict_id, v) } } : out;
  return JSON.parse(JSON.stringify(linked).replace(UUID, "<uuid>"));
}

/** One side's projection over the OLD schema's columns; the triage event's verdict_id becomes a link check. */
function project(side, run_id, cols, out, clockT) {
  const v = side.store.getJevVerdictForRun(run_id);
  const triage = side.store.getLedgerEvents(run_id).filter((e) => e.event_type === "triage")
    .map((e) => ({ ...e.payload, verdict_id: linkOf(e.payload.verdict_id, v) }));
  return { out: outcomeOf(out, v), jd: side.store.listJevDecisions(run_id).map(pick(cols.jd, clockT)), v: v ? pick(cols.jv, clockT)(v) : null, triage };
}

function columnsOf(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const of = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    return { jd: of("jev_decisions"), jv: of("jev_verdicts") };
  } finally { db.close(); }
}

const shape = (p) => JSON.stringify({ out: [p.out.kind, p.out.route !== undefined], jd: p.jd.map((r) => [r.question_id, r.status, r.skip_reason]), v: p.v !== null, triage: p.triage.map((t) => [t.status, t.verdict_id]) });
const failedJev = (p) => p.jd.some((r) => r.status === "skipped" && SILENT.has(r.skip_reason));

/** match · mismatch · inconclusive — replay first, then structure (spec §6.2, codex B2). `replayOk`: no miss, no unused entry. */
function classify(a, b, replayOk) {
  if (!replayOk || shape(a) !== shape(b)) return "mismatch";
  if (failedJev(a)) return "inconclusive"; // structures equal, so both sides failed the same (replayed) way
  // exact: the same recorded answers (answers_json, model_reported) must land as the same rows and the same outcome
  return JSON.stringify(a) === JSON.stringify(b) ? "match" : "mismatch";
}

/** Stage 1 only: one turn.handler decision per turn, and the verdict and every Jev row link to it. */
function linkOk(side, run_id) {
  const d = side.store.listDecisionsForRun(run_id).filter((x) => x.entry_id === "turn.handler");
  if (d.length !== 1) return false;
  const v = side.store.getJevVerdictForRun(run_id);
  const jd = side.store.listJevDecisions(run_id);
  return v?.decision_id === d[0].decision_id && jd.length > 0 && jd.every((r) => r.ladder_decision_id === d[0].decision_id);
}

/**
 * One attempt: old build on real Jev (recorded), then the new build on the replay, paced after both. `bothRefused` when the
 * two builds refuse the turn identically; `oneRefused` (a mismatch) when they disagree about admitting it.
 */
async function triagePair(g, item, attempt) {
  g.clock.t = Date.now();
  g.tape = makeTape();
  const a = admit(g.oldSide, item, g.clock, attempt); const b = admit(g.newSide, item, g.clock, attempt);
  if (a.refused !== undefined || b.refused !== undefined) {
    const refusal = { old: a.refused ?? "admitted", new: b.refused ?? "admitted" };
    return refusal.old === refusal.new ? { bothRefused: refusal } : { oneRefused: refusal };
  }
  const outA = await g.oldSide.worker.triageTurn(a.input);
  const outB = await g.newSide.worker.triageTurn(b.input);
  await sleep(PACE_MS);
  const replay = { calls: g.tape.entries.length, misses: g.tape.misses, unused: g.tape.entries.filter((x) => !x.used).length };
  return { a: project(g.oldSide, a.run_id, g.cols, outA, g.clock.t), b: project(g.newSide, b.run_id, g.cols, outB, g.clock.t),
    runB: b.run_id, replay, replayOk: replay.misses === 0 && replay.unused === 0 };
}

/**
 * A structurally identical, both-failed (replayed failure) pair is retried once with a fresh Jev call (senior W10); still
 * both-failed, it stays inconclusive. Every other difference is a mismatch at once: replay leaves Jev nothing to blame.
 */
async function runPair(g, item) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pair = await triagePair(g, item, attempt);
    if (pair.bothRefused) return { c: "skipped" };
    if (pair.oneRefused) return { c: "mismatch", a: { admission: pair.oneRefused.old }, b: { admission: pair.oneRefused.new }, replay: null };
    const c = classify(pair.a, pair.b, pair.replayOk);
    if (c === "inconclusive" && attempt === 0) { g.retries += 1; continue; }
    return { c, ...pair };
  }
  throw new Error("unreachable: the second attempt always returns");
}

async function dualRun(g, items, limit) {
  const t = { match: 0, mismatch: [], inconclusive: 0, skipped: 0, links: 0, completed: 0, newRuns: [] };
  const decided = () => t.match + t.mismatch.length;
  for (const item of items) {
    if (decided() >= limit) break;
    const r = await runPair(g, item);
    if (r.c === "skipped") { t.skipped += 1; continue; }
    t.completed += 1;
    if (r.c === "mismatch") t.mismatch.push({ k: item.k, old: r.a, new: r.b, replay: r.replay }); else t[r.c] += 1;
    if (!r.runB) continue; // an admission mismatch: no triaged run to link or tally
    t.newRuns.push(r.runB);
    if (!linkOk(g.newSide, r.runB)) t.links += 1;
  }
  return t;
}

function reportDualRun(t, retries) {
  const det = t.match + t.mismatch.length;
  console.log(`  pairs ${t.completed}: match ${t.match} · mismatch ${t.mismatch.length} · inconclusive ${t.inconclusive} · retried ${retries} · refused identically by both builds (skipped) ${t.skipped}`);
  for (const m of t.mismatch.slice(0, 5)) console.log(`  mismatch #${m.k} (${m.replay ? `Jev replay ${JSON.stringify(m.replay)}` : "admission"}):\n    old ${JSON.stringify(m.old)}\n    new ${JSON.stringify(m.new)}`);
  // senior re-review S3: a shortfall that the inconclusive (both-failed) pairs explain is infrastructure, not code
  if (det < MIN_DETERMINISTIC && MIN_DETERMINISTIC - det <= t.inconclusive) cannotRun(`P6: at least ${MIN_DETERMINISTIC} deterministic pairs`, `${det}; ${t.inconclusive} pair(s) lost to Jev failures`);
  else check(`P6: at least ${MIN_DETERMINISTIC} deterministic pairs`, det >= MIN_DETERMINISTIC, `${det}; inconclusive (both sides failed Jev) ${t.inconclusive}`);
  check("P6: 0 mismatches among them", t.mismatch.length === 0, `${t.mismatch.length}`);
  check("links: every stage-1 verdict and Jev row links its turn.handler decision", t.links === 0, `${t.links} unlinked`);
}

/** The new side's turn.handler rows, tallied (senior W9): a silently narrowed corpus (all uncalibrated, no cascade) must not pass. */
function coverage(g, runs) {
  const rows = runs.flatMap((r) => g.newSide.store.listDecisionsForRun(r).filter((d) => d.entry_id === "turn.handler"));
  const tally = {};
  for (const d of rows) tally[`${d.rung}:${d.reason_code}`] = (tally[`${d.rung}:${d.reason_code}`] ?? 0) + 1;
  const calibrated = new Set(g.newMods.CALIBRATED_ROWS.map((r) => r.model));
  const reported = [...new Set(runs.flatMap((r) => g.newSide.store.listJevDecisions(r).filter((x) => x.status === "answered").map((x) => x.model_reported)))];
  return {
    tally, reported, uncalibrated: reported.filter((m) => !calibrated.has(m)),
    armed: rows.filter((d) => (d.rung === "system_one" || d.rung === "model") && d.reason_code !== "uncalibrated").length,
    model: rows.filter((d) => d.rung === "model" || d.fallback_rung === "model").length
  };
}

function reportCoverage(c) {
  console.log(`  turn.handler rows by rung:reason — ${Object.entries(c.tally).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  check("coverage: every answered Jev row reports a model the committed rows arm", c.reported.length > 0 && c.uncalibrated.length === 0, `reported ${c.reported.join(", ") || "none"}`);
  check(`coverage: at least ${MIN_ARMED} turn.handler verdicts from an armed tree`, c.armed >= MIN_ARMED, `${c.armed}`);
  if (c.model === 0) cannotRun("coverage: the cascade (model) rung ran", "no text fell below the choice bar");
  else check("coverage: the cascade (model) rung ran", true, `${c.model}`);
}

/** Copy B only, before it is opened: the digest latch and the day's digest outbox row ride along once the daemon runs stage 1. */
function clearDigestLatch(pathB, root, live) {
  guardCopy(pathB, root, live);
  const db = new DatabaseSync(pathB);
  try {
    const has = db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'decision_digests'`).get();
    if (has) console.log(`  cleared ${db.prepare(`DELETE FROM decision_digests`).run().changes} digest latch row(s) from copy B`);
    console.log(`  cleared ${db.prepare(`DELETE FROM notification_outbox WHERE idempotency_key LIKE 'decision_digest:%'`).run().changes} digest outbox row(s) from copy B`);
  } finally { db.close(); }
}

function claimDigest(store) {
  let note = null;
  for (let n = store.claimNextNotification("p6", 30); n; n = store.claimNextNotification("p6", 30)) if (n.idempotency_key.startsWith("decision_digest:")) note = n;
  return note;
}

/**
 * The ❌ tap is under test, not Jev's p distribution (senior B2, codex B3): when the dual run left no unsure verdict, the
 * newest applied System One turn.handler judgement (reason `routed`, inside the digest's judgement allowlist) of this
 * run is set to p 0.6 (the choice bar, inside [bar, bar + UNSURE_BAND)) on copy B only, and the output says so. Returns the
 * chat of the run that owns the judgement: the digest offers a decision only to its own chat (follow-up 1).
 */
function ensureUnsure(g, runs) {
  const mine = (d) => d.entry_id === "turn.handler" && d.rung === "system_one" && d.armed_mode === "on" && d.reason_code === "routed";
  const all = runs.flatMap((r) => g.newSide.store.listDecisionsForRun(r)).filter(mine);
  const bar = g.newMods.barOf(g.newMods.REGISTRY.find((e) => e.id === "turn.handler"));
  const near = all.filter((d) => d.p !== null && bar !== undefined && d.p >= bar && d.p < bar + g.newMods.UNSURE_BAND).at(-1);
  const target = near ?? all.at(-1);
  if (!target) return null;
  if (!near) {
    guardCopy(g.pathB, g.root, g.live);
    const db = new DatabaseSync(g.pathB);
    try { db.prepare(`UPDATE decisions SET p = 0.6 WHERE decision_id = ?`).run(target.decision_id); } finally { db.close(); }
    console.log(`  seeded: ${target.decision_id} set to p 0.6 on copy B so the digest offers one decision`);
  }
  return g.newSide.store.chatIdOfRun(target.run_id);
}

/**
 * Spec §13 row 1 "the digest renders": the queued payload through TelegramNotificationAdapter with a stub transport (codex
 * S7); every button inside 64 bytes. The review rows must be exactly, label AND callback together, `✅ <n>` ↔
 * `dec:rv:<offered id>:ok` and `❌ <n>` ↔ `dec:rv:<offered id>:bad`, in offer order (codex #8): swapped labels fail.
 */
async function checkRender(g, note, digest) {
  const sent = [];
  const adapter = new g.newMods.TelegramNotificationAdapter({ sendMessage: async (input) => { sent.push(input); return { message_id: 1 }; } });
  await adapter.send(note);
  const rows = sent[0]?.reply_markup?.inline_keyboard ?? [];
  check("digest render: HTML through the rich renderer", sent.length === 1 && sent[0].parse_mode === "HTML" && sent[0].text.includes("Decisions"), sent[0]?.text.split("\n")[0] ?? "nothing sent");
  const data = rows.flat().map((b) => b.callback_data ?? "");
  check("digest render: every button's callback_data is present and within 64 bytes", data.every((d) => d.length > 0 && Buffer.byteLength(d, "utf8") <= 64), `${data.length} button(s)`);
  const reviewRows = rows.filter((r) => (r[0]?.callback_data ?? "").startsWith("dec:rv:")).map((r) => r.map((b) => ({ text: b.text, callback_data: b.callback_data })));
  const want = digest.offered.decision_ids.map((id, k) => [{ text: `✅ ${k + 1}`, callback_data: `dec:rv:${id}:ok` }, { text: `❌ ${k + 1}`, callback_data: `dec:rv:${id}:bad` }]);
  check("digest render: each review row is exactly ✅ <n> → dec:rv:<offered id>:ok and ❌ <n> → dec:rv:<offered id>:bad", JSON.stringify(reviewRows) === JSON.stringify(want), `${reviewRows.length} row(s), ${want.length} offered`);
  return reviewRows;
}

const SECTION_HEADERS = new Set(["**Improvements today**", "**Proposals waiting**", "**Unsure** (✅ right · ❌ wrong)", "**Watch (7 d)**"]);
/** Contract: no message, or the dated header and only the four section headers. */
function digestShapeOk(digest) {
  if (digest === null) return true;
  const lines = digest.text.split("\n");
  return /^🪜 \*\*Decisions — \d{4}-\d{2}-\d{2}\*\*$/.test(lines[0]) && lines.slice(1).filter((l) => l.startsWith("**")).every((l) => SECTION_HEADERS.has(l));
}

async function checkDigest(g, chat) {
  const now = new Date().toISOString();
  const status = g.newMods.decisionStatusLines(g.newSide.store, now);
  check("/status decisions: the counts show turn.handler", status.some((l) => l.startsWith("· turn.handler ")), status[1] ?? "no decision section");
  const digest = g.newMods.buildDecisionDigest(g.newSide.store, now, process.env, chat);
  check("digest: no message on an empty day, else the header and only the four sections", digestShapeOk(digest), digest ? digest.text.split("\n")[0] : "null (empty day)");
  const env = { ...process.env, HOUGE_DECISION_DIGEST_AT: "00:00" };
  const first = g.newMods.runDecisionDigestTick({ store: g.newSide.store, chatId: chat, now, env });
  const again = g.newMods.runDecisionDigestTick({ store: g.newSide.store, chatId: chat, now, env });
  const note = claimDigest(g.newSide.store);
  if (!first.ran) {
    // ruling 21: only a young (< 30 min) running or stopped improve tick on copy B may defer the digest
    const date = g.newMods.formatInstantInZone(now, g.newMods.resolveDisplayZone(process.env)).slice(0, 10);
    const tick = g.newSide.store.getImproveTick(date);
    check("digest tick: deferred only by today's young running/stopped improve tick", again.ran === false && tick !== undefined && (tick.result === "running" || tick.result === "stopped") && Date.parse(now) - Date.parse(tick.started_at) < 30 * 60_000, JSON.stringify({ first, again, tick: tick?.result }));
    return cannotRun("digest render", "the digest was deferred, no message to render");
  }
  check("digest tick: sends once per local date", again.ran === false && first.sent === (digest !== null), JSON.stringify({ first, again }));
  if (digest === null) return cannotRun("digest render", "an empty day: no digest message to render");
  check("digest tick: one outbox message to the operator chat", note !== null && note.payload.text === digest.text, note ? note.idempotency_key : "none");
  const rows = note ? await checkRender(g, note, digest) : [];
  return { digest, rows };
}

function tapUpdate(m, from, data, id) {
  const allowlist = { users: [{ telegram_user_id: 111, identity_id: "p6" }], chats: [{ telegram_chat_id: 222, label: "p6", allowed_identity_ids: ["p6"] }] };
  return m.normalizeTelegramUpdate({ update_id: 7_000_000 + id, callback_query: { id: `p6cb${id}`, from: { id: from }, message: { message_id: 1, chat: { id: 222 } }, data } }, allowlist);
}

/**
 * The RENDERED buttons go into the gateway, picked by their visible label (codex #8): the button Paco sees as ❌ must
 * write review_bad, the one he sees as ✅ must then write nothing.
 */
function checkTap(g, shown) {
  const offered = shown?.digest?.offered.decision_ids ?? [];
  if (offered.length === 0) { cannotRun("❌ tap", "nothing was offered even after seeding (copy B has no applied jev-rung turn.handler row)"); return; }
  const row = shown.rows[0] ?? [];
  const bad = row.find((b) => b.text.startsWith("❌"))?.callback_data;
  const ok = row.find((b) => b.text.startsWith("✅"))?.callback_data;
  if (!ok || !bad) { cannotRun("❌ tap", "the digest rendered no ✅/❌ pair to tap"); return; }
  const id = offered[0];
  const gw = new g.newMods.Gateway(g.newSide.store);
  const first = tapUpdate(g.newMods, 111, bad, 1);
  if (first.ok) gw.intake(first.event);
  const second = tapUpdate(g.newMods, 111, ok, 2);
  if (second.ok) gw.intake(second.event);
  const outcomes = g.newSide.store.listDecisionOutcomes(id).map((o) => `${o.signal}:${o.value}:${o.source}`);
  check("❌ tap: writes exactly one review_bad outcome; the second tap writes nothing", outcomes.length === 1 && outcomes[0] === "review_bad:turn.handler:paco", outcomes.join(",") || "none");
  const stranger = tapUpdate(g.newMods, 999, bad, 3);
  if (stranger.ok) gw.intake(stranger.event);
  const after = g.newSide.store.listDecisionOutcomes(id).length;
  check("❌ tap: a stranger's tap is refused by the allowlist and writes nothing", stranger.ok === false && after === outcomes.length, `outcomes ${outcomes.length} → ${after}`);
}


async function setup(args) {
  const newMods = await loadBuild(NEW_DIST, ["config/load-env.js", "config/disarm-posture.js", "decisions/digest.js", "decisions/registry.js", "decisions/status-view.js", "run/schedule-spec.js", "triggers/telegram-trigger-adapter.js",
    "jev/calibration.js", "notifications/telegram-notification-adapter.js"]);
  newMods.loadHougeEnv();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (HOUGE_ENV_FILE?)");
  const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env")));
  const live = resolve(args.db ?? join(repo, "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  const root = mkdtempSync("/tmp/hg-p6-");
  temp.root = root; // from here on every exit path removes it (cleanup)
  gateEnv(newMods, root);
  const base = join(root, "base.sqlite"); const pathA = join(root, "a.sqlite"); const pathB = join(root, "b.sqlite");
  for (const p of [base, pathA, pathB]) guardCopy(p, root, live); // before any write
  copyDb(live, base); copyDb(base, pathA); copyDb(base, pathB); // one frozen snapshot, two copies
  clearDigestLatch(pathB, root, live);
  const oldMods = await loadBuild(args.oldDist);
  const clock = { t: Date.now() };
  const cols = columnsOf(pathA); // the OLD schema: stage 1's new columns are checked as links, not compared
  const g = { root, live, pathB, clock, cols, newMods, retries: 0,
    tape: makeTape() };
  g.oldSide = makeSide(oldMods, pathA, args.oldDist, root, "old", clock, (url, init) => g.tape.record(url, init));
  g.newSide = makeSide(newMods, pathB, NEW_DIST, root, "new", clock, (url, init) => g.tape.replay(url, init));
  return { g, items: pickTexts(newMods, base, args.limit + OVERFETCH) };
}

function verdict() {
  if (inconclusive.length > 0) console.log(`\nINCONCLUSIVE:\n  - ${inconclusive.join("\n  - ")}`);
  const status = failures.length > 0 ? "FAIL" : inconclusive.length > 0 ? "INCONCLUSIVE" : "PASS";
  console.log(status === "FAIL" ? `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}` : `\nLIVE GATE: ${status}`);
  return status === "PASS" ? 0 : status === "FAIL" ? 1 : 3;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  temp.keep = args.keep;
  const { g, items } = await setup(args);
  console.log(`decision ladder parity gate — ${items.length} candidate texts for ${args.limit} decided pairs, copies under ${g.root}\n`);
  try {
    const t = await dualRun(g, items, args.limit);
    reportDualRun(t, g.retries);
    reportCoverage(coverage(g, t.newRuns));
    const chat = ensureUnsure(g, t.newRuns) ?? "p6op";
    checkTap(g, await checkDigest(g, chat));
  } finally { g.oldSide.store.close(); g.newSide.store.close(); }
  return verdict();
}

process.on("SIGINT", () => { cleanup(); process.exit(130); });
main().then((c) => { cleanup(); process.exit(c); },
  (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); cleanup(); process.exit(2); });
