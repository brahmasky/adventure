// Slice R2 differential, sender corpus (spec 2026-11-01 R2 §6). Pair: r2 (the merge-base build) -> new. Every item drives the dist's own
// Telegram long-poll adapter (pollOnce) over synthetic updates on a fresh temp-file store, under a pinned env (P3) and a counting clock.
// Compared: the poll result, each emitted event, the acknowledgements, the offset and a whole-DB dump with the R2 decision rows removed
// (clocks relabelled by order, ids scrubbed). intake.sender rows are filtered by the harness (NEW_ROW_IDS.r2) and instead REQUIRED EXACTLY on
// the new side (each item's `expect`, plus the counting recorder's call count and the emitted-event count); the old build must hold none.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISTS, R2_IDS, canon, diffPaths, dumpDb, mkStore, mkTemp, regularTables, relabelClocks, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { FOREIGN_CHAT, OTHER, STRANGER, pollItem, senderUpdate as u, underPins } from "../stage4-sender-fixture.mjs";

// acks: acknowledgements sent (default 0; only Paco's malformed command earns one). expect: the denial reasons written, in order. emits: events handed to emit (positive evidence an allowed update got through).
const ITEMS = [
  { key: "channel_post", tags: ["channel_post"], updates: [u("channel_post", { id: 1 })], expect: ["channel_post"], emits: 0 },
  { key: "forwarded:date", tags: ["forwarded"], updates: [u("forward", { id: 2, forward: "date" })], expect: ["forwarded"], emits: 0 },
  { key: "forwarded:origin", tags: ["forwarded"], updates: [u("forward", { id: 3, forward: "origin" })], expect: ["forwarded"], emits: 0 },
  { key: "anonymous", tags: ["anonymous"], updates: [u("message", { id: 4, from: null })], expect: ["anonymous"], emits: 0 },
  { key: "user_not_allowlisted", tags: ["user_not_allowlisted"], updates: [u("message", { id: 5, from: STRANGER })], expect: ["user_not_allowlisted"], emits: 0 },
  { key: "chat_not_allowlisted", tags: ["chat_not_allowlisted"], updates: [u("message", { id: 6, chat: FOREIGN_CHAT })], expect: ["chat_not_allowlisted"], emits: 0 },
  { key: "identity_not_for_chat", tags: ["identity_not_for_chat"], updates: [u("message", { id: 7, from: OTHER })], expect: ["identity_not_for_chat"], emits: 0 },
  { key: "precedence:stranger_forward", tags: ["precedence"], updates: [u("forward", { id: 8, from: STRANGER, forward: "date" })], expect: ["forwarded"], emits: 0 },
  { key: "tap:stranger", tags: ["tap"], updates: [u("tap", { id: 9, from: STRANGER })], expect: ["user_not_allowlisted"], emits: 0 },
  { key: "tap:anonymous", tags: ["tap"], updates: [u("tap", { id: 10, from: null })], expect: ["anonymous"], emits: 0 },
  { key: "tap:foreign_chat", tags: ["tap"], updates: [u("tap", { id: 11, chat: FOREIGN_CHAT })], expect: ["chat_not_allowlisted"], emits: 0 },
  { key: "tap:wrong_identity", tags: ["tap"], updates: [u("tap", { id: 12, from: OTHER })], expect: ["identity_not_for_chat"], emits: 0 },
  { key: "tap:no_message", tags: ["not_sender"], updates: [u("tap", { id: 13, nomessage: true })], expect: [], emits: 0 },
  { key: "photo:stranger", tags: ["photo_denied"], mediaIngest: true, updates: [u("photo", { id: 14, from: STRANGER })], expect: ["user_not_allowlisted"], emits: 0 },
  { key: "allowed:text", tags: ["allowed"], updates: [u("message", { id: 15 })], expect: [], emits: 1 },
  { key: "allowed:photo", tags: ["allowed"], mediaIngest: true, updates: [u("photo", { id: 16 })], expect: [], emits: 1 },
  { key: "allowed:tap", tags: ["allowed"], updates: [u("tap", { id: 17 })], expect: [], emits: 1 },
  { key: "allowed:malformed", tags: ["not_sender"], updates: [u("malformed", { id: 18 })], expect: [], emits: 0, acks: 1 },
  { key: "batch", tags: ["batch"], updates: [u("message", { id: 19 }), u("message", { id: 20, from: STRANGER }), u("message", { id: 21 })], expect: ["user_not_allowlisted"], emits: 2 }
];
const BRANCHES = ["channel_post", "forwarded", "anonymous", "user_not_allowlisted", "chat_not_allowlisted", "identity_not_for_chat", "precedence", "tap", "not_sender", "photo_denied", "allowed", "batch"];

const all = (store, sql) => store.db.prepare(sql).all().map((r) => ({ ...r }));
const isClockKey = (k) => /(_at|_since|^since|^now)$/.test(k);
const idList = R2_IDS.map((i) => `'${i}'`).join(",");

// Coverage self-test: the dump must hold, per table, exactly the rows the DB holds (minus the intentionally dropped R2 decisions rows),
// counted by SQL count(*) over the same ordinary-table rule dumpDb uses (virtual tables and their shadows left out).
function tableCounts(store) {
  const counts = {};
  for (const { name } of regularTables(store)) {
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"${name === "decisions" ? ` WHERE entry_id NOT IN (${idList})` : ""}`).get().n;
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

async function project(d, item) {
  const dir = mkTemp(`sender-${item.key}`);
  let store = null;
  try {
    return await underPins(dir, async () => {
      store = mkStore(d, "bare", join(dir, "sender.sqlite")); // opened under the counting clock: schema_migrations.applied_at is a stamp too
      const seedMax = store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m; // an empty table gives NULL, and rowid > NULL selects nothing
      const isNew = d.dir === DISTS.new;
      const polled = await pollItem(d, store, item.updates, { recorder: isNew ? d.storeRecorder(store) : null, mediaIngest: item.mediaIngest === true });
      const newRows = all(store, `SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ${Number(seedMax)} AND entry_id IN (${idList}) ORDER BY rowid`)
        .map((r) => [r.entry_id, r.verdict, r.reason_code, r.run_id, r.tool_call_id]);
      if (!isNew && newRows.length) throw new Error("control failed: the old build wrote intake.sender / turn.contract rows");
      if (existsSync(join(process.cwd(), "houge.kill"))) throw new Error("P3 failed: a houge.kill appeared in the cwd");
      const db = dumpDb(store, { dropDecisionIds: R2_IDS });
      const want = tableCounts(store);
      checkCoverage(db, want);
      omittedRowSelfTest(db, want);
      const { result, emitted, acks, offset, calls } = polled;
      return { ...scrubIds(relabelClocks({ result, emitted, acks, offset, db }, isClockKey)), newRows, calls, emittedCount: emitted.length, ackCount: acks.length, __strip: ["newRows", "calls", "emittedCount", "ackCount"] };
    });
  } finally { try { store?.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  const want = item.expect.map((r) => ["intake.sender", "deny", r, null, null]);
  requireNew(corpus, item, "intake.sender rows (exact: entry, verdict, reason, run null, tool_call null)", canon(proj.newRows) === canon(want), `got ${canon(proj.newRows)}, want ${canon(want)}`);
  requireNew(corpus, item, "intake.sender record calls", (proj.calls["intake.sender"] ?? 0) === item.expect.length, `got ${proj.calls["intake.sender"] ?? 0}, want ${item.expect.length}`);
  requireNew(corpus, item, "emitted events (positive evidence)", proj.emittedCount === item.emits, `got ${proj.emittedCount}, want ${item.emits}`);
  requireNew(corpus, item, "acknowledgements (exact)", proj.ackCount === (item.acks ?? 0), `got ${proj.ackCount}, want ${item.acks ?? 0}`);
}

// Determinism self-test: the same item twice on the new build must project identically, or the old/new comparison would flag its own noise.
async function load(ctx) {
  const first = ITEMS.find((i) => i.key === "batch");
  const [a, b] = [await project(ctx.dists.new, first), await project(ctx.dists.new, first)];
  if (canon(a) !== canon(b)) throw new Error(`determinism self-test: two runs of one item project differently at ${diffPaths(a, b).slice(0, 3).map((p) => p.join(".")).join(", ")}`);
  return ITEMS;
}

const corpus = { name: "sender", pairs: [["r2", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required };
export default corpus;
