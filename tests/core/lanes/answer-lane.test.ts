import { describe, expect, it, vi } from "vitest";
import { LANE_COMPOSE_MS, runAnswerLane } from "../../../src/core/lanes/answer-lane.js";
import { LANE_PREFACE } from "../../../src/core/lanes/lane-compose.js";
import type { AnswerLaneDeps, ComposeRequest, LaneInput } from "../../../src/core/lanes/lane-types.js";
import type { LlmResult } from "../../../src/llm/types.js";
import type { ModelString } from "../../../src/omp/model-string.js";

// Stage B §4 and §8: one compose on the Fast chain, bounded at min(45 s, remaining), with the turn's signal; any failure is a
// named fall-through (the planner answers on Default and lane_fallthrough_rate counts it); the lane never throws, because a
// throw would reach triageTurn's catch, write a planner-lane verdict and hide the failure from the rate.
const FAST: ModelString[] = [{ provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" }];
const T0 = 1_000_000;
const input = (o: Partial<LaneInput> = {}): LaneInput => ({ run_id: "run_1", chat_id: "555", userText: "你觉得 NAS 放在客厅还是书房更好？", recentTurns: [],
  turnChars: 400, quoted: null, effort: "low", verdict_id: "jv_1", note: null, signal: new AbortController().signal, deadlineAt: T0 + LANE_COMPOSE_MS, ...o });
function deps(compose: (r: ComposeRequest) => Promise<LlmResult>, o: Partial<AnswerLaneDeps> = {}): AnswerLaneDeps {
  return { compose, fastChain: () => FAST, systemPrompt: () => "SYSTEM", retrieve: async () => ({ facts: [], pages: [] }), now: () => T0, ...o };
}
const ok = (answer: string): LlmResult => ({ ok: true, provider: "anthropic", model: "claude-sonnet-5-5", answer });

describe("runAnswerLane", () => {
  it("one compose on the Fast chain with routed_by and 45 s: the reply, its model and the catch-up line", async () => {
    const compose = vi.fn(async (_r: ComposeRequest) => ok("  书房更好：安静，散热也好。  "));
    const r = await runAnswerLane(input(), deps(compose));
    expect(r).toEqual({ kind: "reply", text: "书房更好：安静，散热也好。", model: "anthropic/claude-sonnet-5-5", catch_up: "Houge replied: 书房更好：安静，散热也好。" });
    expect(compose).toHaveBeenCalledTimes(1);
    const req = compose.mock.calls[0]![0];
    expect(req).toMatchObject({ chain: FAST, deadlineMs: 45_000, routed_by: "jv_1" });
    expect(req.prompt.startsWith(`${LANE_PREFACE}\n\nSYSTEM\n\n`)).toBe(true);
    expect(req.prompt.endsWith("Paco: 你觉得 NAS 放在客厅还是书房更好？")).toBe(true);
  });
  it("the deadline is what is left of the lane's budget, never more than 45 s", async () => {
    const compose = vi.fn(async (_r: ComposeRequest) => ok("x"));
    await runAnswerLane(input({ deadlineAt: T0 + 30_000 }), deps(compose));
    expect(compose.mock.calls[0]![0].deadlineMs).toBe(30_000);
    expect(await runAnswerLane(input({ deadlineAt: T0 }), deps(compose))).toEqual({ kind: "fallthrough", why: "lane_timeout" });
  });
  it.each([
    ["every leg failed", { ok: false, provider: "omp", error: "all lane legs failed — anthropic/claude-sonnet-5-5: quota" }, "compose_failed"],
    ["a leg timed out (the provider's own wording, omp.ts timedOut → timed out)", { ok: false, provider: "omp", error: "all lane legs failed — anthropic/claude-sonnet-5-5: timed out" }, "compose_timeout"],
    ["empty text", ok("   "), "empty_reply"]
  ] as const)("%s → fallthrough:%s", async (_n, result, why) => {
    expect(await runAnswerLane(input(), deps(async () => result as LlmResult))).toEqual({ kind: "fallthrough", why });
  });
  it("a chain that spent its whole bound is compose_timeout even without the provider's wording (the deadline cut the last leg)", async () => {
    let clock = T0; // deps(...).now reads this; the compose stub advances it by the full 45 s bound before failing
    const d = deps(async () => { clock += 45_000; return { ok: false, provider: "omp", error: "all lane legs failed — anthropic/claude-sonnet-5-5: exit 1: killed" } as LlmResult; }, { now: () => clock });
    expect(await runAnswerLane(input(), d)).toEqual({ kind: "fallthrough", why: "compose_timeout" });
  });
  it("no Fast candidate → no_fast_leg, and no compose call", async () => {
    const compose = vi.fn(async () => ok("x"));
    expect(await runAnswerLane(input(), deps(compose, { fastChain: () => [] }))).toEqual({ kind: "fallthrough", why: "no_fast_leg" });
    expect(compose).not.toHaveBeenCalled();
  });
  it("an abort during the compose is aborted (no card, no planner), whatever the compose returned", async () => {
    const ctl = new AbortController();
    const r = await runAnswerLane(input({ signal: ctl.signal }), deps(async () => { ctl.abort(); return ok("late"); }));
    expect(r).toEqual({ kind: "fallthrough", why: "aborted" });
  });
  it("a throwing dep is lane_threw, never a throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runAnswerLane(input(), deps(async () => ok("x"), { retrieve: async () => { throw new Error("boom"); } }));
    expect(r).toEqual({ kind: "fallthrough", why: "lane_threw" });
    expect(String(err.mock.calls[0]![0])).toContain("run_1");
    err.mockRestore();
  });
});
