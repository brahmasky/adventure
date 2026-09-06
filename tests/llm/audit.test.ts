import { describe, expect, it } from "vitest";
import { classifyLlmError } from "../../src/llm/audit.js";
import { recordingSink, UNAUDITED_TEST_SINK } from "../helpers/llm-audit.js";

describe("classifyLlmError", () => {
  // Inputs are OUR OWN bounded provider error strings (never vendor prose), so a substring
  // classifier is honest here. Every case is a real message a provider in src/llm/providers emits.
  it.each([
    ["agy binary not found (ENOENT)", "spawn"],
    ["pi spawn error: EACCES", "spawn"],
    ["agy spawn failed: boom", "spawn"],
    ["agy timed out after 60000ms", "timeout"],
    ["Kimi request timed out", "timeout"],
    ["agy status ERROR: timeout waiting for response", "timeout"],
    ['agy status ERROR: invalid model selection (--model "x")', "model_missing"],
    ["pi is not authenticated (run /login)", "auth"],
    ["agy status ERROR: not logged in", "auth"],
    ["KIMI_API_KEY is not set", "auth"],
    ["GEMINI_API_KEY is not set", "auth"],
    ["agy produced no JSON envelope (exit 1)", "parse"],
    ["pi produced no answer (exit 0)", "parse"],
    ["agy produced no answer; tool actions denied: command", "parse"],
    ["pi answer exceeded 262144 byte cap", "parse"],
    ["Kimi response missing message content", "parse"],
    ["Kimi request returned HTTP 503", "transport"],
    ["Gemini request failed: fetch failed", "transport"],
    ["something nobody anticipated", "other"]
  ])("%s → %s", (message, kind) => {
    expect(classifyLlmError(message)).toBe(kind);
  });
});

describe("test sinks", () => {
  it("UNAUDITED_TEST_SINK discards; recordingSink captures in order", () => {
    expect(() => UNAUDITED_TEST_SINK.record({ provider: "pi", role: "answer", outcome: "ok", model: "m", latency_ms: 1 })).not.toThrow();
    const sink = recordingSink();
    sink.record({ provider: "a", role: "answer", outcome: "error", latency_ms: 1, error_kind: "other" });
    sink.record({ provider: "b", role: "answer", outcome: "ok", model: "m", latency_ms: 1 });
    expect(sink.attempts.map((x) => x.provider)).toEqual(["a", "b"]);
  });
});
