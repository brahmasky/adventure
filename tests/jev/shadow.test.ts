import { describe, expect, it, vi } from "vitest";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { intentShadowPayload, JEV_SHADOW_DEADLINE_MS, resolveJevShadowEnabled, runJevShadow, type JevShadowOutcome } from "../../src/jev/shadow.js";
import { MAX_LATEST_MESSAGE_CHARS } from "../../src/jev/intent-question.js";

const ok = (choice = "research", confidence = 0.91, model = "jev-1.13.0"): JevResult => ({
  ok: true, model, input_tokens: 700, latency_ms: 240,
  answers: { intent: { choice, confidence, probabilities: { answer: 0.03, research: 0.91, feedback: 0.02, clarify: 0.02, selfcode: 0.01, skill: 0.01 } } }
});

describe("resolveJevShadowEnabled", () => {
  it.each([
    [undefined, false], ["", false], ["0", false], ["false", false], ["no", false],
    ["1", true], ["true", true], [" YES ", true], ["on", true]
  ])("%j → %s (default OFF — sending messages to a third party is opt-in)", (raw, want) => {
    expect(resolveJevShadowEnabled(raw === undefined ? {} : { HOUGE_JEV_SHADOW_ENABLED: raw })).toBe(want);
  });
});

describe("runJevShadow — never rejects; every outcome is a status", () => {
  it("ok: carries Jev's label, confidence, probabilities, model and latency", async () => {
    const call = vi.fn(async (_req: JevRequest) => ok());
    const out = await runJevShadow(call, "what's the RBA rate today?", [], 500, 0);
    expect(out).toMatchObject({ status: "ok", lang: "en", jev: { intent: "research", confidence: 0.91, model: "jev-1.13.0", latency_ms: 240 } });
    expect((call.mock.calls[0]![0].state as { latest_message: string }).latest_message).toBe("what's the RBA rate today?");
  });

  it.each([
    [{ ok: false, reason: "no_key", detail: "TYPESAFE_API_KEY is not set", error_kind: "auth" }, "no_key"],
    [{ ok: false, reason: "fused", detail: "metered fuse latched" }, "fused"],
    [{ ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" }, "auth"],
    [{ ok: false, reason: "error", detail: "timed out after 5000ms", error_kind: "timeout" }, "timeout"],
    [{ ok: false, reason: "error", detail: "HTTP 503", error_kind: "transport" }, "error"],
    [{ ok: false, reason: "error", detail: "response failed validation: probability_sum", error_kind: "parse" }, "error"]
  ] as Array<[JevResult, string]>)("failure %j → status %s, with jev-client's code-owned detail", async (result, status) => {
    const out = await runJevShadow(async () => result, "hi", [], 500, 0);
    expect(out.status).toBe(status);
    expect(out.jev).toBeUndefined();
    expect(out.jev_error).toBe((result as { detail: string }).detail);
  });

  it("a call that throws or rejects becomes status error — it can never reject into a turn", async () => {
    const threw = await runJevShadow(() => { throw new Error("boom"); }, "hi", [], 500, 0);
    const rejected = await runJevShadow(async () => { throw new Error("boom"); }, "hi", [], 500, 0);
    for (const out of [threw, rejected]) expect(out).toMatchObject({ status: "error", jev_error: "shadow call threw" });
  });

  it("a call that never settles resolves timeout at the outer deadline — a row exists even if the client's own timer never fires (Codex B4)", async () => {
    vi.useFakeTimers();
    try {
      const pending = runJevShadow(() => new Promise<JevResult>(() => {}), "hi", [], 500, 0);
      await vi.advanceTimersByTimeAsync(JEV_SHADOW_DEADLINE_MS);
      expect(await pending).toMatchObject({ status: "timeout", lang: "en", jev_error: `no result after ${JEV_SHADOW_DEADLINE_MS}ms (shadow deadline)` });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an over-cap message is skipped without calling Jev (egress cap, never truncated)", async () => {
    const call = vi.fn(async () => ok());
    const out = await runJevShadow(call, "x".repeat(MAX_LATEST_MESSAGE_CHARS + 1), [], 500, 0);
    expect(out.status).toBe("skipped_state_too_large");
    expect(call).not.toHaveBeenCalled();
  });

  it("tags language in code", async () => {
    expect((await runJevShadow(async () => ok(), "帮我研究一下澳洲的利率走势", [], 500, 0)).lang).toBe("zh");
  });
});

describe("intentShadowPayload — the ledger row, joined to the RAW classifier reply", () => {
  const okOutcome: JevShadowOutcome = { status: "ok", lang: "en", modality: "text", jev: { intent: "skill", confidence: 0.8, probabilities: { skill: 0.8, answer: 0.2 }, model: "jev-1.13.0", latency_ms: 300 } };

  it("ok: every jev_* field, the raw label, parsed=true, modality text — and no jev_error", () => {
    const p = intentShadowPayload(okOutcome, '{"intent":"research","query":"rba"}');
    expect(p).toEqual({
      status: "ok", llm_intent: "research", llm_parsed: true, lang: "en", modality: "text",
      jev_intent: "skill", jev_confidence: 0.8, jev_probabilities: { skill: 0.8, answer: 0.2 }, jev_model: "jev-1.13.0", jev_latency_ms: 300
    });
  });

  it("records the classifier's clarify verbatim — the cap/recordedIntent rewrite happens later and must not leak in", () => {
    expect(intentShadowPayload(okOutcome, '{"intent":"clarify","clarifying_question":"which?"}').llm_intent).toBe("clarify");
  });

  it("an unparseable reply is answer/parsed=false — the fallback is not a verdict", () => {
    expect(intentShadowPayload(okOutcome, "I think research")).toMatchObject({ llm_intent: "answer", llm_parsed: false });
  });

  it("failure: jev_error present, no jev_* fields", () => {
    const p = intentShadowPayload({ status: "timeout", lang: "zh", modality: "text", jev_error: "timed out after 5000ms" }, '{"intent":"answer"}');
    expect(p).toEqual({ status: "timeout", llm_intent: "answer", llm_parsed: true, lang: "zh", modality: "text", jev_error: "timed out after 5000ms" });
  });

  it("the modality flows into the request state AND the payload (spec 2026-09-29)", async () => {
    const call = vi.fn(async (_req: JevRequest) => ok());
    const out = await runJevShadow(call, "hello", [], 500, 0, "voice");
    expect((call.mock.calls[0]![0].state as { modality: string }).modality).toBe("voice");
    expect(out.modality).toBe("voice");
    expect(intentShadowPayload(out, '{"intent":"answer"}').modality).toBe("voice");
  });

  it("never carries message text (bodies-out-of-the-ledger)", async () => {
    const secret = "MY-PRIVATE-MESSAGE-5f2c";
    const out = await runJevShadow(async () => ok(), `please look up ${secret}`, [], 500, 0);
    expect(JSON.stringify(intentShadowPayload(out, '{"intent":"research","query":"look up it"}'))).not.toContain(secret);
  });
});
