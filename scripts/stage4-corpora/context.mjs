// Slice R5 differential, context corpus (spec 2026-11-02 R5 §6). Pair: r5 (the merge-base build 9c23f084) -> new. Every item drives the dist's own
// PlannerSupervisor (scripts/stage4-supervisor-fixture.mjs) on a fresh temp-file store, under a pinned env (no tombstone in the cwd, no chat id for a
// recorder alert) and a counting clock. The new side gets a counting recorder over the store recorder (it reaches the turn context too); the old build
// has no `recorder` dep. Compared: the child's ORDERED call log (full prompt text, steers, set_model), the sink's done/failed/incidents (worker ids
// scrubbed), the system prompt file's bytes at each spawn, and a whole-DB dump with the R5 decision rows removed (clocks relabelled by order, ids scrubbed).
// REQUIRED on the new side: the exact R5 rows [entry, rung, verdict, reason, run, null], exact per-entry recorder call counts (and, where the spec names
// it, their order), and exact behaviour facts (so a scenario that silently stopped reaching its branch fails too). The old build must hold no R5 row.
// No item intakes more than 5 runs per actor (the gateway admits 5 per actor per minute; seedLaneRows' answer run is under its own actor).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DISTS, R5_IDS, NEW_ROW_IDS, canon, compare, dumpDb, mkStore, mkTemp, regularTables, extraDropFilter, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { NOW, withCountingClock, withPinnedEnv } from "../stage4-intake-fixture.mjs";
import { countingRecorder } from "../stage4-sender-fixture.mjs";
import { cleanup, fakeSession, intakeRun, mkSupervisor, req, seedClarify, seedLaneRows, seedLessons, until } from "../stage4-supervisor-fixture.mjs";

const CHAT = "42"; // the fixture supervisor's chat: chat turns, lane rows and the prompt file are keyed by it
const SQ = "intake.steer_or_queue"; const CG = "planner.crash_guard"; const LS = "context.lessons"; const CC = "turn.clarify_cap"; const TM = "turn.model";
const RC = "context.recall"; const CU = "context.catch_up";
const R = (entry, verdict, reason, run = "a", rung = "rule") => [entry, rung, verdict, reason, run];
const CAP40 = { HOUGE_LESSON_CHAR_CAP: "40" };

/** One planner turn through the supervisor, to idle. */
async function turn(x, sup, name, text = "hi", source = "telegram") {
  const id = x.run(name, text); sup.submit({ ...req(id, text, source), ...(source === "schedule" ? { goal: "g" } : {}) }); await sup.whenIdle(); return id;
}
const tel = (over = {}) => ({ admitted: 0, best_admitted: null, best_rejected: null, embedding: true, fts_only: false, ...over });
const fact = (id) => ({ id, block: `synthetic fact ${id}` });
const page = (id) => ({ id, block: `synthetic page ${id}` });
const retrieving = (r) => ({ retrieve: async () => r });
const oneTurn = (o = {}, seed) => async (x) => { seed?.(x); const { sup } = x.mk(o); await turn(x, sup, "a"); };

// recall ----------------------------------------------------------------------------------------------------------------------------------------------------
const recallEmbedded = oneTurn({ turnContext: retrieving({ facts: [fact(1), fact(2)], pages: [], telemetry: { facts: tel({ admitted: 2, best_admitted: 0.7, best_rejected: 0.2 }), pages: tel() } }) });
const recallFtsOnly = oneTurn({ turnContext: retrieving({ facts: [], pages: [page(1)], telemetry: { facts: tel({ embedding: false }), pages: tel({ embedding: false, fts_only: true, admitted: 1 }) } }) });
const recallEmbedFailed = oneTurn({ turnContext: retrieving({ facts: [], pages: [], telemetry: { facts: tel({ embedding: false }), pages: tel({ embedding: false }) } }) });
/** Embedded, one fact admitted at 0.8 but none rendered (the only admitted fact is in the core band, so retrieval returns it to no block). */
const recallDropped = oneTurn({ turnContext: retrieving({ facts: [], pages: [], telemetry: { facts: tel({ admitted: 1, best_admitted: 0.8 }), pages: tel() } }) });
const recallBelow = oneTurn({ turnContext: retrieving({ facts: [], pages: [], telemetry: { facts: tel(), pages: tel({ best_rejected: 0.3 }) } }) });
const recallUnscored = oneTurn({ turnContext: retrieving({ facts: [], pages: [], telemetry: { facts: tel(), pages: tel() } }) });
const recallNoTelemetry = oneTurn({ turnContext: retrieving({ facts: [], pages: [] }) });
/**
 * The end signal (spec §4.0, lessons-decisions case 6): /kill while `retrieve` is held. Read synchronously after abortAll is CALLED, before awaiting it:
 * done("abort") has fired (endSignalled) but settle has not finished the turn. `retrieve` is released in that interval: the build still writes loop_started
 * (the old build does too) and, on the new build, no R5 row and no recall/cap call.
 */
const recallEndSignal = async (x) => {
  let release = () => undefined; let retrieves = 0;
  const r = { facts: [fact(1)], pages: [], telemetry: { facts: tel({ admitted: 1, best_admitted: 0.7 }), pages: tel() } };
  const { sup } = x.mk({ turnContext: { retrieve: () => { retrieves += 1; return new Promise((res) => { release = () => res(r); }); } } });
  const a = x.run("a", "hi"); sup.submit(req(a, "hi")); await until(() => retrieves === 1);
  const killed = sup.abortAll("killed");
  const t = sup.turn;
  x.note("interval", { endSignalled: t?.endSignalled, finished: t?.finished });
  release(); await killed; await sup.whenIdle();
  x.note("loop_started", x.store.getLedgerEvents(a).some((e) => e.event_type === "loop_started"));
};

// catch-up --------------------------------------------------------------------------------------------------------------------------------------------------
const lanes = (texts) => (x) => seedLaneRows(x.d, x.store, CHAT, texts);
const short = (n) => Array.from({ length: n }, (_, k) => `Houge replied: a${k + 1}`);
const catchAll = oneTurn({}, lanes(short(2)));
const catchCapped = oneTurn({}, lanes(short(8)));
const catchTrimmed = oneTurn({}, lanes([1, 2, 3].map(() => `Houge replied: ${"x".repeat(900)}`)));
const catchAllTrimmed = oneTurn({}, lanes([`Houge replied: ${"x".repeat(2_100)}`]));
const catchReadFailed = async (x) => {
  lanes(short(1))(x);
  const throwing = new Proxy(x.store, { get: (t, k) => (k === "laneTurnsSince" ? () => { throw new Error("disk"); } : Reflect.get(t, k)) });
  const { sup } = x.mk({ turnContext: { store: throwing } }); await turn(x, sup, "a");
};
const catchSchedule = async (x) => { lanes(short(2))(x); const { sup } = x.mk(); await turn(x, sup, "a", "hi", "schedule"); };
const catchNone = oneTurn();

// lessons ---------------------------------------------------------------------------------------------------------------------------------------------------
const overCap = (x) => seedLessons(x.store, 2, 20); // each renders as a 33-char bullet: the first fits a 40-char cap, the second is skipped (one lesson_dropped)
const lessonsUnder = oneTurn({ turnContext: { env: CAP40 } }, (x) => seedLessons(x.store, 1, 10));
const lessonsCapped = oneTurn({ turnContext: { env: CAP40 } }, overCap);
const lessonsRenderFailed = async (x) => {
  const { sup } = x.mk(); // built first: the fixture reads the lesson fingerprint once at construction
  x.store.getActiveLessons = () => { throw new Error("disk"); }; // as vi.spyOn on the store (lessons-decisions case 3)
  await turn(x, sup, "a");
};
/** Seam twin of the late launcher (lessons-decisions case 4): a spawn whose launching turn has signalled its end but not finished. */
const lessonsSeam = async (x) => {
  overCap(x); const { sup } = x.mk({ turnContext: { env: CAP40 } });
  await sup.preflightThenSpawn(true, { finished: false, endSignalled: true, req: { run_id: "late" } });
};
/**
 * The late launcher, natural (spec §3/§6; real timers, ~15 s). Lane turns A then B; every versionCheck is held. A's warm start parks in its preflight; A's
 * finishLane times out (5 s), supersedes it (gen bump) and its settleStart times out (5 s): A completes with the start still in flight. B joins that start;
 * B's finishLane times out and supersedes it (gen bump), then waits in settleStart. Releasing check #1 now ends A's start superseded; B's ensureSession,
 * no longer joining, makes its own consult and launches its own start, whose check #2 is held. B completes. `settleHeld`: a pending read judgement keeps
 * B's settle in drainJudges, and check #2 is released after B's end signal but before B finished; otherwise after B's done. Then the spawn runs:
 * the prompt file is written and the drop raised, with the launching turn B ended (no context.lessons consult).
 */
const lateLauncher = (settleHeld) => async (x) => {
  overCap(x);
  const gates = [];
  const versionCheck = () => { const g = {}; g.p = new Promise((r) => { g.release = () => r({ ok: true, version: "18.4.4" }); }); gates.push(g); return g.p; };
  const { sup, outcome, data } = x.mk({ turnContext: { env: CAP40 }, extra: { versionCheck, triage: async () => ({ kind: "lane_reply", text: "lane text", buttons: [] }) } });
  const file = join(data, "omp", `system-chat-${CHAT}.md`);
  const a = x.run("a", "lane a"); sup.submit(req(a, "lane a")); await until(() => outcome.done.length === 1, 60_000);
  const g0 = sup.gen;
  const b = x.run("b", "lane b"); sup.submit(req(b, "lane b")); await until(() => sup.turn?.req.run_id === b);
  const tb = sup.turn;
  let releaseJudge = () => undefined;
  if (settleHeld) tb.active.judgeInFlight = new Map([["held", new Promise((r) => { releaseJudge = r; })]]);
  await until(() => sup.gen > g0, 60_000); // B's finishLane timed out and superseded the joined start
  x.note("before_release_1", { checks: gates.length, file: existsSync(file) });
  gates[0].release();
  await until(() => gates.length === 2, 60_000); // B launched its own start: check #2 is held
  if (settleHeld) {
    await until(() => tb.endSignalled === true || tb.laneEnded === true, 60_000);
    x.note("held_window", { endSignalled: tb.endSignalled, finished: tb.finished, done: outcome.done.length, file: existsSync(file) });
    gates[1].release();
    await until(() => sup.startInFlight === undefined, 60_000);
    x.note("spawned_in_window", { finished: tb.finished, file: existsSync(file) });
    releaseJudge();
    await until(() => outcome.done.length === 2, 60_000);
  } else {
    await until(() => outcome.done.length === 2, 60_000);
    x.note("after_b_done", { finished: tb.finished, file: existsSync(file), checks: gates.length });
    gates[1].release();
    await until(() => sup.startInFlight === undefined, 60_000);
  }
  await sup.whenIdle();
  x.note("spawned", { file: existsSync(file), checks: gates.length });
};
/** A stale re-check (planner-supervisor.test.ts "the old child's bridge dropping while a fresh turn builds its prompt"): turn b spawns again in its own turn. */
const lessonsStale = async (x) => {
  overCap(x);
  let release = () => undefined; let calls = 0;
  const retrieve = async () => { if (calls++ > 0) await new Promise((r) => { release = r; }); return { facts: [], pages: [] }; };
  const { sup, session } = x.mk({ turnContext: { env: CAP40, retrieve } });
  await turn(x, sup, "a");
  const b = x.run("b", "hi"); sup.submit(req(b, "hi")); await until(() => calls === 2);
  await session.stop(); // the fixture child's stop() drops its bridge socket without an exit: the supervisor marks itself stale
  await until(() => sup.stale === true);
  release(); await sup.whenIdle();
};

/** The same stale re-check inside ONE run (codex final review): turn a spawns, its own prompt build is held while the child's bridge drops, so a respawns. */
const lessonsStaleOneRun = async (x) => {
  overCap(x);
  let release = () => undefined; let calls = 0;
  const retrieve = async () => { calls++; await new Promise((r) => { release = r; }); return { facts: [], pages: [] }; };
  const { sup, session } = x.mk({ turnContext: { env: CAP40, retrieve } });
  const a = x.run("a", "hi"); sup.submit(req(a, "hi")); await until(() => calls === 1);
  await session.stop(); // the first child's bridge drops during a's own prompt build: the supervisor marks itself stale
  await until(() => sup.stale === true);
  release(); await sup.whenIdle();
};

// cap -------------------------------------------------------------------------------------------------------------------------------------------------------
const clarify = (x) => seedClarify(x.store, CHAT);
const capReached = oneTurn({}, clarify);
const capLoopAfter = oneTurn({}, (x) => { clarify(x); x.store.recordChatTurn({ chat_id: CHAT, run_id: "r1", role: "assistant", text: "Done.", intent: "loop", created_at: new Date(Date.now() - 10_000).toISOString() }); });
const capMaxZero = oneTurn({ turnContext: { env: { HOUGE_MAX_CONSECUTIVE_CLARIFY: "0" } } });
const capSchedule = async (x) => { clarify(x); const { sup } = x.mk(); await turn(x, sup, "a", "hi", "schedule"); };

// faults (P14): the real entry's rule replaced for the drive, restored in the drive's own finally (the entry object is process-global) -----------------------
async function planted(d, file, name, drive) {
  let mod = null;
  try { mod = await import(join(d.dir, "decisions", "entries", file)); } catch (e) { if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e; }
  const rung = mod?.[name]?.ladder[0];
  if (d.dir === DISTS.new && !rung) throw new Error(`fault item: ${name} missing from the new dist`);
  const orig = rung?.decide;
  if (rung) rung.decide = () => { throw new Error("planted"); };
  try { await drive(); } finally { if (rung) rung.decide = orig; }
}
const faultRecall = async (x) => {
  x.store.addEpisodicFact({ chat_id: CHAT, fact: "Paco likes the pdf one" }); // fact 1: the prompt shows it and the turn touches it, planted or not
  await planted(x.d, "context-recall.js", "CONTEXT_RECALL", () => oneTurn({ turnContext: retrieving({ facts: [{ id: 1, block: "Paco likes the pdf one" }], pages: [], telemetry: { facts: tel({ admitted: 1, best_admitted: 0.7 }), pages: tel() } }) })(x));
};
const faultCatchUp = async (x) => { lanes(short(1))(x); await planted(x.d, "context-catch-up.js", "CONTEXT_CATCH_UP", () => oneTurn()(x)); };
const faultLessons = async (x) => { overCap(x); await planted(x.d, "context-lessons.js", "CONTEXT_LESSONS", () => oneTurn({ turnContext: { env: CAP40 } })(x)); };
const faultCap = async (x) => { clarify(x); await planted(x.d, "turn-clarify-cap.js", "TURN_CLARIFY_CAP", () => oneTurn()(x)); };

// none ------------------------------------------------------------------------------------------------------------------------------------------------------
const claimedElsewhere = async (x) => {
  const { sup } = x.mk();
  const id = x.run("a", "hi"); if (!x.store.claimRun(id, "other", 120)) throw new Error("pre-claim failed");
  sup.submit(req(id, "hi")); await sup.whenIdle();
};

const TURN = { [SQ]: 1, [CG]: 1, [LS]: 1, [CC]: 1, [TM]: 1 };
const ANSWER = { done: ["a:answer"], failed: [], incidents: [], storeIncidents: [], spawns: 1, notes: {} };
const answered = (log, over = {}) => ({ ...ANSWER, log: ["set_model:anthropic/claude-opus-5-5", `prompt:${log}`], ...over });
const LANES = (n) => ({ done: ["a:lane text", "b:lane text"], failed: [], incidents: [], storeIncidents: ["lesson_dropped"], log: [], spawns: n });
const ITEMS = [
  { key: "recall_embedded", tags: ["recall_embedded"], drive: recallEmbedded, rows: [R(RC, "include", "embedded")], calls: { ...TURN, [RC]: 1 }, facts: answered("context:hi") },
  { key: "recall_fts_only", tags: ["recall_fts_only"], drive: recallFtsOnly, rows: [R(RC, "include", "fts_only")], calls: { ...TURN, [RC]: 1 }, facts: answered("context:hi") },
  { key: "recall_embed_failed", tags: ["recall_embed_failed"], drive: recallEmbedFailed, rows: [R(RC, "none", "embed_failed")], calls: { ...TURN, [RC]: 1 }, facts: answered("-:hi") },
  { key: "recall_dropped_after_gate", tags: ["recall_dropped"], drive: recallDropped, rows: [R(RC, "none", "dropped_after_gate")], calls: { ...TURN, [RC]: 1 }, facts: answered("-:hi") },
  { key: "recall_below_gate", tags: ["recall_below"], drive: recallBelow, rows: [R(RC, "none", "below_gate")], calls: { ...TURN, [RC]: 1 }, facts: answered("-:hi") },
  { key: "recall_unscored", tags: ["recall_unscored"], drive: recallUnscored, rows: [R(RC, "none", "unscored")], calls: { ...TURN, [RC]: 1 }, facts: answered("-:hi") },
  { key: "recall_no_telemetry", tags: ["recall_off"], drive: recallNoTelemetry, rows: [], calls: TURN, facts: answered("-:hi") },
  { key: "recall_end_signal", tags: ["end_signal"], drive: recallEndSignal, rows: [], calls: { [SQ]: 1, [CG]: 1, [LS]: 1 },
    facts: { done: [], failed: ["a:killed:killed"], incidents: [], storeIncidents: [], log: [], spawns: 1, notes: { interval: { endSignalled: true, finished: false }, loop_started: true } } },
  { key: "catch_up_all", tags: ["catch_all"], drive: catchAll, rows: [R(CU, "inject", "all")], calls: { ...TURN, [CU]: 1 }, facts: answered("catchup:hi") },
  { key: "catch_up_entry_capped", tags: ["catch_capped"], drive: catchCapped, rows: [R(CU, "inject", "entry_capped")], calls: { ...TURN, [CU]: 1 }, facts: answered("catchup:hi") },
  { key: "catch_up_trimmed", tags: ["catch_trimmed"], drive: catchTrimmed, rows: [R(CU, "inject", "trimmed")], calls: { ...TURN, [CU]: 1 }, facts: answered("catchup:hi") },
  { key: "catch_up_all_trimmed", tags: ["catch_all_trimmed"], drive: catchAllTrimmed, rows: [R(CU, "none", "all_trimmed")], calls: { ...TURN, [CU]: 1 }, facts: answered("-:hi") },
  { key: "catch_up_read_failed", tags: ["catch_read_failed"], drive: catchReadFailed, rows: [R(CU, "none", "read_failed")], calls: { ...TURN, [CU]: 1 }, facts: answered("-:hi") },
  { key: "catch_up_schedule", tags: ["catch_schedule"], drive: catchSchedule, rows: [], calls: TURN, facts: answered("schedule:hi") },
  { key: "catch_up_no_rows", tags: ["catch_none"], drive: catchNone, rows: [], calls: TURN, facts: answered("-:hi") },
  { key: "lessons_under_cap", tags: ["lessons_under"], drive: lessonsUnder, rows: [], calls: TURN, facts: answered("-:hi") },
  { key: "lessons_capped", tags: ["lessons_capped"], drive: lessonsCapped, rows: [R(LS, "capped", "char_cap")], calls: TURN, facts: answered("-:hi", { storeIncidents: ["lesson_dropped"] }) },
  { key: "lessons_render_failed", tags: ["lessons_render_failed"], drive: lessonsRenderFailed, rows: [R(LS, "none", "render_failed")], calls: TURN, facts: answered("-:hi", { storeIncidents: ["lesson_render_failed"] }) },
  { key: "lessons_late_launcher", tags: ["late_natural"], drive: lateLauncher(false), rows: [], calls: { [SQ]: 2, [CG]: 2 },
    facts: { ...LANES(1), notes: { before_release_1: { checks: 1, file: false }, after_b_done: { finished: true, file: false, checks: 2 }, spawned: { file: true, checks: 2 } } } },
  { key: "lessons_late_settle_held", tags: ["late_settle_held"], drive: lateLauncher(true), rows: [], calls: { [SQ]: 2, [CG]: 2 },
    facts: { ...LANES(1), notes: { before_release_1: { checks: 1, file: false }, held_window: { endSignalled: true, finished: false, done: 1, file: false }, spawned_in_window: { finished: false, file: true }, spawned: { file: true, checks: 2 } } } },
  { key: "lessons_seam", tags: ["late_seam"], drive: lessonsSeam, rows: [], calls: {},
    facts: { done: [], failed: [], incidents: [], storeIncidents: ["lesson_dropped"], log: [], spawns: 1, notes: {} } },
  { key: "lessons_stale_respawn", tags: ["stale"], drive: lessonsStale, rows: [R(LS, "capped", "char_cap", "a"), R(LS, "capped", "char_cap", "b")],
    calls: { [SQ]: 2, [CG]: 2, [LS]: 2, [CC]: 2, [TM]: 2 }, order: [SQ, CG, LS, CC, TM, SQ, CC, CG, LS, TM],
    facts: { done: ["a:answer", "b:answer"], failed: [], incidents: [], storeIncidents: ["lesson_dropped"], spawns: 2, notes: {},
      log: ["set_model:anthropic/claude-opus-5-5", "prompt:-:hi", "set_model:anthropic/claude-opus-5-5", "prompt:-:hi"] } },
  { key: "lessons_stale_respawn_one_run", tags: ["stale_one_run"], drive: lessonsStaleOneRun, rows: [R(LS, "capped", "char_cap", "a"), R(LS, "capped", "char_cap", "a")],
    calls: { [SQ]: 1, [CG]: 2, [LS]: 2, [CC]: 1, [TM]: 1 }, order: [SQ, CG, LS, CC, CG, LS, TM],
    facts: { done: ["a:answer"], failed: [], incidents: [], storeIncidents: ["lesson_dropped"], spawns: 2, notes: {},
      log: ["set_model:anthropic/claude-opus-5-5", "prompt:-:hi"] } },
  { key: "cap_reached", tags: ["cap"], drive: capReached, rows: [R(CC, "cap", "cap_reached")], calls: TURN, facts: answered("cap:hi") },
  { key: "cap_loop_after_clarify", tags: ["cap_loop"], drive: capLoopAfter, rows: [], calls: TURN, facts: answered("-:hi") },
  { key: "cap_max_zero", tags: ["cap_zero"], drive: capMaxZero, rows: [R(CC, "cap", "cap_reached")], calls: TURN, facts: answered("cap:hi") },
  { key: "cap_schedule", tags: ["cap_schedule"], drive: capSchedule, rows: [R(CC, "cap", "cap_reached")], calls: TURN, facts: answered("schedule+cap:hi") },
  { key: "fault_recall", tags: ["fault_recall"], drive: faultRecall, rows: [R(RC, "none", null, "a", "fail")], calls: { ...TURN, [RC]: 1 }, facts: answered("context:hi") },
  { key: "fault_catch_up", tags: ["fault_catch_up"], drive: faultCatchUp, rows: [R(CU, "none", null, "a", "fail")], calls: { ...TURN, [CU]: 1 }, facts: answered("catchup:hi") },
  { key: "fault_lessons", tags: ["fault_lessons"], drive: faultLessons, rows: [R(LS, "full", null, "a", "fail")], calls: TURN, facts: answered("-:hi", { storeIncidents: ["lesson_dropped"] }) },
  { key: "fault_cap", tags: ["fault_cap"], drive: faultCap, rows: [R(CC, "allow", null, "a", "fail")], calls: TURN, facts: answered("cap:hi") },
  { key: "claimed_elsewhere", tags: ["claimed"], drive: claimedElsewhere, rows: [], calls: {},
    facts: { done: [], failed: [], incidents: [], storeIncidents: [], log: [], spawns: 0, notes: {} } }
];
const BRANCHES = ITEMS.map((i) => i.tags[0]);

const all = (store, sql) => store.db.prepare(sql).all().map((r) => ({ ...r }));
const isClockKey = (k) => /(_at|_since|^since|^now)$/.test(k);
const TOUCHED = ["lessons", "episodic_facts", "wiki_pages"]; const TOUCH_KEYS = ["last_used", "last_seen"];
/**
 * Touch times exactly (codex fix 1): each touched row's last_used/last_seen becomes "<ledger event>@<run label>+<ms>", the latest ledger event at or
 * before it and the counting-clock distance from it. recordAttribution writes loop_started and then touches with no recorder call between, so the
 * distance is the same on both builds unless the touch moved; the recorder's extra clock reads shift only absolute instants, which the anchor cancels.
 */
function anchorTouches(db, ownerLabel) {
  const events = (db.ledger_events ?? []).map((e) => ({ at: Date.parse(e.occurred_at), what: `${e.event_type}@${ownerLabel(e.run_id)}` }));
  const anchor = (v) => {
    const t = Date.parse(v); let best = null;
    for (const e of events) if (e.at <= t && (best === null || e.at >= best.at)) best = e;
    return best ? `${best.what}+${t - best.at}ms` : `unanchored:${v}`;
  };
  const out = { ...db };
  for (const name of TOUCHED) {
    if (!out[name]) continue;
    out[name] = out[name].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, TOUCH_KEYS.includes(k) && typeof v === "string" ? anchor(v) : v])));
  }
  return out;
}
const idList = R5_IDS.map((i) => `'${i}'`).join(",");
// P16 (R6): every row the new build records and this pair's old build cannot is dropped at the dump, so a non-default R6 row never shifts a clock label before compare strips it.
const dropIds = [...NEW_ROW_IDS.r5];
const dropList = dropIds.map((i) => `'${i}'`).join(",");

// Coverage self-test: the dump must hold, per table, exactly the rows the DB holds (minus the intentionally dropped R5 decisions rows).
function tableCounts(store) {
  const counts = {};
  for (const { name } of regularTables(store)) {
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${name === "decisions" ? ` WHERE entry_id NOT IN (${dropList})` : extraDropFilter(name)}`).get().n;
    if (n > 0) counts[name] = n;
  }
  return counts;
}
const dumpCounts = (db) => Object.fromEntries(Object.entries(db).map(([t, rows]) => [t, rows.length]));
function checkCoverage(db, want) {
  const got = dumpCounts(db);
  if (canon(got) !== canon(want)) throw new Error(`coverage self-test: dump holds ${canon(got)}, the DB holds ${canon(want)}`);
}
/** The check must itself catch a dump that lost one row of a still-populated table (or a whole table). */
function omittedRowSelfTest(db, want) {
  const t = Object.keys(db).find((k) => db[k].length > 1) ?? Object.keys(db)[0];
  if (!t) return;
  const mutated = { ...db, [t]: db[t].slice(1) };
  if (!mutated[t].length) delete mutated[t];
  try { checkCoverage(mutated, want); } catch { return; }
  throw new Error(`coverage self-test is blind: a dump missing one row of ${t} passed`);
}

const BARE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
/** Worker ids (`planner:<chat>:<uuid>`) carry a bare uuid scrubIds leaves alone: label them by first appearance. */
function scrubWorkers(v) {
  const seen = new Map();
  return JSON.parse(JSON.stringify(v).replace(BARE_UUID, (m) => { if (!seen.has(m)) seen.set(m, `uuid#${seen.size + 1}`); return seen.get(m); }));
}
const durationClass = (n) => (n === 0 ? 0 : "+");
function classDurations(db) {
  return JSON.parse(JSON.stringify(db).replace(/\\"duration_ms\\":(\d+)/g, (_m, n) => `\\"duration_ms\\":\\"${durationClass(Number(n))}\\"`));
}
/** STRIP_KEYS drops every `run_id` before comparison, so ownership would be invisible: put a stable `run_label` beside each one. */
function labelRunOwners(v, ownerLabel) {
  if (Array.isArray(v)) return v.map((e) => labelRunOwners(e, ownerLabel));
  if (v === null || typeof v !== "object") return v;
  const out = {};
  for (const [k, e] of Object.entries(v)) {
    out[k] = labelRunOwners(e, ownerLabel);
    if (k === "run_id") out.run_label = typeof e === "string" ? ownerLabel(e) : e;
  }
  return out;
}

/** The ordered child log as short facts: each prompt named by the R5 blocks it carries (cap notice, [context], catch-up, schedule prefix) and its message. */
async function promptMarkers(d) {
  const m = await import(join(d.dir, "omp", "turn-context.js"));
  return { cap: m.CLARIFY_CAP_NOTICE, catchUp: m.CATCH_UP_OPEN };
}
function logFacts(log, mk) {
  const tagOf = (p) => [p.includes("[scheduled: ") ? "schedule" : null, p.includes(mk.cap) ? "cap" : null, p.includes("[context]\n") ? "context" : null,
    p.includes(mk.catchUp) ? "catchup" : null].filter(Boolean).join("+") || "-";
  return log.map(([kind, v]) => (kind === "prompt" ? `prompt:${tagOf(v)}:${v.split("\n").at(-1)}` : `${kind}:${v}`));
}

/** The drive's handle on one store: `run` intakes a labelled run, `mk` builds the supervisor (recorder on the new side) and captures the prompt file per spawn. */
function driveContext(d, store, recorder) {
  const names = new Map(); const notes = {}; const files = []; let rig = null;
  const x = {
    d, store, note: (k, v) => { notes[k] = v; },
    run: (name, text) => { const id = intakeRun(d, store, text, name); names.set(id, name); return id; },
    mk: (opts = {}) => {
      const session = opts.session ?? fakeSession();
      // the prompt file at each spawn: the stable path is overwritten per spawn, so read it when the child is bound to it
      const sessionFactory = (o) => { files.push(readFileSync(o.systemPromptFile, "utf8")); return session.bind(o); };
      rig = mkSupervisor(d, store, { ...opts, session, extra: { ...opts.extra, sessionFactory }, ...(recorder ? { recorder } : {}) });
      return rig;
    }
  };
  return { x, names, notes, files, rig: () => rig };
}
/** The behaviour the scenario must reach, exact: sink calls, store incidents by kind, the ordered child log as markers, spawns, the drive's own notes. */
function factsOf(store, { session, outcome, label, mk, files, notes }) {
  return {
    done: outcome.done.map((o) => `${label(o.run_id)}:${o.text}`), failed: outcome.failed.map((o) => `${label(o.run_id)}:${o.error_type}:${o.error_ref}`),
    incidents: outcome.incidents.map((i) => i.k), storeIncidents: all(store, "SELECT kind FROM incidents ORDER BY kind").map((r) => r.kind),
    log: logFacts(session.log, mk), spawns: files.length, notes
  };
}

async function project(d, item) {
  const dir = mkTemp(`context-${item.key}`);
  let store = null;
  const mk = await promptMarkers(d);
  try {
    return await withPinnedEnv(join(dir, "pin"), () => withCountingClock(NOW, async () => {
      store = mkStore(d, "bare", join(dir, "context.sqlite"));
      const isNew = d.dir === DISTS.new;
      const counting = isNew ? countingRecorder(d.storeRecorder(store)) : null;
      const order = [];
      const recorder = counting ? { ...counting.recorder, record: (e, r, c) => { order.push(e.id); return counting.recorder.record(e, r, c); } } : null;
      const { x, names, notes, files, rig } = driveContext(d, store, recorder);
      const seedMax = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
      try { await item.drive(x); } finally { await cleanup(); }
      for (const { run_id } of all(store, "SELECT run_id FROM runs WHERE json_extract(requested_by_json, '$.id') = 'seed-answer'")) names.set(run_id, "seed-answer");
      const label = (id) => names.get(id) ?? id;
      const runOrder = [...names.keys()]; const foreign = new Map();
      const ownerLabel = (id) => (runOrder.includes(id) ? `r${runOrder.indexOf(id) + 1}` : foreign.has(id) ? foreign.get(id) : (foreign.set(id, `other#${foreign.size + 1}`), foreign.get(id)));
      const newRows = all(store, `SELECT entry_id, rung, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ${Number(seedMax)} AND entry_id IN (${idList}, 'turn.model') ORDER BY rowid`)
        .map((r) => [r.entry_id, r.rung, r.verdict, r.reason_code, label(r.run_id), r.tool_call_id]);
      if (!isNew && newRows.length) throw new Error("control failed: the old build wrote an R5 decision row");
      if (existsSync(join(process.cwd(), "houge.kill"))) throw new Error("P2 failed: a houge.kill appeared in the cwd");
      const db = dumpDb(store, { dropDecisionIds: dropIds });
      const want = tableCounts(store);
      checkCoverage(db, want);
      omittedRowSelfTest(db, want);
      const { session, outcome, data } = rig();
      const promptFiles = files.map((f) => f.split(data).join("<data>"));
      const seen = (list) => list.map(({ run_id, ...rest }) => ({ ...rest, ...("duration_ms" in rest ? { duration_ms: durationClass(rest.duration_ms) } : {}), run_id: label(run_id), run_label: ownerLabel(run_id) }));
      const observed = { log: session.log, done: seen(outcome.done), failed: seen(outcome.failed), incidents: outcome.incidents, promptFiles, db: classDurations(labelRunOwners(anchorTouches(db, ownerLabel), ownerLabel)) };
      const facts = factsOf(store, { session, outcome, label, mk, files, notes });
      return { ...scrubWorkers(scrubIds(relabelClocks(observed, isClockKey))), newRows, calls: counting?.calls ?? {}, order, facts, __strip: ["newRows", "calls", "order", "facts"] };
    }));
  } finally { try { store?.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  const want = item.rows.map((r) => [...r, null]);
  requireNew(corpus, item, "R5 rows (exact: entry, rung, verdict, reason, the consulting run, tool_call null)", canon(proj.newRows) === canon(want), `got ${canon(proj.newRows)}, want ${canon(want)}`);
  requireNew(corpus, item, "recorder calls per entry (exact)", canon(proj.calls) === canon(item.calls), `got ${canon(proj.calls)}, want ${canon(item.calls)}`);
  if (item.order) requireNew(corpus, item, "recorder call order (exact, P4 event rules)", canon(proj.order) === canon(item.order), `got ${canon(proj.order)}, want ${canon(item.order)}`);
  requireNew(corpus, item, "behaviour facts (sink calls, incidents, spawns, ordered child log, drive notes: exact)", canon(proj.facts) === canon(item.facts), `got ${canon(proj.facts)}, want ${canon(item.facts)}`);
}

// Determinism self-test: the same item twice on the new build must project identically, or the old/new comparison would flag its own noise.
async function load(ctx) {
  const first = ITEMS.find((i) => i.key === "lessons_capped");
  const [a, b] = [await project(ctx.dists.new, first), await project(ctx.dists.new, first)];
  const diff = compare(corpus, first, a, b, corpus.pairs[0]);
  if (diff) throw new Error(`determinism self-test: two runs of one item project differently: ${diff.diff}`);
  return ITEMS;
}

const corpus = { name: "context", pairs: [["r5", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required };
export default corpus;
