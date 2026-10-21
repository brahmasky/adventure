import { describe, expect, it, vi } from "vitest";
import { clusterCandidates, clusterIdOf, computeRecurrence, ensureEmbeddings, recordRecurrenceSignals, resolveRecurrenceGate } from "../../src/improve/recurrence.js";
import { RunStore } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";

// Spec 2b-ii §3.3 (P2): candidates are Paco's telegram turns of ≥ 20 chars outside other/status/memory; embeddings are
// stored once per turn (1 500-char cap); single-linkage clusters at cosine ≥ the gate (default 0.6), ≥ 3 turns; the cluster
// id hashes category + sorted ids; the idempotency key is category + the earliest turn id; Ollama down → no recurrence today.
const NOW = "2026-10-21T10:00:00.000Z";
const vec = (x: number, y: number) => Float32Array.from([x, y]);
const cand = (turn_id: string, text: string, category: "answer" | "lookup" = "answer", created_at = NOW) => ({ turn_id, run_id: `run_${turn_id}`, chat_id: "555", text, created_at, category });
const verdict = (s: RunStore, run_id: string) => s.insertJevVerdict({ run_id, category: "answer", breadth: null, reasoning: null, actions: null, sets_rule: null, rule_scope: null, lane: "answer", role: "default", effort: null, cascade: null,
  save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null });

describe("clusterCandidates", () => {
  it("three near turns form one cluster; two do not; categories never mix; single linkage chains a→b→c", () => {
    const vectors = new Map([["t1", vec(1, 0)], ["t2", vec(0.9, 0.44)], ["t3", vec(0.6, 0.8)], ["t4", vec(-1, 0)], ["t5", vec(1, 0)]]); // t4 opposes every other (senior B5: (0,1)·t3 was 0.8)
    const cs = clusterCandidates([cand("t1", "a".repeat(20)), cand("t2", "b".repeat(20)), cand("t3", "c".repeat(20)), cand("t4", "d".repeat(20)), cand("t5", "e".repeat(20), "lookup")], vectors, 0.75);
    // t1·t2 = 0.9, t2·t3 ≈ 0.89, t1·t3 = 0.6 (< gate, but linked through t2); t4 is far; t5 is another category
    expect(cs.map((c) => [c.category, c.turnIds])).toEqual([["answer", ["t1", "t2", "t3"]]]);
    expect(cs[0]!.idempotencyKey).toBe("answer:t1");
    expect(cs[0]!.clusterId).toBe(clusterIdOf("answer", ["t1", "t2", "t3"]));
    expect(clusterIdOf("answer", ["t3", "t1", "t2"])).toBe(cs[0]!.clusterId); // order-free
    expect(cs[0]!.clusterId).toMatch(/^rec_[0-9a-f]{16}$/);
  });
  it("spanDays is the whole days between the earliest and latest turn, at least 1", () => {
    const vectors = new Map([["t1", vec(1, 0)], ["t2", vec(1, 0)], ["t3", vec(1, 0)]]);
    const at = (d: number, h = 0) => new Date(Date.parse(NOW) - d * 86_400_000 + h * 3_600_000).toISOString();
    const span = (a: string, b: string, c: string) => clusterCandidates([cand("t1", "a".repeat(20), "answer", a), cand("t2", "b".repeat(20), "answer", b), cand("t3", "c".repeat(20), "answer", c)], vectors, 0.6)[0]!.spanDays;
    expect(span(at(0), at(0, 1), at(0, 2))).toBe(1); // same day clamps to 1
    expect(span(at(5), at(2), at(0))).toBe(5);
    expect(span(at(5), at(2), at(0, -1))).toBe(5); // 4d23h rounds up
  });
  it("the gate reads HOUGE_RECURRENCE_COSINE_GATE with 0.6 as the default and garbage falling back", () => {
    expect(resolveRecurrenceGate({})).toBe(0.6);
    expect(resolveRecurrenceGate({ HOUGE_RECURRENCE_COSINE_GATE: "0.42" })).toBe(0.42);
    expect(resolveRecurrenceGate({ HOUGE_RECURRENCE_COSINE_GATE: "nope" })).toBe(0.6);
  });
});

describe("ensureEmbeddings", () => {
  it("embeds only turns without a stored vector, capped at 1 500 characters, stores them, and counts nulls as unavailable", async () => {
    const s = RunStore.openInMemory();
    s.putTurnEmbedding("t1", "m", vec(1, 0), NOW);
    const embed = vi.fn(async (text: string) => (text === "z" ? null : vec(0, 1)));
    const r = await ensureEmbeddings(s, [{ turn_id: "t1", text: "x" }, { turn_id: "t2", text: "y".repeat(2_000) }, { turn_id: "t3", text: "z" }], embed, "m", NOW);
    expect(embed.mock.calls.map((c) => c[0].length)).toEqual([1_500, 1]);
    expect([...r.vectors.keys()]).toEqual(["t1", "t2"]);
    expect(r.unavailable).toBe(1);
    expect(s.getTurnEmbeddings(["t2"]).has("t2")).toBe(true); // stored once
  });
});

describe("computeRecurrence and recordRecurrenceSignals", () => {
  it("over real rows: three near turns in 14 days give one cluster keyed rec:<id>; the signal row carries the size, the newest run and the chat, once per (cluster, size)", async () => {
    const s = RunStore.openInMemory();
    const runs = ["make the weekly report please", "weekly report again please", "the weekly report, thanks again"].map((t) => createTelegramTurn(s, t).run_id);
    for (const run_id of runs) verdict(s, run_id);
    const r = await computeRecurrence({ store: s, env: {}, now: NOW, embed: async () => vec(1, 0), embedModel: "m", signal: new AbortController().signal });
    expect(r.embedUnavailable).toBe(0);
    expect([...r.clusters.keys()]).toHaveLength(1);
    const [scope, c] = [...r.clusters.entries()][0]!;
    expect(scope).toBe(`rec:${c.clusterId}`);
    expect(c.turnIds).toHaveLength(3);
    expect(recordRecurrenceSignals(s, r.clusters, NOW)).toBe(1);
    expect(recordRecurrenceSignals(s, r.clusters, NOW)).toBe(0);
    expect(s.listUnconsumedSignals(5).map((x) => [x.signal, x.value, x.about_run_id, x.chat_id, x.source_outcome_id])).toEqual([["recurrence", "3", runs[2], "555", `rec:${c.clusterId}:3`]]);
  });
  it("Ollama down (every embed null) → no clusters and embedUnavailable = the candidate count", async () => {
    const s = RunStore.openInMemory();
    for (const t of ["make the weekly report please", "weekly report again please", "the weekly report, thanks again"]) verdict(s, createTelegramTurn(s, t).run_id);
    const r = await computeRecurrence({ store: s, env: {}, now: NOW, embed: async () => null, embedModel: "m", signal: new AbortController().signal });
    expect(r.clusters.size).toBe(0);
    expect(r.embedUnavailable).toBe(3);
  });
});
