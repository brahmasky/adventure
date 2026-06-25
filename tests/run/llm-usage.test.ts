import { describe, expect, it } from "vitest";
import { normalizeClaudeUsage, normalizeCodexUsage } from "../../src/run/llm-usage.js";

// Real shapes copied from the spikes (scripts/spike-claude-*-p3.mjs):
//  - Claude `--output-format json` envelope carries `usage` + `total_cost_usd`.
//  - Codex `--json` streams JSONL; usage is in the LAST `token_count` event's `total_token_usage`.

describe("normalizeClaudeUsage", () => {
  it("maps the Claude envelope usage: input_tokens is the cache-INCLUSIVE total (fresh + cache), cached is the subset", () => {
    const envelope = JSON.stringify({
      is_error: false,
      num_turns: 3,
      result: '{"verdict":"pass"}',
      total_cost_usd: 0.072,
      usage: {
        input_tokens: 5, // Claude reports FRESH (non-cached) input here
        output_tokens: 317,
        cache_read_input_tokens: 63046,
        cache_creation_input_tokens: 7972
      }
    });
    expect(normalizeClaudeUsage(envelope)).toEqual({
      input_tokens: 5 + 63046 + 7972, // total prompt = fresh + cache (comparable to codex)
      output_tokens: 317,
      cached_input_tokens: 63046 + 7972,
      cost_usd: 0.072
    });
  });

  it("accepts an already-parsed object", () => {
    expect(
      normalizeClaudeUsage({ usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.5 })
    ).toEqual({ input_tokens: 1, output_tokens: 2, cached_input_tokens: 0, cost_usd: 0.5 });
  });

  it("omits cost_usd when total_cost_usd is absent or not a number", () => {
    const u = normalizeClaudeUsage({ usage: { input_tokens: 1, output_tokens: 2 } });
    expect(u).toEqual({ input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 });
    expect(u && "cost_usd" in u).toBe(false);
  });

  it("is tolerant: returns null on garbage / missing usage (never throws)", () => {
    expect(normalizeClaudeUsage("not json {{{")).toBeNull();
    expect(normalizeClaudeUsage("")).toBeNull();
    expect(normalizeClaudeUsage("[1,2,3]")).toBeNull();
    expect(normalizeClaudeUsage({ is_error: true })).toBeNull(); // no usage block
    expect(normalizeClaudeUsage({ usage: "nope" } as unknown as object)).toBeNull();
  });

  it("coerces missing/garbage token counts to 0", () => {
    expect(normalizeClaudeUsage({ usage: { input_tokens: "x" } })).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0
    });
  });
});

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
