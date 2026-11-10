// Slice R2 differential, contract corpus (spec 2026-11-01 R2 §4.2, §6). Pair: r2 (the merge-base build ef4d0d1) -> new. Every item drives the dist's own
// Gateway.intake on a fresh temp-file store, under a pinned env (P3: kill writes a tombstone) and a counting clock. The new side's gateway gets a
// counting recorder (P6: calls counted by entry id; only turn.contract is asserted, the same recorder also sees intake.budget_fuse); the old build
// ignores the option. Compared: each intake result plus a whole-DB dump with the R2 decision rows removed (clocks relabelled by order, ids
// scrubbed). The R2 rows are filtered by the harness (NEW_ROW_IDS.r2) and REQUIRED EXACTLY on the new side: a restrict row's run_id is the run
// the item created (labelled run:<n> BEFORE scrubIds), a refusal's is null, and turn.contract is consulted once per fresh run or refusal and
// never for a fuse cycle or the second intake of a duplicate. The old build must hold no R2 row. The :contract_invalid outbox reply (the 2-A
// hotfix) is on BOTH builds, so it is compared, not filtered (P2).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DISTS, R2_IDS, canon, diffPaths, dumpDb, mkStore, mkTemp, regularTables, extraDropFilter, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { NOW, intakeEvent, seedAsk, withCountingClock, withPinnedEnv } from "../stage4-intake-fixture.mjs";
import { countingRecorder } from "../stage4-sender-fixture.mjs";

const WHO = { chat: "222", actor: "paco" };
const MEM_CHAT = "555";
const RESTRICT = ["restrict", "schedule_born", "run:0"]; // run:<n> = the run created by event n of the item
const REFUSE = (reason) => ["refuse", reason, null];
const turn = (key, goal = "synthetic", more = {}) => ({ key, goal, ...more });
const sched = (key, goal = "synthetic") => turn(key, goal, { source: "schedule" });
const run = (key, program, goal = "synthetic") => turn(key, goal, { type: "run", extra: { program } });

// Setup of tests/gateway/intake-decisions.test.ts P12: an original turn with its chat turn and a memory-lane verdict for a "Dig deeper" tap.
function seedMemLane(d, store, dir) {
  const seed = new d.Gateway(store).intake(intakeEvent(d, { chat: MEM_CHAT, actor: WHO.actor }, { key: "memlane-original", goal: "synthetic rule" }), NOW);
  if (!seed.ok) throw new Error("contract corpus: memory-lane seed turn refused");
  store.recordChatTurn({ chat_id: MEM_CHAT, run_id: seed.run_id, role: "user", text: "synthetic rule" });
  store.insertJevVerdict({ run_id: seed.run_id, category: "memory", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.95, rule_scope: "ask",
    lane: "memory", role: "default", effort: null, cascade: null, save_outcome: "saved", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
  return { original: seed.run_id, dataDir: dir };
}
const memLaneAsk = (d, ctx) => d.buildTypedTaskEvent({ source: "telegram", type: "memlane_ask", requested_by: { kind: "user", id: WHO.actor },
  notify: { kind: "telegram", chat_id: MEM_CHAT }, idempotency_key: "mla:1", source_reference: "mla:1",
  metadata: { telegram_update_id: 1, telegram_callback_id: "mla:1", run_id: ctx.original } });

// rows: the turn.contract rows expected, in order. calls: the exact turn.contract consultations of each intake, in order. events: turn() specs or (d, ctx) => event.
const ITEMS = [
  { key: "telegram_turn", tags: ["compile"], events: [turn("a")], rows: [], calls: [1] },
  { key: "scheduled_turn", tags: ["restrict"], events: [sched("s:1")], rows: [RESTRICT], calls: [1] },
  { key: "duplicate", tags: ["duplicate"], events: [sched("s:2"), sched("s:2")], rows: [RESTRICT], calls: [1, 0] },
  { key: "fuse", tags: ["fuse"], caps: { runs: 0 }, events: [sched("s:3"), sched("s:3")], rows: [], calls: [0, 0] },
  { key: "ask", tags: ["compile"], events: [turn("a", "synthetic question", { type: "ask", extra: { program: "ask" } })], rows: [], calls: [1] },
  { key: "run:research-brief", tags: ["compile_other"], events: [run("a", "research-brief")], rows: [], calls: [1] },
  { key: "run:web-research", tags: ["compile_other"], events: [run("a", "web-research")], rows: [], calls: [1] },
  { key: "empty_telegram", tags: ["goal_missing"], events: [turn("a", " ")], rows: [REFUSE("goal_missing")], calls: [1] },
  { key: "empty_scheduled", tags: ["goal_missing"], events: [sched("s:4", " ")], rows: [REFUSE("goal_missing")], calls: [1] },
  { key: "run:nosuch", tags: ["unknown_program"], events: [run("a", "nosuch")], rows: [REFUSE("unknown_program")], calls: [1] },
  { key: "unsupported_type", tags: ["unsupported_type"], events: [turn("a", "synthetic", { type: "bogus" })], rows: [REFUSE("unsupported_type")], calls: [1] },
  { key: "via_rating", tags: ["via_rating"], setup: (d, s) => seedAsk(s, WHO, NOW, 10, true), events: [turn("a", "2，synthetic")], rows: [], calls: [1] },
  { key: "via_memlane", tags: ["via_memlane"], setup: seedMemLane, events: [memLaneAsk], rows: [], calls: [1] }
];
const BRANCHES = ["compile", "restrict", "duplicate", "fuse", "compile_other", "goal_missing", "unknown_program", "unsupported_type", "via_rating", "via_memlane"];

const all = (store, sql) => store.db.prepare(sql).all().map((r) => ({ ...r }));
const isClockKey = (k) => /(_at|_since|^since|^now)$/.test(k);
const idList = R2_IDS.map((i) => `'${i}'`).join(",");

// Coverage self-test: the dump must hold, per table, exactly the rows the DB holds (minus the intentionally dropped R2 decisions rows),
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

/** "run:<n>" when the row sits on the run event n created, else the raw id (so a row on the wrong run never matches); null stays null. */
const runLabel = (results, runId) => { if (runId === null) return null; const n = results.findIndex((r) => r.ok && r.run_id === runId); return n >= 0 ? `run:${n}` : runId; };

/** The old Gateway constructor has one more positional parameter than the new one (length 5 vs 4): put the options object where the loaded build expects it. */
const gatewayPad = (m, options) => (m.Gateway.length >= 5 ? [undefined, options] : [options]);
function runEvents(d, store, item, ctx, recorder) {
  const caps = { ...d.DEFAULT_GLOBAL_BUDGET_CAPS, ...item.caps };
  const gateway = new d.Gateway(store, caps, undefined, undefined, ...gatewayPad(d, { ...(ctx?.dataDir ? { dataDir: ctx.dataDir } : {}), ...(recorder ? { decisionRecorder: recorder.recorder } : {}) }));
  const perIntake = []; // turn.contract consultations made by each intake (the live tally's delta around it)
  const results = item.events.map((e) => {
    const before = recorder?.calls["turn.contract"] ?? 0;
    const out = gateway.intake(typeof e === "function" ? e(d, ctx) : intakeEvent(d, WHO, e), NOW); // Gateway.intake returns error results and never throws
    perIntake.push((recorder?.calls["turn.contract"] ?? 0) - before);
    return out;
  });
  return { results, perIntake };
}

async function project(d, item) {
  const dir = mkTemp(`contract-${item.key}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  let store = null;
  try {
    return await withPinnedEnv(join(dir, "pin"), () => withCountingClock(NOW, () => {
      mkdirSync(join(dir, "pin"), { recursive: true });
      store = mkStore(d, "bare", join(dir, "contract.sqlite")); // opened under the counting clock: schema_migrations.applied_at is a stamp too
      const ctx = item.setup?.(d, store, join(dir, "data"));
      const seedMax = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m; // an empty table gives NULL, and rowid > NULL selects nothing
      const isNew = d.dir === DISTS.new;
      const counting = isNew ? countingRecorder(d.storeRecorder(store)) : null;
      const { results, perIntake } = runEvents(d, store, item, ctx, counting ?? null);
      const rows = all(store, `SELECT entry_id, verdict, reason_code, run_id FROM decisions WHERE rowid > ${Number(seedMax)} AND entry_id IN (${idList}) ORDER BY rowid`);
      if (!isNew && rows.length) throw new Error("control failed: the old build wrote turn.contract / intake.sender rows");
      const newRows = rows.map((r) => [r.entry_id, r.verdict, r.reason_code, runLabel(results, r.run_id)]);
      const db = dumpDb(store, { dropDecisionIds: R2_IDS });
      const want = tableCounts(store);
      checkCoverage(db, want);
      omittedRowSelfTest(db, want);
      return { ...scrubIds(relabelClocks({ results, db }, isClockKey)), newRows, calls: counting?.calls ?? {}, perIntake, __strip: ["newRows", "calls", "perIntake"] };
    }));
  } finally { try { store?.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  const want = item.rows.map((r) => ["turn.contract", ...r]);
  requireNew(corpus, item, "turn.contract rows (exact: entry, verdict, reason, run label; refusals null)", canon(proj.newRows) === canon(want), `got ${canon(proj.newRows)}, want ${canon(want)}`);
  requireNew(corpus, item, "turn.contract consultations per intake (exact)", canon(proj.perIntake) === canon(item.calls), `got ${canon(proj.perIntake)}, want ${canon(item.calls)}`);
}

// Determinism self-test: the same item twice on the new build must project identically, or the old/new comparison would flag its own noise.
async function load(ctx) {
  const first = ITEMS.find((i) => i.key === "scheduled_turn");
  const [a, b] = [await project(ctx.dists.new, first), await project(ctx.dists.new, first)];
  if (canon(a) !== canon(b)) throw new Error(`determinism self-test: two runs of one item project differently at ${diffPaths(a, b).slice(0, 3).map((p) => p.join(".")).join(", ")}`);
  return ITEMS;
}

const corpus = { name: "contract", pairs: [["r2", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required };
export default corpus;
