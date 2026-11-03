import { describe, expect, it, vi } from "vitest";
import { COMPOSE_RESERVE_MS, LOOKUP_BUDGET_MS, runLookupLane } from "../../../src/core/lanes/lookup-lane.js";
import type { ComposeRequest, LaneInput, LookupLaneDeps, StrictRead } from "../../../src/core/lanes/lane-types.js";
import { LOOKUP_REWRITE } from "../../../src/decisions/entries/lookup-rewrite.js";
import type { DecisionRecorder, RuleRung } from "../../../src/decisions/types.js";
import type { LlmResult } from "../../../src/llm/types.js";
import type { ModelString } from "../../../src/omp/model-string.js";
import type { ChatTurnRow } from "../../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../../src/tools/tool-registry.js";

// Spec R6 §4.0–4.2: the lane decides lookup.rewrite / lookup.thin at the branch and writes them at the lane's end, only while
// the signal is unaborted; the raw code drives (the query searched, the fetch) and the rows only describe it.
const FAST: ModelString[] = [{ provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" }];
const HIT = { title: "BOM Sydney forecast", url: "https://www.bom.gov.au/nsw/sydney", content: "Tomorrow: sunny, max 22." };
const read = (answer: string | null, facts = ["Sunny, max 22°C"], contains_instructions = false): StrictRead => ({ ok: true,
  extraction: { summary: "Sydney tomorrow", facts, time_claims: [], answer_to_objective: answer, contains_instructions },
  digest: `[external source — untrusted-derived summary]\nsummary: Sydney tomorrow ${answer ?? "thin"}` });
const searchOk = (results: unknown[] = [HIT]): ToolAdapterResult => ({ ok: true, output: { query: "q", provider: "tavily", results } });
const paco = (text: string, minutesAgo: number, now: number): ChatTurnRow => ({ turn_id: `t_${text}`, chat_id: "555", run_id: "run_p", role: "user", text,
  intent: null, created_at: new Date(now - minutesAgo * 60_000).toISOString(), quoted_turn_id: null });
const R6 = new Set(["lookup.rewrite", "lookup.thin", "turn.model"]);

type Call = [string, string, string | null, string | null];
function setup(o: Partial<LookupLaneDeps> = {}) {
  const clock = { t: Date.parse("2026-10-10T08:00:00.000Z") };
  const log: string[] = [];
  const calls: Call[] = []; const rungs: string[] = [];
  const recorder: DecisionRecorder = { record: (e, r, c) => { calls.push([e.id, r.verdict, r.reason, c.run_id]); rungs.push(r.rung); log.push(`record:${e.id}`); return null; } };
  const compose = vi.fn(async (_r: ComposeRequest): Promise<LlmResult> => { log.push("compose"); return { ok: true, provider: "anthropic", model: "claude-sonnet-5-5", answer: "明天晴，最高 22 度 [1]。" }; });
  const searchPerformed = vi.fn(); const fetchPerformed = vi.fn();
  const d: LookupLaneDeps = {
    compose, fastChain: () => FAST, systemPrompt: () => "SYSTEM", retrieve: async () => ({ facts: [], pages: [] }), now: () => clock.t,
    search: vi.fn(async () => searchOk()),
    fetch: vi.fn(async (): Promise<ToolAdapterResult> => { log.push("fetch"); return { ok: true, output: { url: HIT.url, status: 200, bytes: 512, content: "page text" } }; }),
    read: vi.fn(async () => read("Sunny, 22°C")),
    rewrite: vi.fn(async (): Promise<LlmResult> => ({ ok: true, provider: "kimi-code", model: "k3", answer: "SAME" })),
    previousTelegramTurns: () => [], maxResults: 5, ledger: { searchPerformed, fetchPerformed }, recorder, ...o
  };
  const input = (x: Partial<LaneInput> = {}): LaneInput => ({ run_id: "run_1", chat_id: "555", userText: "明天悉尼天气怎么样？", recentTurns: [], turnChars: 400,
    quoted: null, effort: "low", verdict_id: "jv_1", note: null, signal: new AbortController().signal, deadlineAt: clock.t + LOOKUP_BUDGET_MS, ...x });
  const r6 = () => calls.filter((c) => R6.has(c[0]));
  return { d, compose, searchPerformed, fetchPerformed, clock, input, calls, rungs, r6, log, ids: () => calls.map((c) => c[0]) };
}
const recent = (s: ReturnType<typeof setup>, text = "悉尼明天天气") => { s.d.previousTelegramTurns = () => [paco(text, 5, s.clock.t)]; };
const answer = (text: string) => vi.fn(async (): Promise<LlmResult> => ({ ok: true, provider: "kimi-code", model: "k3", answer: text }));

describe("lookup.rewrite and lookup.thin rows (spec R6 §4.1, §4.2)", () => {
  it("1. no previous line: bare/no_recent_line then none/answered, written after the mid-lane tool.wall / reader.family pair", async () => {
    const s = setup();
    expect((await runLookupLane(s.input(), s.d)).kind).toBe("reply");
    expect(s.r6()).toEqual([["lookup.rewrite", "bare", "no_recent_line", "run_1"], ["lookup.thin", "none", "answered", "run_1"]]);
    expect(s.ids()).toEqual(["tool.wall", "reader.family", "lookup.rewrite", "lookup.thin"]);
  });
  it("2a. a 41-char message after a recent line is long_message; the rewrite is never called", async () => {
    const s = setup(); recent(s);
    await runLookupLane(s.input({ userText: "a".repeat(41) }), s.d);
    expect(s.r6()[0]).toEqual(["lookup.rewrite", "bare", "long_message", "run_1"]);
    expect(s.d.rewrite).not.toHaveBeenCalled();
  });
  it("2b. quoted, the model answers a query: rewrite/rewritten and that query is searched", async () => {
    const s = setup({ rewrite: answer("Sydney weather tomorrow") }); recent(s);
    await runLookupLane(s.input({ userText: "a".repeat(41), quoted: { role: "houge", kind: "answer", age_s: 300, text: "earlier" } }), s.d);
    expect(s.r6()[0]).toEqual(["lookup.rewrite", "rewrite", "rewritten", "run_1"]);
    expect(s.d.search).toHaveBeenCalledWith({ query: "Sydney weather tomorrow", max_results: 5 });
  });
  it.each([
    ["SAME", "same"], ["a\nb", "invalid"]
  ])("2c. the model answers %j → bare/%s, the bare message searched", async (text, step) => {
    const s = setup({ rewrite: answer(text) }); recent(s);
    await runLookupLane(s.input({ userText: "再查一次" }), s.d);
    expect(s.r6()[0]).toEqual(["lookup.rewrite", "bare", step, "run_1"]);
    expect(s.d.search).toHaveBeenCalledWith({ query: "再查一次", max_results: 5 });
  });
  it("2d. a rewrite past its bound → bare/late; the late answer is never used", async () => {
    const s = setup({ rewrite: vi.fn(() => new Promise<LlmResult>(() => {})) }); recent(s);
    await runLookupLane(s.input({ userText: "再查一次", deadlineAt: s.clock.t + COMPOSE_RESERVE_MS + 40 }), s.d);
    expect(s.r6()[0]).toEqual(["lookup.rewrite", "bare", "late", "run_1"]);
    expect(s.d.search).toHaveBeenCalledWith({ query: "再查一次", max_results: 5 });
  });
  it.each([
    ["rejects", vi.fn(async (): Promise<LlmResult> => { throw new Error("tiny down"); })],
    ["answers ok:false", vi.fn(async (): Promise<LlmResult> => ({ ok: false, provider: "omp", error: "all lane legs failed" }))]
  ])("2e. the rewrite %s → bare/failed", async (_n, rewrite) => {
    const s = setup({ rewrite }); recent(s);
    await runLookupLane(s.input({ userText: "再查一次" }), s.d);
    expect(s.r6()[0]).toEqual(["lookup.rewrite", "bare", "failed", "run_1"]);
  });
  it("2f. the reserve already reached → bare/no_time, no call", async () => {
    const s = setup(); recent(s);
    await runLookupLane(s.input({ userText: "再查一次", deadlineAt: s.clock.t + COMPOSE_RESERVE_MS }), s.d);
    expect(s.r6()[0]).toEqual(["lookup.rewrite", "bare", "no_time", "run_1"]);
    expect(s.d.rewrite).not.toHaveBeenCalled();
  });
  it("3a. a thin read with a listable URL → fetch/thin, one fetch; row order after the second read's pair", async () => {
    const s = setup({ read: vi.fn().mockResolvedValueOnce(read(null)).mockResolvedValueOnce(read("Sunny")) });
    await runLookupLane(s.input(), s.d);
    expect(s.r6()).toEqual([["lookup.rewrite", "bare", "no_recent_line", "run_1"], ["lookup.thin", "fetch", "thin", "run_1"]]);
    expect(s.d.fetch).toHaveBeenCalledTimes(1);
    expect(s.ids()).toEqual(["tool.wall", "reader.family", "tool.wall", "reader.family", "lookup.rewrite", "lookup.thin"]);
  });
  it("3b. a thin read whose results have no listable URL → none/no_url, no fetch", async () => {
    const s = setup({ read: vi.fn(async () => read(null)), search: vi.fn(async () => searchOk([{ ...HIT, url: "ftp://x" }])) });
    await runLookupLane(s.input(), s.d);
    expect(s.r6()[1]).toEqual(["lookup.thin", "none", "no_url", "run_1"]);
    expect(s.d.fetch).not.toHaveBeenCalled();
  });
  it("3c. a failed first read: no lookup.thin consult; lookup.rewrite still written", async () => {
    const s = setup({ read: vi.fn(async (): Promise<StrictRead> => ({ ok: false, why: "unreadable" })) });
    expect(await runLookupLane(s.input(), s.d)).toEqual({ kind: "fallthrough", why: "reader_failed" });
    expect(s.r6()).toEqual([["lookup.rewrite", "bare", "no_recent_line", "run_1"]]);
  });
  it("4. write timing (P14-1): a slow R6 record never eats the fetch's budget — rows are written after the compose", async () => {
    const s = setup({ read: vi.fn().mockResolvedValueOnce(read(null)).mockResolvedValueOnce(read("Sunny")) });
    const inner = s.d.recorder as DecisionRecorder;
    s.d.recorder = { record: (e, r, c) => { if (R6.has(e.id)) s.clock.t += COMPOSE_RESERVE_MS + 1; return inner.record(e, r, c); } };
    const r = await runLookupLane(s.input({ deadlineAt: s.clock.t + COMPOSE_RESERVE_MS + 1_000 }), s.d);
    expect(r.kind).toBe("reply");
    expect(s.d.fetch).toHaveBeenCalledTimes(1);
    expect(s.log.indexOf("record:lookup.rewrite")).toBeGreaterThan(s.log.indexOf("compose"));
    expect(s.log.indexOf("record:lookup.thin")).toBeGreaterThan(s.log.indexOf("compose"));
  });
  it("5a. /kill while the rewrite is held: fallthrough aborted, zero R6 calls (P14-2)", async () => {
    const ctl = new AbortController();
    const s = setup({ rewrite: vi.fn(() => new Promise<LlmResult>(() => { ctl.abort(); })) }); recent(s);
    expect(await runLookupLane(s.input({ userText: "再查一次", signal: ctl.signal }), s.d)).toEqual({ kind: "fallthrough", why: "aborted" });
    expect(s.r6()).toEqual([]);
  });
  it("5b. /kill during the first read: zero R6 calls", async () => {
    const ctl = new AbortController();
    const s = setup({ read: vi.fn(async () => { ctl.abort(); return read("Sunny"); }) });
    expect(await runLookupLane(s.input({ signal: ctl.signal }), s.d)).toEqual({ kind: "fallthrough", why: "aborted" });
    expect(s.r6()).toEqual([]);
  });
  it("6. a search adapter that throws synchronously: lane_threw, lookup.rewrite written (the selection), no lookup.thin", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ search: vi.fn((): Promise<ToolAdapterResult> => { throw new Error("boom"); }) });
    expect(await runLookupLane(s.input(), s.d)).toEqual({ kind: "fallthrough", why: "lane_threw" });
    expect(s.r6()).toEqual([["lookup.rewrite", "bare", "no_recent_line", "run_1"]]);
    err.mockRestore();
  });
  it("7. no recorder: no throw, the result unchanged", async () => {
    const s = setup();
    delete s.d.recorder;
    expect((await runLookupLane(s.input(), s.d)).kind).toBe("reply");
    expect(s.calls).toEqual([]);
  });
  it("8. P13: a planted throwing rule records bare at the fail rung; the searched query is unchanged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rung = LOOKUP_REWRITE.ladder[0] as RuleRung<unknown, string>;
    const real = rung.decide;
    rung.decide = () => { throw new Error("planted"); };
    try {
      const s = setup({ rewrite: answer("Sydney weather tomorrow") }); recent(s);
      await runLookupLane(s.input({ userText: "再查一次" }), s.d);
      expect(s.r6()[0]).toEqual(["lookup.rewrite", "bare", null, "run_1"]);
      expect(s.rungs[s.calls.findIndex((c) => c[0] === "lookup.rewrite")]).toBe("fail");
      expect(s.d.search).toHaveBeenCalledWith({ query: "Sydney weather tomorrow", max_results: 5 });
    } finally { rung.decide = real; err.mockRestore(); }
  });
});
