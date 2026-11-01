import { beforeEach, describe, expect, it } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { RETRY_REASONS, TURN_RETRY, type RetryInput } from "../../src/decisions/entries/turn-retry.js";
import { shouldRecord } from "../../src/decisions/record.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";
import type { LlmErrorKind } from "../../src/llm/audit.js";
import { classifyOmpError, mayRetryOf, RETRYABLE_ERROR_KINDS } from "../../src/omp/omp-frames.js";

const rows: Array<{ verdict: string; reason: string | null }> = [];
const recorder: DecisionRecorder = { record: (_e, r) => { if (!shouldRecord(TURN_RETRY as unknown as AnyEntry, r as never)) return null; rows.push({ verdict: r.verdict, reason: r.reason }); return "d"; } };
beforeEach(() => { rows.length = 0; });
const ctx = { run_id: "r", tool_call_id: null, recorder };
/** The nine kinds classifyOmpError can return (omp-frames.ts:68–78), each reached from a sample error text. */
const SAMPLES: Record<string, string> = { quota: "429 usage limit", auth: "401 unauthenticated", model_missing: "unknown model x", model_refusal: "refusal", aborted: "request aborted", timeout: "timed out", transport: "fetch failed", spawn: "spawn ENOENT", other: "something odd" };
const KINDS = Object.keys(SAMPLES) as LlmErrorKind[];
const all = (): RetryInput[] => KINDS.flatMap((kind) => [false, true].flatMap((routed) => [false, true].flatMap((usedTool) => [false, true].map((retriedOther) => ({ kind, routed, usedTool, retriedOther })))));

describe("turn.retry — a model error moves to the next model or fails the turn (D9)", () => {
  it("is rule-only, unlocked, supervision, tool input, records every consult, fails to final, sound", () => {
    expect(TURN_RETRY.locked).toBeUndefined();
    expect(TURN_RETRY.stage).toBe("supervision");
    expect(TURN_RETRY.input).toBe("tool");
    expect(TURN_RETRY.fail).toBe("final");
    expect(TURN_RETRY.defaultVerdict).toBe("final");
    expect(TURN_RETRY.alwaysRecord).toBe(true);
    expect(TURN_RETRY.reasonCodes).toEqual([...RETRY_REASONS]);
    expect(RETRY_REASONS).toEqual(["quota", "auth", "transport", "timeout", "model_missing", "other_once", "other_unrouted", "other_retried", "other_after_tool", "model_refusal", "aborted", "spawn"]);
    expect(TURN_RETRY.effects.retry).toMatchObject({ kind: "effect", reversible: false });
    expect(TURN_RETRY.effects.final).toMatchObject({ kind: "tighten", reversible: true });
    expect(entryProblems(TURN_RETRY as unknown as AnyEntry)).toEqual([]);
  });
  it("the samples classify to the nine kinds", () => {
    for (const k of KINDS) expect(classifyOmpError(SAMPLES[k] as string)).toBe(k);
  });
  it("mayRetryOf is today's mayRetry expression", () => {
    for (const i of all()) expect(mayRetryOf(i)).toBe(RETRYABLE_ERROR_KINDS.has(i.kind) || (i.kind === "other" && i.routed && !i.usedTool && !i.retriedOther));
  });
  it("verdict ⇔ mayRetryOf over all 72 inputs; every reason is a listed code and agrees with its verdict", () => {
    const retryReasons = new Set(["quota", "auth", "transport", "timeout", "model_missing", "other_once"]);
    for (const i of all()) {
      const r = decideSync(TURN_RETRY, i, ctx);
      expect(r.verdict).toBe(mayRetryOf(i) ? "retry" : "final");
      expect(RETRY_REASONS).toContain(r.reason);
      expect(retryReasons.has(r.reason as string)).toBe(r.verdict === "retry");
    }
    expect(rows).toHaveLength(72); // alwaysRecord: final rows too (Decision 1-A)
  });
  it("other: first match unrouted → retried → after_tool → once", () => {
    const o = (routed: boolean, usedTool: boolean, retriedOther: boolean) => decideSync(TURN_RETRY, { kind: "other", routed, usedTool, retriedOther }, ctx).reason;
    expect(o(false, true, true)).toBe("other_unrouted");
    expect(o(true, true, true)).toBe("other_retried");
    expect(o(true, true, false)).toBe("other_after_tool");
    expect(o(true, false, false)).toBe("other_once");
  });
  it("a non-other kind's reason is the kind", () => {
    expect(decideSync(TURN_RETRY, { kind: "quota", routed: false, usedTool: true, retriedOther: true }, ctx)).toMatchObject({ verdict: "retry", reason: "quota" });
    expect(decideSync(TURN_RETRY, { kind: "model_refusal", routed: true, usedTool: false, retriedOther: false }, ctx)).toMatchObject({ verdict: "final", reason: "model_refusal" });
  });
});
