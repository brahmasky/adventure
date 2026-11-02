import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_CATCH_UP } from "../../src/decisions/entries/context-catch-up.js";
import { CONTEXT_RECALL, type RecallInput } from "../../src/decisions/entries/context-recall.js";
import { TURN_CLARIFY_CAP } from "../../src/decisions/entries/turn-clarify-cap.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import {
  buildTurnPrompt, CATCH_UP_OPEN, CLARIFY_CAP_NOTICE, lessonsInputOf, type PromptSnapshot, type TurnContextDeps, type TurnPromptInput, type TurnRetrieval
} from "../../src/omp/turn-context.js";
import { RunStore } from "../../src/run/run-store.js";
import type { RetrievalTelemetry } from "../../src/run/relevance-gate.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const CHAT = "555";
const R5 = "('context.recall','context.catch_up','context.lessons','turn.clarify_cap')";
type Row = [string, string, string | null, string, string | null];
type Q = { prepare(q: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
const q = (store: RunStore) => (store as unknown as { db: Q }).db;
function rows(store: RunStore): Row[] {
  return q(store).prepare(`SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id IN ${R5} ORDER BY rowid`).all()
    .map((r) => [r.entry_id as string, r.verdict as string, (r.reason_code as string | null) ?? null, r.run_id as string, (r.tool_call_id as string | null) ?? null]);
}
const loopStarted = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).find((e) => e.event_type === "loop_started")?.payload;

const NOW = () => new Date("2026-09-30T05:00:00.000Z");
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

const tel = (over: Partial<RetrievalTelemetry> = {}): RetrievalTelemetry => ({ admitted: 0, best_admitted: null, best_rejected: null, embedding: true, fts_only: false, ...over });
const NONE: TurnRetrieval = { facts: [], pages: [] };

/** TurnContextDeps over `store` with a counting storeRecorder (omit it with `recorder: undefined` for the raw twin). */
function deps(store: RunStore, over: Partial<TurnContextDeps> & { retrieval?: TurnRetrieval } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "hcd-")); dirs.push(dataDir);
  const counts: Record<string, number> = {};
  const inner = storeRecorder(store);
  const recorder: DecisionRecorder = { record: (e, r, c) => { counts[e.id] = (counts[e.id] ?? 0) + 1; return inner.record(e, r, c); } };
  const { retrieval, ...rest } = over;
  const d: TurnContextDeps = {
    store, memoryRoot: new URL("../../memory", import.meta.url).pathname, dataDir, skillsReader: () => undefined, coreBlock: () => undefined,
    retrieve: async () => retrieval ?? NONE, env: {}, now: NOW, recorder, ...rest
  };
  return { d, counts };
}
async function build(d: TurnContextDeps, store: RunStore, over: Partial<TurnPromptInput> = {}) {
  const run_id = createQueuedTurnRun(store, "the pdf one");
  const built = await buildTurnPrompt(d, { run_id, chat_id: CHAT, message: "the pdf one", source: "telegram", ...over });
  return { ...built, run_id };
}
/** The raw answer drives: the same store state, a deps object without a recorder, must build the same prompt text. */
async function sameAsRaw(store: RunStore, over: Partial<TurnContextDeps> & { retrieval?: TurnRetrieval }, input: Partial<TurnPromptInput> = {}) {
  const { d, counts } = deps(store, over);
  const withR = await build(d, store, input);
  const { d: raw } = deps(store, over); delete (raw as { recorder?: unknown }).recorder;
  const without = await build(raw, store, input);
  expect(withR.prompt).toBe(without.prompt);
  return { ...withR, counts };
}
const facts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, block: `fact ${i + 1}` }));
const seedClarify = (store: RunStore, then?: "loop") => {
  store.recordChatTurn({ chat_id: CHAT, run_id: "r0", role: "user", text: "fix the file", created_at: "2026-09-30T04:58:00.000Z" });
  store.recordChatTurn({ chat_id: CHAT, run_id: "r0", role: "assistant", text: "Which file do you mean?", intent: "clarify", created_at: "2026-09-30T04:58:30.000Z" });
  if (then) store.recordChatTurn({ chat_id: CHAT, run_id: "r1", role: "assistant", text: "Done.", intent: then, created_at: "2026-09-30T04:59:00.000Z" });
};
const at = (m: number) => new Date(Date.parse("2026-09-30T04:00:00.000Z") + m * 60_000).toISOString();
/** A delivered lane reply row (verdict_id null is accepted by laneTurnsSince's LEFT JOIN); no planner answer → every row is "since". */
const laneRow = (store: RunStore, k: number, catch_up = `Houge replied: a${k}`) =>
  store.recordLaneReply({ run_id: `lane-${k}`, chat_id: CHAT, lane: "answer", verdict_id: null, catch_up, created_at: at(k) });

describe("R5 rows at prompt build (spec R5 §4.1, §4.2, §4.4) — the raw answer drives, exact rows", () => {
  it("1 two facts with telemetry → include/embedded on the run; calls recall 1, cap 1", async () => {
    const store = RunStore.openInMemory();
    const retrieval: TurnRetrieval = { facts: facts(2), pages: [], telemetry: { facts: tel({ admitted: 2, best_admitted: 0.7, best_rejected: 0.2 }), pages: tel() } };
    const r = await sameAsRaw(store, { retrieval });
    expect(r.prompt).toContain("[context]");
    expect(rows(store)).toEqual([["context.recall", "include", "embedded", r.run_id, null]]);
    expect(r.counts).toEqual({ "context.recall": 1, "turn.clarify_cap": 1 });
  });
  it("2 no telemetry (both flags off) → no recall call; the cap still consulted", async () => {
    const store = RunStore.openInMemory();
    const r = await sameAsRaw(store, { retrieval: NONE });
    expect(rows(store)).toEqual([]); expect(r.counts).toEqual({ "turn.clarify_cap": 1 });
  });
  it("3 the none reasons: embed_failed, dropped_after_gate (facts side), below_gate (pages side), unscored", async () => {
    const cases: Array<[TurnRetrieval, string]> = [
      [{ ...NONE, telemetry: { facts: tel({ embedding: false }), pages: tel({ embedding: false }) } }, "embed_failed"],
      [{ ...NONE, telemetry: { facts: tel({ best_admitted: 0.8 }), pages: tel() } }, "dropped_after_gate"],
      [{ ...NONE, telemetry: { facts: tel(), pages: tel({ best_rejected: 0.3 }) } }, "below_gate"],
      [{ ...NONE, telemetry: { facts: tel(), pages: tel() } }, "unscored"]
    ];
    for (const [retrieval, reason] of cases) {
      const store = RunStore.openInMemory();
      const r = await sameAsRaw(store, { retrieval });
      expect(r.prompt).not.toContain("[context]");
      expect(rows(store), reason).toEqual([["context.recall", "none", reason, r.run_id, null]]);
    }
  });
  it("3b the recorded recall input, read at the real entry's rule: pages-only admit, pages-side best, max of the two sides, facts-side embedding", async () => {
    const page = [{ id: 7, block: "page 7" }];
    const cases: Array<[string, TurnRetrieval, string, string, RecallInput]> = [
      ["pages-only admit", { facts: [], pages: page, telemetry: { facts: tel(), pages: tel({ admitted: 1, best_admitted: 0.6 }) } }, "include", "embedded",
        { embedding: true, facts: 0, pages: 1, best_admitted: 0.6, best_rejected: null }],
      ["pages-side dropped", { ...NONE, telemetry: { facts: tel(), pages: tel({ best_admitted: 0.8 }) } }, "none", "dropped_after_gate",
        { embedding: true, facts: 0, pages: 0, best_admitted: 0.8, best_rejected: null }],
      ["max of the sides", { ...NONE, telemetry: { facts: tel({ best_admitted: 0.4, best_rejected: 0.3 }), pages: tel({ best_admitted: 0.8, best_rejected: 0.1 }) } }, "none", "dropped_after_gate",
        { embedding: true, facts: 0, pages: 0, best_admitted: 0.8, best_rejected: 0.3 }],
      ["facts-side embedding", { ...NONE, telemetry: { facts: tel({ embedding: true }), pages: tel({ embedding: false }) } }, "none", "unscored",
        { embedding: true, facts: 0, pages: 0, best_admitted: null, best_rejected: null }]
    ];
    const rung = CONTEXT_RECALL.ladder[0] as { decide: (s: RecallInput) => unknown }; const orig = rung.decide;
    for (const [label, retrieval, verdict, reason, input] of cases) {
      const store = RunStore.openInMemory();
      const seen: RecallInput[] = [];
      rung.decide = (s) => { seen.push({ ...s }); return orig(s); };
      let r: Awaited<ReturnType<typeof sameAsRaw>>;
      try { r = await sameAsRaw(store, { retrieval }); } finally { rung.decide = orig; }
      expect(seen, label).toEqual([input]);
      expect(rows(store), label).toEqual([["context.recall", verdict, reason, r.run_id, null]]);
      if (verdict === "include") expect(r.prompt, label).toContain("page 7");
    }
  });
  it("4 catch-up: all, entry_capped, trimmed, all_trimmed, read_failed; schedule and no-rows are not consults", async () => {
    let store = RunStore.openInMemory(); laneRow(store, 1); laneRow(store, 2);
    let r = await sameAsRaw(store, {});
    expect(r.prompt).toContain(CATCH_UP_OPEN); expect(rows(store)).toEqual([["context.catch_up", "inject", "all", r.run_id, null]]);
    expect(r.counts).toEqual({ "context.catch_up": 1, "turn.clarify_cap": 1 });
    store = RunStore.openInMemory(); for (let k = 1; k <= 8; k++) laneRow(store, k);
    r = await sameAsRaw(store, {}); expect(rows(store)).toEqual([["context.catch_up", "inject", "entry_capped", r.run_id, null]]);
    store = RunStore.openInMemory(); for (let k = 1; k <= 3; k++) laneRow(store, k, `Houge replied: ${"x".repeat(900)}`);
    r = await sameAsRaw(store, {}); expect(rows(store)).toEqual([["context.catch_up", "inject", "trimmed", r.run_id, null]]);
    store = RunStore.openInMemory(); laneRow(store, 1, `Houge replied: ${"x".repeat(2_100)}`);
    r = await sameAsRaw(store, {}); expect(r.prompt).not.toContain(CATCH_UP_OPEN); expect(rows(store)).toEqual([["context.catch_up", "none", "all_trimmed", r.run_id, null]]);
    store = RunStore.openInMemory(); laneRow(store, 1);
    const throwing = new Proxy(store, { get: (t, k) => (k === "laneTurnsSince" ? () => { throw new Error("disk"); } : Reflect.get(t, k)) }) as RunStore;
    r = await sameAsRaw(store, { store: throwing }); expect(r.prompt).not.toContain(CATCH_UP_OPEN);
    expect(rows(store)).toEqual([["context.catch_up", "none", "read_failed", r.run_id, null]]);
    store = RunStore.openInMemory(); laneRow(store, 1);
    r = await sameAsRaw(store, {}, { source: "schedule", goal: "g" }); expect(rows(store)).toEqual([]); expect(r.counts).toEqual({ "turn.clarify_cap": 1 });
    store = RunStore.openInMemory();
    r = await sameAsRaw(store, {}); expect(rows(store)).toEqual([]); expect(r.counts).toEqual({ "turn.clarify_cap": 1 });
  });
  it("5 the cap: one trailing clarify → cap/cap_reached with the notice; a clarify then a loop → no row, one call; max 0 → cap", async () => {
    let store = RunStore.openInMemory(); seedClarify(store);
    let r = await sameAsRaw(store, {});
    expect(r.prompt.startsWith(CLARIFY_CAP_NOTICE)).toBe(true); expect(rows(store)).toEqual([["turn.clarify_cap", "cap", "cap_reached", r.run_id, null]]);
    store = RunStore.openInMemory(); seedClarify(store, "loop");
    r = await sameAsRaw(store, {}); expect(r.prompt).not.toContain(CLARIFY_CAP_NOTICE); expect(rows(store)).toEqual([]); expect(r.counts).toEqual({ "turn.clarify_cap": 1 });
    store = RunStore.openInMemory();
    r = await sameAsRaw(store, { env: { HOUGE_MAX_CONSECUTIVE_CLARIFY: "0" } });
    expect(r.prompt.startsWith(CLARIFY_CAP_NOTICE)).toBe(true); expect(rows(store)).toEqual([["turn.clarify_cap", "cap", "cap_reached", r.run_id, null]]);
  });
  it("6 live() false: zero calls, zero rows; the prompt and the loop_started payload identical to a live call's", async () => {
    const store = RunStore.openInMemory(); seedClarify(store); laneRow(store, 1);
    const retrieval: TurnRetrieval = { facts: facts(1), pages: [], telemetry: { facts: tel({ admitted: 1, best_admitted: 0.7 }), pages: tel() } };
    const { d, counts } = deps(store, { retrieval });
    const ended = await build(d, store, { live: () => false });
    expect(counts).toEqual({}); expect(rows(store)).toEqual([]);
    const live = await build(d, store, { live: () => true });
    expect(ended.prompt).toBe(live.prompt);
    expect(loopStarted(store, ended.run_id)).toEqual(loopStarted(store, live.run_id));
    expect(rows(store).map((r) => r[0])).toEqual(["context.recall", "context.catch_up", "turn.clarify_cap"]);
  });
  it("7 one read: getRecentChatTurns and laneTurnsSince once each, retrieve once, with and without a recorder", async () => {
    for (const withRecorder of [true, false]) {
      const store = RunStore.openInMemory(); seedClarify(store); laneRow(store, 1);
      const reads: Record<string, number> = {};
      const counting = new Proxy(store, { get: (t, k) => {
        const v = Reflect.get(t, k);
        if (k !== "getRecentChatTurns" && k !== "laneTurnsSince") return typeof v === "function" ? v.bind(t) : v;
        return (...a: unknown[]) => { reads[k] = (reads[k] ?? 0) + 1; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      } }) as RunStore;
      let retrieves = 0;
      const { d } = deps(store, { store: counting, retrieve: async () => { retrieves++; return NONE; } });
      if (!withRecorder) delete (d as { recorder?: unknown }).recorder;
      await build(d, store);
      expect(reads, `recorder=${withRecorder}`).toEqual({ getRecentChatTurns: 1, laneTurnsSince: 1 }); expect(retrieves).toBe(1);
    }
  });
  it("8 a recorder whose record throws: buildTurnPrompt resolves, the prompt unchanged", async () => {
    const store = RunStore.openInMemory(); seedClarify(store);
    const boom: DecisionRecorder = { record: () => { throw new Error("boom"); } };
    const r = await sameAsRaw(store, { recorder: boom });
    expect(r.prompt.startsWith(CLARIFY_CAP_NOTICE)).toBe(true); expect(rows(store)).toEqual([]);
  });
  it("8b a live() callback that throws: buildTurnPrompt resolves, the prompt unchanged, no rows", async () => {
    const store = RunStore.openInMemory(); seedClarify(store);
    const r = await sameAsRaw(store, {}, { live: () => { throw new Error("x"); } });
    expect(r.prompt.startsWith(CLARIFY_CAP_NOTICE)).toBe(true); expect(rows(store)).toEqual([]);
  });
  it("9 lessonsInputOf reads the snapshot's counts and the failed flag", () => {
    const snap = { text: "", lessonIds: [1, 2], lessonScopes: [], skillScopes: [], coreFactIds: [], skipped: [{ lesson_id: 3, chars: 900, cap: 100 }] } as unknown as PromptSnapshot;
    expect(lessonsInputOf(snap)).toEqual({ rendered: 2, skipped: 1, failed: false });
    expect(lessonsInputOf({ ...snap, lessonRenderFailed: true })).toEqual({ rendered: 2, skipped: 1, failed: true });
  });
  it("10 planted throw (P14) in the real entry's rule: one fail-rung row with the fail verdict on the run; prompt and loop_started identical to unplanted", async () => {
    const recallR: TurnRetrieval = { facts: facts(1), pages: [], telemetry: { facts: tel({ admitted: 1, best_admitted: 0.7 }), pages: tel() } };
    const plans: Array<[string, { ladder: readonly unknown[] }, (s: RunStore) => void, TurnRetrieval, string]> = [
      ["context.recall", CONTEXT_RECALL, (s) => { s.addEpisodicFact({ chat_id: CHAT, fact: "Paco likes the pdf one" }); }, recallR, "none"],
      ["context.catch_up", CONTEXT_CATCH_UP, (s) => laneRow(s, 1), NONE, "none"],
      ["turn.clarify_cap", TURN_CLARIFY_CAP, (s) => seedClarify(s), NONE, "allow"]
    ];
    const read = (store: RunStore, id: string) => q(store).prepare("SELECT entry_id, rung, verdict, run_id, tool_call_id FROM decisions WHERE entry_id = ? ORDER BY rowid").all(id)
      .map((r) => [r.entry_id, r.rung, r.verdict, r.run_id, r.tool_call_id ?? null]);
    const effects = (st: RunStore) => ({
      touches: q(st).prepare("SELECT id, applied_count FROM episodic_facts ORDER BY id").all(),
      incidents: st.listOpenIncidents().map((x) => [x.kind, x.subject, x.fingerprint])
    });
    for (const [id, entry, seed, retrieval, failVerdict] of plans) {
      const base = RunStore.openInMemory(); seed(base);
      const unplanted = await build(deps(base, { retrieval }).d, base);
      const store = RunStore.openInMemory(); seed(store);
      const rung = entry.ladder[0] as { decide: unknown }; const orig = rung.decide;
      rung.decide = () => { throw new Error("planted"); };
      let planted: Awaited<ReturnType<typeof build>>;
      try { planted = await build(deps(store, { retrieval }).d, store); } finally { rung.decide = orig; }
      expect(read(store, id), id).toEqual([[id, "fail", failVerdict, planted.run_id, null]]);
      expect(planted.prompt, id).toBe(unplanted.prompt);
      expect(loopStarted(store, planted.run_id), id).toEqual(loopStarted(base, unplanted.run_id));
      expect(effects(store), id).toEqual(effects(base));
      if (id === "context.recall") expect(effects(base).touches, "the fact was admitted and touched").toEqual([{ id: 1, applied_count: 1 }]);
    }
  });
});
