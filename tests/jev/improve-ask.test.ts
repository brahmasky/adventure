import { describe, expect, it, vi } from "vitest";
import { askImprove, IMPROVE_THRESHOLD_VERSION } from "../../src/jev/improve-ask.js";
import { IMPROVE_TARGET } from "../../src/jev/questions/improve.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.3: one choice question in its own request on decision point `improve`; the answer is the choice with its
// probabilities; a failure is a named fallback, never a guessed target.
const state = { signal: "correction", value: "answer", scope: "answer", count: 1, count_14d: 2, category: "answer", lane: "answer", capability: null, paco_text: "shorter please",
  tools: "none", last_improvement: "none", applicable: ["nothing", "lesson", "fact", "tool_gap", "ladder"] as const };
const answering = (probabilities: Record<string, number>) => vi.fn(async (req: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 10, latency_ms: 5,
  answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "choice" as const, choice: "lesson", probabilities, confidence: 0.5 }])) }));

describe("askImprove", () => {
  it("sends the one question with the state and returns the choice answer and model", async () => {
    const client = answering({ nothing: 0.3, lesson: 0.7 });
    const r = await askImprove({ state: state as never, client, store: RunStore.openInMemory() });
    expect(Object.keys(client.mock.calls[0]![0].questions)).toEqual([IMPROVE_TARGET.id]);
    expect(client.mock.calls[0]![0].state).toMatchObject({ paco_text: "shorter please", applicable: [...state.applicable] });
    expect(r).toMatchObject({ answer: { type: "choice", probabilities: { nothing: 0.3, lesson: 0.7 } }, model: "jev-1.13.0" });
  });
  it("timeout → timeout, transport → outage, a non-choice answer → parse", async () => {
    const store = RunStore.openInMemory();
    expect(await askImprove({ state: state as never, client: async () => ({ ok: false, reason: "error", detail: "t", error_kind: "timeout" }), store })).toEqual({ failed: "timeout" });
    expect(await askImprove({ state: state as never, client: async () => ({ ok: false, reason: "error", detail: "t", error_kind: "transport" }), store })).toEqual({ failed: "outage" });
    const noul = vi.fn(async (): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1, answers: { improve_target: { type: "noul", noul: 0.9 } } }));
    expect(await askImprove({ state: state as never, client: noul, store })).toEqual({ failed: "parse" });
  });
  it("the threshold version is pinned", () => { expect(IMPROVE_THRESHOLD_VERSION).toBe("2026-10-21.1"); });
});
