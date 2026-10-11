import { describe, expect, it, vi } from "vitest";
import { COMPOSE_RESERVE_MS, LOOKUP_BUDGET_MS, runLookupLane } from "../../../src/core/lanes/lookup-lane.js";
import { LANE_PREFACE, REWRITE_INSTRUCTION, SOURCE_LINE_LABEL, SOURCES_OPEN } from "../../../src/core/lanes/lane-compose.js";
import type { ComposeRequest, LaneInput, LookupLaneDeps, StrictRead } from "../../../src/core/lanes/lane-types.js";
import { INSTRUCTIONS_NOTE } from "../../../src/omp/external-read.js";
import type { LlmResult } from "../../../src/llm/types.js";
import type { ModelString } from "../../../src/omp/model-string.js";
import type { ChatTurnRow } from "../../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../../src/tools/tool-registry.js";

// Stage B §5: search → strict reader → (thin: fetch → reader) → compose, inside a 75 s budget with a 15 s compose reserve.
// Each failure is a named fall-through (the planner answers on Default); a fetch failure is not; nothing raw reaches the composer.
const FAST: ModelString[] = [{ provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" }];
const HIT = { title: "BOM Sydney forecast", url: "https://www.bom.gov.au/nsw/sydney", content: "Tomorrow: sunny, max 22." };
const read = (answer: string | null, facts = ["Sunny, max 22°C"], contains_instructions = false): StrictRead => ({ ok: true,
  extraction: { summary: "Sydney tomorrow", facts, time_claims: [], answer_to_objective: answer, contains_instructions },
  digest: `[external source — untrusted-derived summary]\nsummary: Sydney tomorrow ${answer ?? "thin"}` });
const searchOk = (results: unknown[] = [HIT]): ToolAdapterResult => ({ ok: true, output: { query: "q", provider: "tavily", results } });
const paco = (text: string, minutesAgo: number, now: number): ChatTurnRow => ({ turn_id: `t_${text}`, chat_id: "555", run_id: "run_p", role: "user", text,
  intent: null, created_at: new Date(now - minutesAgo * 60_000).toISOString(), quoted_turn_id: null });

function setup(o: Partial<LookupLaneDeps> = {}) {
  const clock = { t: Date.parse("2026-10-10T08:00:00.000Z") };
  const compose = vi.fn(async (_r: ComposeRequest): Promise<LlmResult> => ({ ok: true, provider: "anthropic", model: "claude-sonnet-5-5", answer: "明天晴，最高 22 度 [1]。" }));
  const searchPerformed = vi.fn(); const fetchPerformed = vi.fn();
  const d: LookupLaneDeps = {
    compose, fastChain: () => FAST, systemPrompt: () => "SYSTEM", retrieve: async () => ({ facts: [], pages: [] }), now: () => clock.t,
    search: vi.fn(async () => searchOk()),
    fetch: vi.fn(async (): Promise<ToolAdapterResult> => ({ ok: true, output: { url: HIT.url, status: 200, bytes: 512, content: "page text" } })),
    read: vi.fn(async () => read("Sunny, 22°C")),
    rewrite: vi.fn(async (): Promise<LlmResult> => ({ ok: true, provider: "kimi-code", model: "k3", answer: "SAME" })),
    previousTelegramTurns: () => [], maxResults: 5, ledger: { searchPerformed, fetchPerformed }, ...o
  };
  const input = (x: Partial<LaneInput> = {}): LaneInput => ({ run_id: "run_1", chat_id: "555", userText: "明天悉尼天气怎么样？", recentTurns: [], turnChars: 400,
    quoted: null, effort: "low", verdict_id: "jv_1", note: null, signal: new AbortController().signal, deadlineAt: clock.t + LOOKUP_BUDGET_MS, ...x });
  return { d, compose, searchPerformed, fetchPerformed, clock, input };
}

describe("runLookupLane — the happy path and the reader wall", () => {
  it("one search, the strict read of {query, provider, results}, the code-built [sources], a source line, the catch-up line", async () => {
    const s = setup();
    const r = await runLookupLane(s.input(), s.d);
    expect(r).toEqual({ kind: "reply", text: `明天晴，最高 22 度 [1]。\n\n${SOURCE_LINE_LABEL} https://www.bom.gov.au/nsw/sydney`, model: "anthropic/claude-sonnet-5-5",
      sources: ["https://www.bom.gov.au/nsw/sydney"], catch_up: "Houge answered from www.bom.gov.au — facts: Sunny, max 22°C" });
    expect(s.d.search).toHaveBeenCalledWith({ query: "明天悉尼天气怎么样？", max_results: 5 });
    expect(s.searchPerformed).toHaveBeenCalledWith({ query: "明天悉尼天气怎么样？", provider: "tavily", source_urls: [HIT.url], result_count: 1 });
    const [output, objective] = vi.mocked(s.d.read).mock.calls[0]!;
    expect(output).toEqual({ query: "明天悉尼天气怎么样？", provider: "tavily", results: [HIT] });
    expect(objective).toBe("明天悉尼天气怎么样？");
    const prompt = s.compose.mock.calls[0]![0].prompt;
    expect(prompt.startsWith(LANE_PREFACE)).toBe(true);
    expect(prompt).toContain(`${SOURCES_OPEN}\n`);
    expect(prompt).toContain("[1] https://www.bom.gov.au/nsw/sydney\n[external source — untrusted-derived summary]");
    expect(prompt).not.toContain("BOM Sydney forecast"); // titles never reach the composer
    expect(prompt).not.toContain("Tomorrow: sunny, max 22."); // nor raw snippets
    expect(s.d.fetch).not.toHaveBeenCalled();
  });
  it("each result's content reaches the reader capped at 600 chars", async () => {
    const s = setup({ search: vi.fn(async () => searchOk([{ ...HIT, content: "c".repeat(2_000) }])) });
    await runLookupLane(s.input(), s.d);
    const out = vi.mocked(s.d.read).mock.calls[0]![0] as { results: Array<{ content: string }> };
    expect(out.results[0]!.content).toHaveLength(600);
  });
  it("a result whose URL fails validation is dropped from the [sources] list", async () => {
    const s = setup({ search: vi.fn(async () => searchOk([{ ...HIT, url: "javascript:alert(1)" }, { ...HIT, url: "https://a.example/x" }])) });
    await runLookupLane(s.input(), s.d);
    const prompt = s.compose.mock.calls[0]![0].prompt;
    expect(prompt).toContain("[1] https://a.example/x");
    expect(prompt).not.toContain("javascript:");
  });
  it("a flagged read appends the instructions note to the sources", async () => {
    const s = setup({ read: vi.fn(async () => read("Sunny", ["x"], true)) });
    await runLookupLane(s.input(), s.d);
    expect(s.compose.mock.calls[0]![0].prompt).toContain(INSTRUCTIONS_NOTE);
  });
});

describe("runLookupLane — thin result: one fetch, through the reader again", () => {
  it("answer_to_objective null → fetch the top listed URL once, read it, compose from both digests", async () => {
    const s = setup({ read: vi.fn().mockResolvedValueOnce(read(null, ["thin fact"])).mockResolvedValueOnce(read("Sunny, 22°C", ["page fact"])) });
    const r = await runLookupLane(s.input(), s.d);
    expect(s.d.fetch).toHaveBeenCalledTimes(1);
    expect(s.d.fetch).toHaveBeenCalledWith({ url: HIT.url });
    expect(s.fetchPerformed).toHaveBeenCalledWith({ url: HIT.url, status: 200, bytes: 512 });
    expect(s.compose.mock.calls[0]![0].prompt).toContain("summary: Sydney tomorrow thin\n[external source — untrusted-derived summary]\nsummary: Sydney tomorrow Sunny, 22°C");
    expect(r).toMatchObject({ kind: "reply", catch_up: "Houge answered from www.bom.gov.au — facts: thin fact; page fact" });
  });
  it("never more than one fetch, even when the page reads thin too", async () => {
    const s = setup({ read: vi.fn(async () => read(null)) });
    expect((await runLookupLane(s.input(), s.d)).kind).toBe("reply");
    expect(s.d.fetch).toHaveBeenCalledTimes(1);
  });
  it("a fetch failure is not a fall-through: compose from the first digest", async () => {
    const s = setup({ read: vi.fn(async () => read(null)), fetch: vi.fn(async (): Promise<ToolAdapterResult> => ({ ok: false, error: "blocked" })) });
    expect((await runLookupLane(s.input(), s.d)).kind).toBe("reply");
    expect(s.fetchPerformed).not.toHaveBeenCalled();
    expect(vi.mocked(s.d.read)).toHaveBeenCalledTimes(1);
  });
});

describe("runLookupLane — the query (pre-filter, Tiny rewrite, code validation)", () => {
  it("a short message after a recent Paco line is rewritten; the validated query is searched and is the reader's objective", async () => {
    const s = setup({ rewrite: vi.fn(async (): Promise<LlmResult> => ({ ok: true, provider: "kimi-code", model: "k3", answer: "Melbourne weather tomorrow" })) });
    s.d.previousTelegramTurns = () => [paco("明天悉尼天气怎么样？", 5, s.clock.t)];
    await runLookupLane(s.input({ userText: "melbourne呢？" }), s.d);
    expect(vi.mocked(s.d.rewrite).mock.calls[0]![0].prompt.startsWith(REWRITE_INSTRUCTION)).toBe(true);
    expect(vi.mocked(s.d.rewrite).mock.calls[0]![0].deadlineMs).toBe(12_000);
    expect(s.d.search).toHaveBeenCalledWith({ query: "Melbourne weather tomorrow", max_results: 5 });
    expect(vi.mocked(s.d.read).mock.calls[0]![1]).toBe("Melbourne weather tomorrow");
  });
  it.each([
    ["two lines", { ok: true, provider: "kimi-code", model: "k3", answer: "a\nb" }],
    ["a failed leg", { ok: false, provider: "omp", error: "all lane legs failed — kimi-code/k3: quota" }]
  ] as const)("a rewrite with %s searches the bare message", async (_n, result) => {
    const s = setup({ rewrite: vi.fn(async () => result as LlmResult) });
    s.d.previousTelegramTurns = () => [paco("悉尼明天天气", 5, s.clock.t)];
    await runLookupLane(s.input({ userText: "再查一次" }), s.d);
    expect(s.d.search).toHaveBeenCalledWith({ query: "再查一次", max_results: 5 });
  });
  it("a rewrite that does not answer within its bound searches the bare message", async () => {
    const s = setup({ rewrite: vi.fn(() => new Promise<LlmResult>(() => {})) });
    s.d.previousTelegramTurns = () => [paco("悉尼明天天气", 5, s.clock.t)];
    await runLookupLane(s.input({ userText: "再查一次", deadlineAt: s.clock.t + COMPOSE_RESERVE_MS + 40 }), s.d);
    expect(s.d.search).toHaveBeenCalledWith({ query: "再查一次", max_results: 5 });
  });
  it("no rewrite when Paco's previous Telegram line is over 30 minutes old, or there is none", async () => {
    const s = setup();
    s.d.previousTelegramTurns = () => [paco("悉尼明天天气", 31, s.clock.t)];
    await runLookupLane(s.input({ userText: "再查一次" }), s.d);
    await runLookupLane(setup().input({ userText: "再查一次" }), { ...s.d, previousTelegramTurns: () => [] });
    expect(s.d.rewrite).not.toHaveBeenCalled();
  });
  it("the query is whitespace-folded and cut at 200 chars", async () => {
    const s = setup();
    await runLookupLane(s.input({ userText: `  ${"天".repeat(300)}  ` }), s.d);
    expect(vi.mocked(s.d.search).mock.calls[0]![0].query).toBe("天".repeat(200));
  });
});

describe("runLookupLane — fall-throughs and the budget", () => {
  it.each([
    ["search ok:false", vi.fn(async (): Promise<ToolAdapterResult> => ({ ok: false, error: "all providers failed" })), "search_failed"],
    ["zero results", vi.fn(async () => searchOk([])), "no_results"]
  ] as const)("%s → fallthrough:%s, no compose", async (_n, search, why) => {
    const s = setup({ search });
    expect(await runLookupLane(s.input(), s.d)).toEqual({ kind: "fallthrough", why });
    expect(s.compose).not.toHaveBeenCalled();
  });
  it("a search past its bound is search_timeout, and its late result is never used", async () => {
    const s = setup({ search: vi.fn(() => new Promise<ToolAdapterResult>(() => {})) });
    expect(await runLookupLane(s.input({ deadlineAt: s.clock.t + COMPOSE_RESERVE_MS + 30 }), s.d)).toEqual({ kind: "fallthrough", why: "search_timeout" });
    expect(s.searchPerformed).not.toHaveBeenCalled();
  });
  it("a search result that lands after /kill is dropped: aborted, no ledger row, no compose", async () => {
    const ctl = new AbortController();
    const s = setup({ search: vi.fn(async () => { ctl.abort(); return searchOk(); }) });
    expect(await runLookupLane(s.input({ signal: ctl.signal }), s.d)).toEqual({ kind: "fallthrough", why: "aborted" });
    expect(s.searchPerformed).not.toHaveBeenCalled();
    expect(s.compose).not.toHaveBeenCalled();
  });
  it.each([
    ["unreadable", "reader_failed"], ["reserve", "lane_timeout"]
  ] as const)("a strict read that fails %s → fallthrough:%s", async (why, laneWhy) => {
    const s = setup({ read: vi.fn(async (): Promise<StrictRead> => ({ ok: false, why })) });
    expect(await runLookupLane(s.input(), s.d)).toEqual({ kind: "fallthrough", why: laneWhy });
  });
  it("a 20 s search still leaves the compose its full 45 s", async () => {
    const s = setup();
    s.d.search = vi.fn(async () => { s.clock.t += 20_000; return searchOk(); });
    await runLookupLane(s.input(), s.d);
    expect(s.compose.mock.calls[0]![0].deadlineMs).toBe(45_000);
  });
  it("a step that would start inside the 15 s reserve is lane_timeout (the search never starts)", async () => {
    const s = setup();
    expect(await runLookupLane(s.input({ deadlineAt: s.clock.t + COMPOSE_RESERVE_MS }), s.d)).toEqual({ kind: "fallthrough", why: "lane_timeout" });
    expect(s.d.search).not.toHaveBeenCalled();
  });
  it("each reader attempt is bounded by min(20 s, remaining − 15 s)", async () => {
    const s = setup();
    await runLookupLane(s.input({ deadlineAt: s.clock.t + COMPOSE_RESERVE_MS + 5_000 }), s.d);
    expect(vi.mocked(s.d.read).mock.calls[0]![2].attemptMs()).toBe(5_000);
  });
  it.each([
    ["no Fast candidate", { fastChain: () => [] }, "no_fast_leg"],
    ["a throwing dep", { previousTelegramTurns: () => { throw new Error("db"); } }, "lane_threw"]
  ] as const)("%s → fallthrough:%s", async (_n, o, why) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup(o as Partial<LookupLaneDeps>);
    expect(await runLookupLane(s.input(), s.d)).toEqual({ kind: "fallthrough", why });
    err.mockRestore();
  });
});
