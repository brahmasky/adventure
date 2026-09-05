import { describe, expect, it } from "vitest";
import { normalizeAgyUsage, normalizeCodexUsage } from "../../src/run/llm-usage.js";

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

// Real shape (validated live 2026-09-06 against `agy --output-format json`):
//  {"usage":{"input_tokens":13379,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":13380}}

describe("normalizeAgyUsage", () => {
  it("does NOT add thinking_tokens to output — agy nests them inside it", () => {
    // Measured live (Gemini 3.1 Pro High): in 5590 / out 1511 / thinking 842 / total 7101.
    // total == input + output EXACTLY, so thinking is already counted in output. Adding it
    // would break agy's own identity and inflate output ~56% on any reasoning model.
    expect(
      normalizeAgyUsage({
        input_tokens: 5590,
        output_tokens: 1511,
        thinking_tokens: 842,
        cache_read_tokens: 8090,
        total_tokens: 7101
      })
    ).toEqual({ input_tokens: 5590, output_tokens: 1511, cached_input_tokens: 8090 });
  });

  it("keeps agy's total_tokens identity intact for a thinking-heavy call", () => {
    // The invariant that proves the subset relationship, pinned so a future "fold it back in"
    // change has to argue with real numbers.
    const usage = normalizeAgyUsage({
      input_tokens: 5284,
      output_tokens: 1353,
      thinking_tokens: 905,
      cache_read_tokens: 0,
      total_tokens: 6637
    })!;
    expect(usage.input_tokens + usage.output_tokens).toBe(6637);
  });

  it("maps cache_read_tokens to cached input", () => {
    expect(
      normalizeAgyUsage({
        input_tokens: 13379,
        output_tokens: 40,
        thinking_tokens: 0,
        cache_read_tokens: 8128,
        total_tokens: 13419
      })
    ).toEqual({ input_tokens: 13379, output_tokens: 40, cached_input_tokens: 8128 });
  });

  it("handles a zero-thinking envelope unchanged", () => {
    expect(
      normalizeAgyUsage({
        input_tokens: 13379,
        output_tokens: 1,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 13380
      })
    ).toEqual({ input_tokens: 13379, output_tokens: 1, cached_input_tokens: 0 });
  });

  it("ignores total_tokens rather than deriving from it", () => {
    // Measured: agy's total IS input + output — which is exactly why it carries no information
    // the components don't, and every consumer wants the components.
    expect(normalizeAgyUsage({ input_tokens: 5264, output_tokens: 56, total_tokens: 5320 }))
      .toEqual({ input_tokens: 5264, output_tokens: 56, cached_input_tokens: 0 });
  });

  it("returns null for a missing, non-object, or token-less usage block", () => {
    expect(normalizeAgyUsage(undefined)).toBeNull();
    expect(normalizeAgyUsage(null)).toBeNull();
    expect(normalizeAgyUsage("nope")).toBeNull();
    expect(normalizeAgyUsage({})).toBeNull();
    expect(normalizeAgyUsage({ total_tokens: 12 })).toBeNull();
  });

  it("is tolerant of garbage values (never throws, coerces to 0)", () => {
    expect(normalizeAgyUsage({ input_tokens: "abc", output_tokens: -5, thinking_tokens: null }))
      .toEqual({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });
  });
});
