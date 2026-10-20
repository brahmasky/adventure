import { describe, expect, it, vi } from "vitest";
import { askSettle, SETTLE_QUESTIONS, SETTLE_THRESHOLD_VERSION } from "../../src/jev/settle-ask.js";
import { buildSettleState, settleJevState } from "../../src/decisions/settle-state.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §3.3: four noul questions in ONE request on decision point `settle`; all-or-nothing answer validation (one
// malformed answer fails the call, as jev-client.ts:196-202); a failure is a named fallback, never a partial answer.
/** The Jev copy, as the protected builder makes it: askSettle never sees a SettleState (senior plan W). */
const state = () => settleJevState(buildSettleState({ run_id: "run_1", text: "Done, I'll send it tomorrow.", pass: 0, sentBack: false, trust: "clean", lastCallDenied: false, steerQueued: false, msLeft: 100_000,
  aborting: false, evidence: [], todoBefore: null, todoNow: null, pacoMessage: "send it", attachmentsAccepted: 0 }, (x) => x));
const answering = (ps: number[]) => vi.fn(async (req: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 10, latency_ms: 5,
  answers: Object.fromEntries(Object.keys(req.questions).map((id, k) => [id, { type: "noul" as const, noul: ps[k]! }])) }));

describe("askSettle", () => {
  it("asks the four questions in one request with reply, paco_message and tools in the state, and returns p per question id", async () => {
    const client = answering([0.1, 0.2, 0.9, 0.05]);
    const r = await askSettle({ run_id: "run_1", state: state(), client, store: RunStore.openInMemory() });
    expect(client).toHaveBeenCalledTimes(1);
    const req = client.mock.calls[0]![0];
    expect(Object.keys(req.questions)).toEqual(SETTLE_QUESTIONS.map((q) => q.id));
    expect(req.state).toMatchObject({ reply: "Done, I'll send it tomorrow.", paco_message: "send it", tools: "none" });
    expect(r).toEqual({ answers: { settle_claims_done: 0.1, settle_unverified: 0.2, settle_promise: 0.9, settle_asks_permission: 0.05 }, model: "jev-1.13.0" });
  });
  it("a timeout is `timeout`, a transport failure `outage`, a missing answer `parse`", async () => {
    const store = RunStore.openInMemory();
    expect(await askSettle({ run_id: "run_1", state: state(), client: async () => ({ ok: false, reason: "error", detail: "t", error_kind: "timeout" }), store })).toEqual({ failed: "timeout" });
    expect(await askSettle({ run_id: "run_1", state: state(), client: async () => ({ ok: false, reason: "error", detail: "t", error_kind: "transport" }), store })).toEqual({ failed: "outage" });
    const partial = vi.fn(async (req: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1, answers: { [Object.keys(req.questions)[0]!]: { type: "noul", noul: 0.9 } } }));
    expect(await askSettle({ run_id: "run_1", state: state(), client: partial, store })).toEqual({ failed: "parse" });
  });
  it("the threshold version is pinned", () => { expect(SETTLE_THRESHOLD_VERSION).toBe("2026-10-20.1"); });
});
