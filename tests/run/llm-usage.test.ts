import { describe, expect, it } from "vitest";
import { normalizeCodexUsage } from "../../src/run/llm-usage.js";

// Real shape (validated live):
//  - Codex `--json` streams JSONL; usage is in the LAST `token_count` event's `total_token_usage`.

describe("normalizeCodexUsage", () => {
  const tokenCountEvent = (info: Record<string, unknown>): string =>
    JSON.stringify({ type: "token_count", info });

  it("takes the LAST token_count event and folds reasoning into output", () => {
    const stdout = [
      JSON.stringify({ type: "session", id: "s1" }),
      tokenCountEvent({
        total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 }
      }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
      tokenCountEvent({
        total_token_usage: {
          input_tokens: 1200,
          cached_input_tokens: 900,
          output_tokens: 300,
          reasoning_output_tokens: 50,
          total_tokens: 1800
        }
      })
    ].join("\n");
    // The LAST cumulative total wins; output = output + reasoning (300 + 50).
    expect(normalizeCodexUsage(stdout)).toEqual({
      input_tokens: 1200,
      output_tokens: 350,
      cached_input_tokens: 900
    });
  });

  it("ignores non-JSON lines and other event types defensively", () => {
    const stdout = [
      "warning: something to stderr leaked here",
      JSON.stringify({ type: "other" }),
      tokenCountEvent({ total_token_usage: { input_tokens: 7, output_tokens: 3 } })
    ].join("\n");
    expect(normalizeCodexUsage(stdout)).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cached_input_tokens: 0
    });
  });

  it("is tolerant: returns null when no token_count event is present (never throws)", () => {
    expect(normalizeCodexUsage("")).toBeNull();
    expect(normalizeCodexUsage("plain text, no json")).toBeNull();
    expect(normalizeCodexUsage(JSON.stringify({ type: "session" }))).toBeNull();
    expect(normalizeCodexUsage(JSON.stringify({ type: "token_count", info: {} }))).toBeNull();
  });

  // Regression (live gate, 2026-06-25): the REAL `codex exec --json` STDOUT uses a `turn.completed`
  // event with a top-level `usage` object — NOT the rollout-log `token_count`/`total_token_usage`.
  it("handles the real --json stdout shape (turn.completed.usage)", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "x" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"verdict":"pass"}' } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 19060, cached_input_tokens: 10624, output_tokens: 28, reasoning_output_tokens: 10 }
      })
    ].join("\n");
    expect(normalizeCodexUsage(stdout)).toEqual({
      input_tokens: 19060,
      output_tokens: 38, // 28 + 10 reasoning
      cached_input_tokens: 10624
    });
  });
});
