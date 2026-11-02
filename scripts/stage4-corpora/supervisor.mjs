// Slice R3 differential, supervisor corpus (spec 2026-11-01 R3 §6). Pair: r3 (the merge-base build 6c75b03) -> new. Every item drives the dist's own
// PlannerSupervisor (scripts/stage4-supervisor-fixture.mjs: a fake omp child over the real bridge socket) on a fresh temp-file store, under a pinned env
// (P2: abortAll("killed") writes a tombstone; P3: no chat id for a recorder alert) and a counting clock. The new side's supervisor gets a counting recorder over
// the store recorder; the old build has no `recorder` dep. Compared: the child's prompts and steers, the sink's done/failed (run ids and fields, worker ids
// scrubbed) and a whole-DB dump with the R3 decision rows removed (clocks relabelled by order, ids scrubbed). The R3 rows are filtered by the harness
// (NEW_ROW_IDS.r3) and REQUIRED EXACTLY on the new side: [entry, verdict, reason, the submitted run, null], plus exact per-entry recorder call counts
// (P12: the idle consult counts; a bare_ack `pass` consults once and writes no row). The old build must hold none.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISTS, R3_IDS, canon, compare, dumpDb, mkStore, mkTemp, regularTables, extraDropFilter, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { NOW, withCountingClock, withPinnedEnv } from "../stage4-intake-fixture.mjs";
import { countingRecorder } from "../stage4-sender-fixture.mjs";
import { cleanup, fakeSession, heldSession, intakeRun, mkSupervisor, req, sink, until, untilState } from "../stage4-supervisor-fixture.mjs";

const SCHED = (r) => ({ ...r, goal: "g" }); // a schedule-born request carries its goal
const BOUNDED = { pause: "bounded", ttlMs: 30 }; // P11: the pause runs out, the card stays open, the turn is RUNNING with approvals > 0
const toolsOf = (d) => ({ registry: new d.ToolRegistry(), quarantine: async () => ({ digest: "", contains_instructions: false, source_meta: { tool: "x", bytes: 0 } }) });
const emitAborted = (session) => session.emit({ type: "agent_end", aborted: true });

// Each drive(x) runs the scenario to idle; x = { d, store, run(name, text), mk(opts), ... }. rows: [entry, verdict, reason, run name]; calls: the exact recorder tally.
const idle = async (x) => {
  const a = x.run("a", "hi"); const { sup } = x.mk(); sup.submit(req(a)); await sup.whenIdle();
};
const turnNotLive = async (x) => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = heldSession({ holdStart: gate }); const { sup } = x.mk({ session: h.session });
  const a = x.run("a", "u"); const b = x.run("b", "second");
  sup.submit(req(a)); await untilState(sup, "STARTING"); sup.submit(req(b, "second"));
  release(); await h.live(1, sup); h.end(); await h.live(2, sup); h.end(); await sup.whenIdle();
};
const queuedBehind = async (x) => {
  const h = heldSession(); let n = 0; let sup;
  const outcome = sink(x.store); const orig = outcome.fail;
  const a = x.run("a", "1"); const b = x.run("b", "2"); const c = x.run("c", "third");
  outcome.fail = (i) => { orig(i); if (i.run_id === b) sup.submit(req(c, "third")); }; // P10: submitted from inside the setup failure, between claim and this.turn
  ({ sup } = x.mk({ session: h.session, outcome, extra: { buildTools: () => { n += 1; if (n === 2) throw new Error("setup"); return toolsOf(x.d); } } }));
  sup.submit(SCHED(req(a, "1", "schedule"))); sup.submit(SCHED(req(b, "2", "schedule")));
  await h.live(1, sup); h.end(); await h.live(2, sup); h.end(); await sup.whenIdle();
};
const duplicate = async (x) => {
  const h = heldSession(); const { sup } = x.mk({ session: h.session });
  const a = x.run("a", "u"); const b = x.run("b", "x");
  sup.submit(req(a)); await h.live(1, sup); sup.submit(req(b, "x")); sup.submit(req(b, "x")); h.end(); await sup.whenIdle();
};
const mediaDuringCard = async (x) => {
  const h = heldSession(); const { sup } = x.mk({ session: h.session });
  const a = x.run("a", "u"); const p = x.run("p", "photo"); const q = x.run("q", "好");
  sup.submit(req(a)); await h.live(1, sup); sup.submit({ ...req(p, "photo"), needsIngest: true });
  sup.setAwaitingApprovalForTest(true); sup.submit({ ...req(q, "好"), needsIngest: true }); sup.setAwaitingApprovalForTest(false);
  h.end(); await h.live(2, sup); h.end(); await h.live(3, sup); h.end(); await sup.whenIdle();
};
/** `card`: "none" | "awaiting" (AWAITING_APPROVAL) | "running" (P11: bounded pause expired, approvals > 0). b is the message that arrives with the card in that state. */
const duringCard = (card, text) => async (x) => {
  const h = heldSession(); const { sup, outcome } = x.mk({ session: h.session });
  const a = x.run("a", "push it"); const b = x.run("b", text);
  sup.submit(req(a, "push it")); await h.live(1, sup);
  if (card === "awaiting") sup.setAwaitingApprovalForTest(true);
  if (card === "running") { sup.setAwaitingApprovalForTest(true, BOUNDED); await untilState(sup, "RUNNING"); }
  sup.submit(req(b, text));
  if (text === "好" && card !== "none") await until(() => outcome.done.some((o) => o.run_id === b)); // the nudge completes b on its own
  if (card !== "none") sup.setAwaitingApprovalForTest(false);
  h.end(); await sup.whenIdle();
};
const scheduleBorn = async (x) => {
  const h = heldSession(); const { sup } = x.mk({ session: h.session });
  const s = x.run("s", "brief"); const m = x.run("m", "later");
  sup.submit(SCHED(req(s, "brief", "schedule"))); await h.live(1, sup); sup.submit(req(m, "later"));
  h.end(); await h.live(2, sup); h.end(); await sup.whenIdle();
};
const messageScheduled = async (x) => {
  const h = heldSession(); const { sup } = x.mk({ session: h.session });
  const a = x.run("a", "u"); const s = x.run("s", "b");
  sup.submit(req(a, "u")); await h.live(1, sup); sup.submit(SCHED(req(s, "b", "schedule")));
  h.end(); await h.live(2, sup); h.end(); await sup.whenIdle();
};
const needsIngest = async (x) => {
  const h = heldSession(); const { sup } = x.mk({ session: h.session });
  const a = x.run("a", "u"); const p = x.run("p", "photo");
  sup.submit(req(a, "u")); await h.live(1, sup); sup.submit({ ...req(p, "photo"), needsIngest: true });
  h.end(); await h.live(2, sup); h.end(); await sup.whenIdle();
};
/** A message that arrives while a live Telegram turn is ABORTING (abortAll's first synchronous step): live but neither RUNNING nor AWAITING_APPROVAL. */
const notRunning = async (x) => {
  const h = heldSession(); h.session.abort = async () => undefined; // the child answers the abort only when the corpus says so
  const { sup } = x.mk({ session: h.session });
  const a = x.run("a", "u"); const b = x.run("b", "late");
  sup.submit(req(a, "u")); await h.live(1, sup);
  const killed = sup.abortAll("killed"); // P2: the tombstone path is pinned by project()
  if (sup.state() !== "ABORTING") throw new Error(`not_running item: state ${sup.state()}, wanted ABORTING`);
  sup.submit(req(b, "late"));
  emitAborted(h.session); await h.live(2, sup); h.end("late answer"); await killed; await sup.whenIdle();
};
const preClaimedSteer = async (x) => {
  const h = heldSession(); const { sup } = x.mk({ session: h.session });
  const a = x.run("a", "u"); const s1 = x.run("s1", "steer me");
  sup.submit(req(a)); await h.live(1, sup);
  if (!x.store.claimRun(s1, "other", 120)) throw new Error("pre-claim failed");
  sup.submit(req(s1, "steer me")); h.end(); await sup.whenIdle();
};
const preClaimedNudge = async (x) => {
  const h = heldSession(); const { sup, outcome } = x.mk({ session: h.session });
  const a = x.run("a", "u"); const n1 = x.run("n1", "好");
  sup.submit(req(a)); await h.live(1, sup); sup.setAwaitingApprovalForTest(true);
  if (!x.store.claimRun(n1, "other", 120)) throw new Error("pre-claim failed");
  sup.submit(req(n1, "好"));
  if (outcome.done.some((o) => o.run_id === n1)) throw new Error("a pre-claimed nudge must not complete");
  sup.setAwaitingApprovalForTest(false); h.end(); await sup.whenIdle();
};

const CG = "planner.crash_guard"; const SQ = "intake.steer_or_queue"; const BA = "intake.bare_ack"; const LS = "context.lessons"; const CC = "turn.clarify_cap"; // R5: one LS per spawn attempt that reaches preparePaths, one CC per live buildTurnPrompt (P4)
const W = (reason, run) => [SQ, "wait", reason, run]; const STEER = (run) => [SQ, "steer", "live_turn", run]; const NUDGE = (run) => [BA, "nudge", "ack_while_card_waits", run];
// calls: the recorder's exact tally on the new side. Only the first turn spawns, so each item consults planner.crash_guard once (R4); every run the supervisor claims consults steer_or_queue once (the first, idle run included, P12); a bare_ack
// consult is made for a non-ack with a card waiting (pass, no row) and for the nudge itself; a media message is never live, so it never consults bare_ack.
const ITEMS = [
  { key: "idle", tags: ["idle"], drive: idle, rows: [], calls: { [CG]: 1, [SQ]: 1, [LS]: 1, [CC]: 1 } },
  { key: "turn_not_live", tags: ["turn_not_live"], drive: turnNotLive, rows: [W("turn_not_live", "b")], calls: { [CG]: 1, [SQ]: 2, [LS]: 1, [CC]: 2 } },
  { key: "queued_behind", tags: ["queued_behind"], drive: queuedBehind, rows: [W("turn_not_live", "b"), W("queued_behind", "c")], calls: { [CG]: 1, [SQ]: 3, [LS]: 1, [CC]: 2 } },
  { key: "duplicate_submit", tags: ["duplicate"], drive: duplicate, rows: [STEER("b")], calls: { [CG]: 1, [SQ]: 2, [LS]: 1, [CC]: 1 } },
  { key: "bare_ack_media_during_card", tags: ["media"], drive: mediaDuringCard, rows: [W("needs_ingest", "p"), W("needs_ingest", "q")], calls: { [CG]: 1, [SQ]: 3, [LS]: 1, [CC]: 3 } },
  { key: "steer_running", tags: ["steer"], drive: duringCard("none", "x"), rows: [STEER("b")], calls: { [CG]: 1, [SQ]: 2, [LS]: 1, [CC]: 1 } },
  { key: "steer_awaiting_approval", tags: ["steer", "card"], drive: duringCard("awaiting", "why?"), rows: [STEER("b")], calls: { [CG]: 1, [SQ]: 2, [BA]: 1, [LS]: 1, [CC]: 1 } },
  { key: "bare_ack_awaiting", tags: ["nudge"], drive: duringCard("awaiting", "好"), rows: [NUDGE("b")], calls: { [CG]: 1, [SQ]: 1, [BA]: 1, [LS]: 1, [CC]: 1 } },
  { key: "bare_ack_running_card", tags: ["nudge", "card"], drive: duringCard("running", "好"), rows: [NUDGE("b")], calls: { [CG]: 1, [SQ]: 1, [BA]: 1, [LS]: 1, [CC]: 1 } },
  { key: "bare_ack_running_no_card", tags: ["steer"], drive: duringCard("none", "好"), rows: [STEER("b")], calls: { [CG]: 1, [SQ]: 2, [LS]: 1, [CC]: 1 } },
  { key: "non_ack_running_card", tags: ["steer", "card"], drive: duringCard("running", "why?"), rows: [STEER("b")], calls: { [CG]: 1, [SQ]: 2, [BA]: 1, [LS]: 1, [CC]: 1 } },
  { key: "turn_schedule_born", tags: ["schedule_born"], drive: scheduleBorn, rows: [W("turn_schedule_born", "m")], calls: { [CG]: 1, [SQ]: 2, [LS]: 1, [CC]: 2 } },
  { key: "message_scheduled", tags: ["message_scheduled"], drive: messageScheduled, rows: [W("message_scheduled", "s")], calls: { [CG]: 1, [SQ]: 2, [LS]: 1, [CC]: 2 } },
  { key: "needs_ingest", tags: ["needs_ingest"], drive: needsIngest, rows: [W("needs_ingest", "p")], calls: { [CG]: 1, [SQ]: 2, [LS]: 1, [CC]: 2 } },
  { key: "not_running_aborting", tags: ["not_running"], drive: notRunning, rows: [W("not_running", "b")], calls: { [CG]: 1, [SQ]: 2, [LS]: 1, [CC]: 2 } },
  { key: "preclaimed_steer", tags: ["preclaimed"], drive: preClaimedSteer, rows: [], calls: { [CG]: 1, [SQ]: 1, [LS]: 1, [CC]: 1 } },
  { key: "preclaimed_nudge", tags: ["preclaimed"], drive: preClaimedNudge, rows: [], calls: { [CG]: 1, [SQ]: 1, [LS]: 1, [CC]: 1 } }
];
const BRANCHES = ["idle", "turn_not_live", "queued_behind", "duplicate", "media", "steer", "card", "nudge", "schedule_born", "message_scheduled", "needs_ingest", "not_running", "preclaimed"];

const all = (store, sql) => store.db.prepare(sql).all().map((r) => ({ ...r }));
const isClockKey = (k) => /(_at|_since|^since|^now)$/.test(k);
const idList = R3_IDS.map((i) => `'${i}'`).join(",");

// Coverage self-test: the dump must hold, per table, exactly the rows the DB holds (minus the intentionally dropped R3 decisions rows),
// counted by SQL count(*) over the same ordinary-table rule dumpDb uses (virtual tables and their shadows left out).
function tableCounts(store) {
  const counts = {};
  for (const { name } of regularTables(store)) {
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${name === "decisions" ? ` WHERE entry_id NOT IN (${idList})` : extraDropFilter(name)}`).get().n;
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

/** What behaviour depends on is zero vs positive, not the wall-clock value (worker ids are kept: scrubWorkers relabels them with one map across sink calls and the dump). */
const durationClass = (n) => (n === 0 ? 0 : "+");
/** The only stored copy of a turn's duration is its run_completed ledger payload (runs keeps none): it must equal what the sink was handed. */
function durationDisagreements(store, done, label) {
  return done.flatMap((c) => {
    const ev = store.getLedgerEvents(c.run_id).filter((e) => e.event_type === "run_completed");
    const stored = ev.map((e) => e.payload.duration_ms);
    return stored.length === 1 && stored[0] === c.duration_ms ? [] : [{ run: label(c.run_id), sink: c.duration_ms, stored }];
  });
}
/** Ledger payload strings carry `"duration_ms":<n>`: classify each, textually, after the agreement check. */
function classDurations(db) {
  return JSON.parse(JSON.stringify(db).replace(/\\"duration_ms\\":(\d+)/g, (_m, n) => `\\"duration_ms\\":\\"${durationClass(Number(n))}\\"`));
}

/** STRIP_KEYS drops every `run_id` before comparison, so ownership would be invisible: put a stable `run_label` beside each one (submit order r1.., foreign ids other#n by first appearance). */
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

async function project(d, item) {
  const dir = mkTemp(`supervisor-${item.key}`);
  let store = null;
  try {
    return await withPinnedEnv(join(dir, "pin"), () => withCountingClock(NOW, async () => {
      store = mkStore(d, "bare", join(dir, "supervisor.sqlite")); // opened under the counting clock: schema_migrations.applied_at is a stamp too
      const isNew = d.dir === DISTS.new;
      const names = new Map(); const runs = new Map();
      const counting = isNew ? countingRecorder(d.storeRecorder(store)) : null;
      let rig = null;
      const x = {
        d, store,
        run: (name, text) => { const id = intakeRun(d, store, text, name); names.set(id, name); runs.set(name, id); return id; },
        mk: (opts = {}) => { rig = mkSupervisor(d, store, { ...opts, ...(counting ? { recorder: counting.recorder } : {}) }); return rig; }
      };
      const seedMax = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m; // an empty table gives NULL, and rowid > NULL selects nothing
      try { await item.drive(x); } finally { await cleanup(); }
      const label = (id) => names.get(id) ?? id;
      const order = [...names.keys()]; const foreign = new Map();
      const ownerLabel = (id) => (order.includes(id) ? `r${order.indexOf(id) + 1}` : foreign.has(id) ? foreign.get(id) : (foreign.set(id, `other#${foreign.size + 1}`), foreign.get(id)));
      const newRows = all(store, `SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ${Number(seedMax)} AND entry_id IN (${idList}) ORDER BY rowid`)
        .map((r) => [r.entry_id, r.verdict, r.reason_code, label(r.run_id), r.tool_call_id]);
      if (!isNew && newRows.length) throw new Error("control failed: the old build wrote intake.bare_ack / intake.steer_or_queue rows");
      if (existsSync(join(process.cwd(), "houge.kill"))) throw new Error("P2 failed: a houge.kill appeared in the cwd");
      const db = dumpDb(store, { dropDecisionIds: R3_IDS });
      const want = tableCounts(store);
      checkCoverage(db, want);
      omittedRowSelfTest(db, want);
      const { session, outcome } = rig;
      const agreement = durationDisagreements(store, outcome.done, label); // BEFORE any normalising: the emitted value must be the stored one
      const seen = (list) => list.map(({ run_id, ...rest }) => ({ ...rest, ...("duration_ms" in rest ? { duration_ms: durationClass(rest.duration_ms) } : {}), run_id: label(run_id), run_label: ownerLabel(run_id) }));
      const observed = { prompts: session.prompts, steers: session.steers, done: seen(outcome.done), failed: seen(outcome.failed), incidents: outcome.incidents, db: classDurations(labelRunOwners(db, ownerLabel)) };
      return { ...scrubWorkers(scrubIds(relabelClocks(observed, isClockKey))), newRows, calls: counting?.calls ?? {}, agreement, __strip: ["newRows", "calls", "agreement"] };
    }));
  } finally { try { store?.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  requireNew(corpus, item, "emitted duration_ms equals the stored run_completed payload (exact)", proj.agreement.length === 0, `disagreements ${canon(proj.agreement)}`);
  const want = item.rows.map(([entry, verdict, reason, run]) => [entry, verdict, reason, run, null]);
  requireNew(corpus, item, "R3 rows (exact: entry, verdict, reason, the submitted run, tool_call null)", canon(proj.newRows) === canon(want), `got ${canon(proj.newRows)}, want ${canon(want)}`);
  requireNew(corpus, item, "recorder calls per entry (exact)", canon(proj.calls) === canon(item.calls), `got ${canon(proj.calls)}, want ${canon(item.calls)}`);
}

// Determinism self-test: the same item twice on the new build must project identically, or the old/new comparison would flag its own noise.
async function load(ctx) {
  const first = ITEMS.find((i) => i.key === "steer_awaiting_approval");
  const [a, b] = [await project(ctx.dists.new, first), await project(ctx.dists.new, first)];
  const diff = compare(corpus, first, a, b, corpus.pairs[0]); // the comparator's own view: stripped keys are not noise
  if (diff) throw new Error(`determinism self-test: two runs of one item project differently: ${diff.diff}`);
  return ITEMS;
}

const corpus = { name: "supervisor", pairs: [["r3", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required };
export default corpus;
