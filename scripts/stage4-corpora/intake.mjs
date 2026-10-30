// Slice R1 differential, intake corpus (spec 2026-10-30 R1 §6). Pair: r1 (the merge-base build) -> new. Every item drives the dist's own
// Gateway.intake on a fresh temp-file store, under a pinned env (kill writes a tombstone, P1) and a counting clock (P2). Compared: each
// intake result plus a whole-DB dump with the three intake.* decision rows removed, clocks relabelled by order, ids scrubbed. The intake.*
// rows are filtered by the harness (NEW_ROW_IDS.r1) and instead REQUIRED on the new side (each item's `expect`); the old build must hold none.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DISTS, INTAKE_IDS, canon, diffPaths, dumpDb, mkStore, mkTemp, regularTables, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { NOW, intakeEvent, saturateWindow, seedActiveRuns, seedAsk, seedPendingApprovals, withCountingClock, withPinnedEnv } from "../stage4-intake-fixture.mjs";

const WHO = { chat: "222", actor: "paco" };
const EXEMPT = ["kill", "decision_review", "improvement_tap", "jev_accept_tap"];
const RL = (reason) => ["intake.rate_limit", "limit", reason];
const RR = (verdict, reason) => ["intake.rating_reply", verdict, reason];
const BF = (reason) => ["intake.budget_fuse", "refuse", reason];
const turn = (key, goal = "synthetic", more = {}) => ({ key, goal, ...more });
const ask = (minutes = 10, active = true) => (d, store) => seedAsk(store, WHO, NOW, minutes, active);
const minus = (m) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

// A routed verdict for the chat's latest turn, so a rating of 0 has something to label (the store method tests/gateway/rating-capture.test.ts uses).
function seedRoutedVerdict(d, store) {
  const turnRun = new d.Gateway(store).intake(intakeEvent(d, WHO, { key: "seed-turn" }), minus(50));
  if (!turnRun.ok) throw new Error("intake corpus: seed turn refused");
  store.insertJevVerdict({ run_id: turnRun.run_id, category: "lookup", breadth: 1, reasoning: 1, actions: 1, sets_rule: 0.05, rule_scope: null, lane: "planner",
    role: "fast", effort: "low", cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null, created_at: minus(50) });
}

const RATING = [["3", "consume", "consume", "bare_digit"], ["2，synthetic", "forward", "forward", "digit_comment"], ["0 synthetic", "forward", "forward", "digit_comment"],
  ["1.synthetic", "forward", "forward", "digit_comment"], ["synthetic ordinary sentence", "lapse", "lapse", "not_rating"]];
const NO_ASK = [["expired", ask(200)], ["inactive", ask(10, false)], ["none", () => {}]];

const ITEMS = [
  ...[[5, "command_window", [RL("command_window")]], [4, "under", []]].map(([n, tag, expect]) => ({ key: `window:${n}`, tags: ["command_window", ...(tag === "under" ? ["under"] : [])],
    setup: (d, s) => saturateWindow(s, WHO, "turn", n, NOW), events: [turn("a")], expect })),
  ...[[3, [RL("active_runs")]], [2, []]].map(([n, expect]) => ({ key: `active_runs:${n}`, tags: ["active_runs", ...(expect.length ? [] : ["under"])],
    setup: (d, s) => seedActiveRuns(d, s, WHO, n, NOW), events: [turn("a")], expect })),
  ...[[5, [RL("pending_approvals")]], [4, []]].map(([n, expect]) => ({ key: `pending_approvals:${n}`, tags: ["pending_approvals", ...(expect.length ? [] : ["under"])],
    setup: (d, s) => seedPendingApprovals(d, s, WHO, n, NOW), events: [turn("a")], expect })),
  ...EXEMPT.map((cmd) => ({ key: `exempt:${cmd}`, tags: ["exempt"], setup: (d, s) => saturateWindow(s, WHO, "turn", 5, NOW), events: [turn("a", "synthetic", { type: cmd })], expect: [] })),
  // kill is absent from the SQL NOT IN on purpose: its accepted rows count toward the window; the three taps' never do.
  ...EXEMPT.map((cmd) => ({ key: `exempt_count:${cmd}`, tags: ["exempt_count"], setup: (d, s) => saturateWindow(s, WHO, cmd, 5, NOW), events: [turn("a")], expect: cmd === "kill" ? [RL("command_window")] : [] })),
  { key: "schedule:saturated", tags: ["schedule"], setup: (d, s) => saturateWindow(s, WHO, "turn", 5, NOW), events: [turn("a", "synthetic", { source: "schedule" })], expect: [] },
  ...RATING.map(([goal, tag, verdict, reason], i) => ({ key: `rating:${i}:${verdict}`, tags: [tag === "consume" ? "consume" : tag], setup: ask(), events: [turn("a", goal)], expect: [RR(verdict, reason)] })),
  { key: "rating:low", tags: ["low"], setup: (d, s) => { seedRoutedVerdict(d, s); ask()(d, s); }, events: [turn("a", "0")], expect: [RR("consume", "bare_digit")] },
  ...NO_ASK.map(([n, setup]) => ({ key: `no_ask:${n}`, tags: ["no_ask"], setup, events: [turn("a", "3")], expect: [] })),
  { key: "no_ask:schedule", tags: ["no_ask"], setup: ask(), events: [turn("a", "3", { source: "schedule" })], expect: [] },
  { key: "replay:digit", tags: ["replay"], setup: ask(), events: [turn("a", "3"), turn("a", "3")], expect: [RR("consume", "bare_digit")] },
  { key: "replay:comment", tags: ["replay"], setup: ask(), events: [turn("a", "2，synthetic"), turn("a", "2，synthetic")], expect: [RR("forward", "digit_comment")] },
  { key: "conflict", tags: ["conflict"], setup: ask(), events: [turn("a", "3"), turn("a", "2")], expect: [RR("consume", "bare_digit")] },
  ...[["runs", { runs: 0 }, "runs"], ["tool_calls", { tool_calls: 0 }, "tool_calls"], ["gated_attempts", { gated_attempts: 0 }, "gated_attempts"]].map(([n, caps, reason]) => ({
    key: `fuse:${n}`, tags: ["fuse"], caps, events: [turn("a")], expect: [BF(reason)] })),
  { key: "fuse:two", tags: ["fuse_multi"], caps: { tool_calls: 0, gated_attempts: 0 }, events: [turn("a")], expect: [BF("tool_calls")] },
  { key: "fuse:under", tags: ["under"], events: [turn("a")], expect: [] },
  { key: "fuse:repeat", tags: ["fuse_repeat"], caps: { runs: 0 }, events: [turn("a"), turn("b")], expect: [BF("runs"), BF("runs")] },
  { key: "fuse:schedule", tags: ["schedule"], caps: { runs: 0 }, events: [turn("a", "synthetic", { source: "schedule" })], expect: [BF("runs")] }
];
const BRANCHES = ["command_window", "active_runs", "pending_approvals", "under", "exempt", "exempt_count", "schedule", "consume", "forward", "lapse", "low", "no_ask", "replay", "conflict", "fuse", "fuse_multi", "fuse_repeat"];

const all = (store, sql) => store.db.prepare(sql).all().map((r) => ({ ...r }));
// A payload_hash is stableHash(payload) (run-store.ts enqueueNotification). When the payload carries a random id (an approval prompt names its
// appr_<uuid>) the digest differs run to run for the same behaviour. For those rows the digest is RECOMPUTED with that dist's own stableHash
// over the stored payload: if it equals the stored hash it is replaced by a marker (the hash is proved to be exactly the hash of its payload,
// and the payload is compared after id scrubbing); if not, the raw value stays, so the mismatch shows as a difference.
const RANDOM_ID = /\b[a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
function hashOk(d, r) {
  try { return d.stableHash(JSON.parse(r.payload_json)) === r.payload_hash; } catch { return false; }
}
const maskIdHashes = (d, db) => Object.fromEntries(Object.entries(db).map(([t, rows]) => [t, rows.map((r) =>
  typeof r.payload_hash === "string" && RANDOM_ID.test(String(r.payload_json)) && hashOk(d, r) ? { ...r, payload_hash: "hash-of-payload-ok" } : r)]));
const isClockKey = (k) => /(_at|_since|^since|^now)$/.test(k);

// Coverage self-test: the dump must hold, per table, exactly the rows the DB holds (minus the intentionally dropped intake decisions rows),
// counted by SQL count(*) over the same ordinary-table rule dumpDb uses (virtual tables and their shadows left out).
function tableCounts(store) {
  const ids = INTAKE_IDS.map((i) => `'${i}'`).join(",");
  const counts = {};
  for (const { name } of regularTables(store)) {
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${name === "decisions" ? ` WHERE entry_id NOT IN (${ids})` : ""}`).get().n;
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

function runEvents(d, store, item) {
  const caps = { ...d.DEFAULT_GLOBAL_BUDGET_CAPS, ...item.caps };
  const gateway = new d.Gateway(store, caps);
  return item.events.map((e) => gateway.intake(intakeEvent(d, WHO, e), NOW)); // a throw fails the item: Gateway.intake returns error results and never throws
}

// The pinned env dir (tombstone / disarm paths) is the SAME path for the old and the new side of an item: kill's reply text and its payload_hash carry it.
let pinRoot = null;
function pinnedDir(item) {
  pinRoot ??= mkTemp("intake-pin");
  const dir = join(pinRoot, item.key.replace(/[^\w.-]/g, "_"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function project(d, item) {
  const dir = mkTemp(`intake-${item.key}`);
  let store = null;
  try {
    return await withPinnedEnv(pinnedDir(item), () => withCountingClock(NOW, () => {
      store = mkStore(d, "bare", join(dir, "intake.sqlite")); // opened under the counting clock: schema_migrations.applied_at is a stamp too
      item.setup?.(d, store);
      const seedMax = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m; // P11: an empty table gives NULL, and rowid > NULL selects nothing
      const results = runEvents(d, store, item);
      const intake = all(store, `SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ${Number(seedMax)} ORDER BY rowid`);
      if (d.dir !== DISTS.new && intake.some((r) => INTAKE_IDS.includes(r.entry_id))) throw new Error("control failed: the old build wrote intake.* rows");
      const db = dumpDb(store, { dropDecisionIds: INTAKE_IDS });
      const want = tableCounts(store);
      checkCoverage(db, want);
      omittedRowSelfTest(db, want);
      return { ...scrubIds(relabelClocks({ results, db: maskIdHashes(d, db) }, isClockKey)), intake, __strip: ["intake"] };
    }));
  } finally { try { store?.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  const got = proj.intake.map((r) => [r.entry_id, r.verdict, r.reason_code, r.run_id, r.tool_call_id]);
  const want = item.expect.map((r) => [...r, null, null]);
  requireNew(corpus, item, "intake decision rows", canon(got) === canon(want), `got ${canon(got)}, want ${canon(want)}`);
}

// Determinism self-test (P2): the same item twice on the new build must project identically, or the old/new comparison would flag its own noise.
async function load(ctx) {
  const first = ITEMS.find((i) => i.key.startsWith("rating:"));
  const [a, b] = [await project(ctx.dists.new, first), await project(ctx.dists.new, first)];
  if (canon(a) !== canon(b)) throw new Error(`determinism self-test: two runs of one item project differently at ${diffPaths(a, b).slice(0, 3).map((p) => p.join(".")).join(", ")}`);
  return ITEMS;
}

const corpus = { name: "intake", pairs: [["r1", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required };
export default corpus;
