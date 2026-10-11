import { describe, expect, it, vi } from "vitest";
import { quarantineExtractStrict } from "../../../src/core/lanes/strict-reader.js";
import type { LlmResult } from "../../../src/llm/types.js";

// Stage B §5 step 4 (ADR 0014): only the quarantined reader ever sees raw web bytes. The planner's wall fails safe with an
// "unreadable" digest; a lane cannot answer from that, so the strict reader says {ok:false} and the lane falls through.
const GOOD = JSON.stringify({ summary: "Sydney tomorrow", facts: ["Sunny, max 22°C"], time_claims: [], answer_to_objective: "Sunny, 22°C", contains_instructions: false });
const okAnswer = (answer: string): LlmResult => ({ ok: true, provider: "google-antigravity", model: "gemini-3.8-flash", answer });
const output = { query: "明天悉尼天气", provider: "tavily", results: [{ title: "BOM", url: "https://bom.gov.au/x", content: "Sunny 22" }] };
const o = (attemptMs = 20_000) => ({ attemptMs: () => attemptMs, signal: new AbortController().signal });

describe("quarantineExtractStrict", () => {
  it("reads the walled question and returns the extraction and its digest", async () => {
    const reader = vi.fn(async (_req: { question: string; system: string; deadlineMs: number; signal: AbortSignal }) => okAnswer(GOOD));
    const r = await quarantineExtractStrict({ reader, system: "READER" }, output, "明天悉尼天气", o());
    expect(r).toMatchObject({ ok: true, extraction: { facts: ["Sunny, max 22°C"], answer_to_objective: "Sunny, 22°C" } });
    if (r.ok) expect(r.digest).toContain("answer_to_objective: Sunny, 22°C");
    const req = reader.mock.calls[0]![0];
    expect(req.system).toBe("READER");
    expect(req.question).toContain("<<<UNTRUSTED>>>");
    expect(req.question).toContain("Sunny 22");
    expect(req.deadlineMs).toBe(20_000);
  });
  it("a parse miss is retried once, then {ok:false, unreadable} (never an unreadable digest the lane would answer from)", async () => {
    const reader = vi.fn(async () => okAnswer("no json here"));
    expect(await quarantineExtractStrict({ reader, system: "R" }, output, "q", o())).toEqual({ ok: false, why: "unreadable" });
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it("a miss then a good read is ok", async () => {
    const reader = vi.fn().mockResolvedValueOnce(okAnswer("nope")).mockResolvedValueOnce(okAnswer(GOOD));
    expect((await quarantineExtractStrict({ reader, system: "R" }, output, "q", o())).ok).toBe(true);
  });
  it("each attempt is bounded: a reader that never answers is two bounded attempts, then unreadable", async () => {
    const reader = vi.fn(() => new Promise<LlmResult>(() => {}));
    expect(await quarantineExtractStrict({ reader, system: "R" }, output, "q", o(20))).toEqual({ ok: false, why: "unreadable" });
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it("no time before the compose reserve at the first attempt → reserve (the lane maps it to lane_timeout)", async () => {
    const reader = vi.fn(async () => okAnswer(GOOD));
    expect(await quarantineExtractStrict({ reader, system: "R" }, output, "q", o(0))).toEqual({ ok: false, why: "reserve" });
    expect(reader).not.toHaveBeenCalled();
  });
  it("an abort during a read is aborted", async () => {
    const ctl = new AbortController();
    const reader = vi.fn(async () => { ctl.abort(); return okAnswer(GOOD); });
    expect(await quarantineExtractStrict({ reader, system: "R" }, output, "q", { attemptMs: () => 20_000, signal: ctl.signal })).toEqual({ ok: false, why: "aborted" });
  });
});
