// Stage 4C differential, schedule_task admit corpus (spec 2026-10-30 §4.2, §6). Pair: s4b -> new. Every item runs the dist's own
// CoreWorker schedule_task adapter (scripts/stage4-admit-fixture.mjs) on a fresh temp-file store, under a fixed clock.
// Compared: each call's tool result, the run's ledger events, scheduled_tasks rows and decisions. schedule.admit rows are filtered by the
// harness (NEW_ROW_IDS.s4b) and instead REQUIRED on the new side (the table below); the old side must hold none (checked in project).
import { join } from "node:path";
import { DISTS, mkStore, mkTemp, requireNew } from "../stage4-diff-lib.mjs";
import { scrubIds } from "../stage4-bind-fixture.mjs";
import { scheduleRun, withFixedClock } from "../stage4-admit-fixture.mjs";

const SPEC = { kind: "daily", at: "08:00" };
const TZ = "Australia/Sydney";
const MISSING = "sch_00000000-0000-4000-8000-000000000000";
const SPEC_JSON = '{"kind":"daily","at":"08:00"}';
const NF = ["refuse", "not_found"];
const NC = ["refuse", "no_chat"];
const mk = (goal) => ({ spec: SPEC, goal, tz: TZ });

// seeds: [chat, goal, disabled?]; ids[i] is seed i's schedule_id. calls: ids -> tool inputs, in order. expect: [verdict, reason_code] per recorded row.
// Rows are listed by the verdict the spec names; an admit's reason_code is its verb.
const ITEMS = [
  ...["list", "create", "cancel", "update"].map((v) => ({ key: `no_chat:${v}`, tags: ["no_chat"], kind: "cli", seeds: [],
    calls: () => [v === "list" ? { list: true } : v === "create" ? mk("g") : v === "cancel" ? { cancel: MISSING } : { update: MISSING, goal: "x" }], expect: [NC] })),
  ...[["bad_shape", () => "abc"], ["missing", () => MISSING], ["other_chat", (ids) => ids[1]], ["disabled", (ids) => ids[2]]].flatMap(([n, pick]) => [
    { key: `cancel:${n}`, tags: ["not_found"], seeds: [["555", "mine"], ["999", "theirs"], ["555", "gone", true]], calls: (ids) => [{ cancel: pick(ids) }], expect: [NF] },
    { key: `update:${n}`, tags: ["not_found"], seeds: [["555", "mine"], ["999", "theirs"], ["555", "gone", true]], calls: (ids) => [{ update: pick(ids), goal: "x" }], expect: [NF] }
  ]),
  { key: "cancel:store_refused", tags: ["not_found"], seeds: [["555", "mine"]], stub: "cancelScheduledTask", calls: (ids) => [{ cancel: ids[0] }], expect: [NF] },
  { key: "update:store_refused", tags: ["not_found"], seeds: [["555", "mine"]], stub: "updateScheduledTask", calls: (ids) => [{ update: ids[0], goal: "late" }], expect: [NF] },
  { key: "update:empty", tags: ["validation"], seeds: [["555", "mine"]], calls: (ids) => [{ update: ids[0] }], expect: [] },
  { key: "update:bad_goal", tags: ["validation"], seeds: [["555", "mine"]], calls: (ids) => [{ update: ids[0], goal: "x".repeat(2001) }], expect: [] },
  { key: "update:bad_spec", tags: ["validation"], seeds: [["555", "mine"]], calls: (ids) => [{ update: ids[0], spec: { kind: "nonsense" } }], expect: [] },
  { key: "update:bad_tz", tags: ["validation"], seeds: [["555", "mine"]], calls: (ids) => [{ update: ids[0], tz: "Not/AZone" }], expect: [] },
  { key: "create:new", tags: ["admit"], seeds: [], calls: () => [mk("daily brief")], expect: [["admit", "create"]] },
  { key: "create:duplicate", tags: ["exists"], seeds: [], calls: () => [mk("daily brief"), mk("daily brief")], expect: [["admit", "create"], ["exists", "create"]] },
  { key: "create:cap", tags: ["cap"], cap: 1, seeds: [["555", "already"]], calls: () => [mk("another")], expect: [["refuse", "cap"]] },
  { key: "create:bad_spec", tags: ["validation"], seeds: [], calls: () => [{ spec: { kind: "nonsense" }, goal: "x", tz: TZ }], expect: [] },
  { key: "create:bad_tz", tags: ["validation"], seeds: [], calls: () => [{ spec: SPEC, goal: "x", tz: "Not/AZone" }], expect: [] },
  { key: "create:bad_goal", tags: ["validation"], seeds: [], calls: () => [{ spec: SPEC, goal: "", tz: TZ }], expect: [] },
  { key: "create:goal_too_long", tags: ["validation"], seeds: [], calls: () => [mk("x".repeat(2001))], expect: [] },
  { key: "cancel:own", tags: ["admit"], seeds: [["555", "mine"]], calls: (ids) => [{ cancel: ids[0] }], expect: [["admit", "cancel"]] },
  { key: "update:own", tags: ["admit"], seeds: [["555", "mine"]], calls: (ids) => [{ update: ids[0], goal: "new goal" }], expect: [["admit", "update"]] },
  { key: "list", tags: ["list"], seeds: [["555", "mine"]], calls: () => [{ list: true }], expect: [] },
  ...[["cancel+update", (i) => ({ cancel: i, update: i, goal: "x" }), [["admit", "cancel"]]],
    ["cancel+create", (i) => ({ cancel: i, ...mk("x") }), [["admit", "cancel"]]],
    ["update+create", (i) => ({ update: i, ...mk("x") }), [["admit", "update"]]],
    ["list+cancel", (i) => ({ list: true, cancel: i }), []],
    ["list+update", (i) => ({ list: true, update: i, goal: "x" }), []],
    ["list+create", (i) => ({ list: true, ...mk("x") }), []]].map(([n, input, expect]) => ({ key: `precedence:${n}`, tags: ["precedence"], seeds: [["555", "mine"]], calls: (ids) => [input(ids[0])], expect }))
];

const BRANCHES = ["no_chat", "not_found", "validation", "admit", "exists", "cap", "list", "precedence"];
const rows = (store, sql) => store.db.prepare(sql).all().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => {
  if (!k.endsWith("_json") || typeof v !== "string") return [k, v];
  try { return [k, JSON.parse(v)]; } catch { return [k, v]; }
})));

function seed(store, [chat_id, goal, disabled]) {
  const row = store.addScheduledTask({ chat_id, goal, now: "2026-10-08T00:00:00.000Z", spec_json: SPEC_JSON, tz: TZ, next_run_at: "2099-01-01T00:00:00.000Z" });
  if (disabled) store.cancelScheduledTask(row.schedule_id);
  return row.schedule_id;
}

async function project(d, item) {
  const store = mkStore(d, "bare", join(mkTemp(`schedule-${item.key}`), "schedule.sqlite"));
  const ids = item.seeds.map((s) => seed(store, s));
  const run = scheduleRun(d, store, item.kind ?? "telegram", { cap: item.cap });
  try {
    if (item.stub) store[item.stub] = () => false; // the store refuses after the shape and ownership checks passed (a late refusal)
    const results = [];
    await withFixedClock(async () => { for (const input of item.calls(ids)) results.push(await run.call(input)); });
    const decisions = rows(store, `SELECT entry_id, tool_call_id, stage, rung, verdict, reason_code, armed_mode, fallback_reason FROM decisions ORDER BY rowid`);
    if (d.dir !== DISTS.new && decisions.some((r) => r.entry_id === "schedule.admit")) throw new Error("control failed: the old build wrote schedule.admit rows");
    const view = { results, ledger: rows(store, `SELECT event_type, actor, sequence, payload_json FROM ledger_events ORDER BY rowid`),
      scheduled_tasks: rows(store, `SELECT * FROM scheduled_tasks ORDER BY rowid`), decisions };
    return scrubIds(view, [run.root]);
  } finally { run.close(); try { store.close(); } catch { /* closed */ } }
}

function required(d, item, proj) {
  const got = proj.decisions.filter((r) => r.entry_id === "schedule.admit").map((r) => [r.verdict, r.reason_code]);
  requireNew(corpus, item, "schedule.admit rows", JSON.stringify(got) === JSON.stringify(item.expect), `got ${JSON.stringify(got)}, want ${JSON.stringify(item.expect)}`);
  const other = proj.decisions.filter((r) => r.entry_id !== "schedule.admit");
  requireNew(corpus, item, "no other decision rows", other.length === 0, [...new Set(other.map((r) => r.entry_id))].join(","));
}

const corpus = { name: "schedule", pairs: [["s4b", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, async load() { return ITEMS; }, project, required };
export default corpus;
