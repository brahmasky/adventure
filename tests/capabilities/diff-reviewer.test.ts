import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  CLAUDE_BIN_UNSET,
  parseVerdict,
  resolveClaudeBin,
  resolveClaudeModel,
  resolveClaudeTimeoutMs,
  resolveSelfWriteReviewer,
  reviewDiff
} from "../../src/capabilities/diff-reviewer.js";

let temps: string[] = [];

/** A fake `claude` (or `codex`) that prints `output` on stdout, then exits 0/`exit`. */
function fakeBin(name: string, output: string, exit = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-rev-bin-"));
  temps.push(dir);
  const bin = join(dir, name);
  // Single-quote the payload safely (escape embedded single quotes).
  const safe = output.replace(/'/g, `'\\''`);
  writeFileSync(bin, `#!/usr/bin/env bash\ncat > /dev/null\nprintf '%s' '${safe}'\nexit ${exit}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

/** A Claude `--output-format json` envelope carrying the model's text in `result` + usage. */
function claudeEnvelope(
  resultText: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } = {},
  total_cost_usd = 0.07
): string {
  return JSON.stringify({
    is_error: false,
    num_turns: 1,
    result: resultText,
    total_cost_usd,
    usage: {
      input_tokens: usage.input_tokens ?? 5,
      output_tokens: usage.output_tokens ?? 120,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 6000,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 800
    }
  });
}

/** A codex `--json` JSONL stream: an agent-message line carrying `text`, then a token_count event. */
function codexJsonl(agentText: string): string {
  return [
    JSON.stringify({ type: "session", id: "abc" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: agentText } }),
    JSON.stringify({
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1200,
          cached_input_tokens: 900,
          output_tokens: 300,
          reasoning_output_tokens: 50,
          total_tokens: 1800
        }
      }
    })
  ].join("\n");
}

describe("parseVerdict", () => {
  it("parses a clean JSON verdict object", () => {
    const v = parseVerdict('{"verdict":"pass","fixes_task":true,"introduces_bugs":false,"scope_creep":false,"reasons":["ok"]}');
    expect(v).not.toBeNull();
    expect(v?.verdict).toBe("pass");
    expect(v?.fixes_task).toBe(true);
  });

  it("extracts the JSON from surrounding prose", () => {
    const v = parseVerdict('Sure, here is my review:\n{"verdict":"reject","reasons":["deletes a test"]}\nHope that helps.');
    expect(v?.verdict).toBe("reject");
  });

  it("returns null on garbage", () => {
    expect(parseVerdict("not json at all")).toBeNull();
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict(undefined)).toBeNull();
  });

  it("returns null when the JSON is valid but the verdict field is missing/invalid", () => {
    expect(parseVerdict('{"fixes_task":true}')).toBeNull();
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseVerdict("{ this is { broken json")).toBeNull();
  });

  // Regression (live gate, 2026-06-25): the greedy first-{-to-last-} match broke on a real diff
  // where the reviewer's reasoning contained stray braces before the verdict object.
  it("ignores stray braces in prose and takes the real verdict object", () => {
    const v = parseVerdict(
      'Looking at the code `if (x) { return y; }` and the object `{foo}` mentioned above...\n' +
      '{"verdict":"pass","fixes_task":true,"introduces_bugs":false,"scope_creep":false,"reasons":["ok"]}'
    );
    expect(v?.verdict).toBe("pass");
  });

  it("handles markdown-fenced JSON", () => {
    const v = parseVerdict('Here is my verdict:\n```json\n{"verdict":"reject","reasons":["deletes a test"]}\n```');
    expect(v?.verdict).toBe("reject");
  });

  it("takes the LAST valid verdict object when several appear", () => {
    const v = parseVerdict(
      'Draft: {"verdict":"reject","reasons":["first pass thought"]}\n' +
      'Final: {"verdict":"pass","fixes_task":true,"reasons":["on reflection it is correct"]}'
    );
    expect(v?.verdict).toBe("pass");
  });

  it("matches the verdict case-insensitively", () => {
    expect(parseVerdict('{"verdict":"PASS"}')?.verdict).toBe("pass");
    expect(parseVerdict('{"verdict":" Reject "}')?.verdict).toBe("reject");
  });

  it("does not get fooled by a brace inside a JSON string value", () => {
    const v = parseVerdict('{"verdict":"reject","reasons":["it left a dangling { brace in code"]}');
    expect(v?.verdict).toBe("reject");
  });
});

describe("config resolvers", () => {
  it("resolveSelfWriteReviewer defaults to claude, honors codex", () => {
    expect(resolveSelfWriteReviewer({})).toBe("claude");
    expect(resolveSelfWriteReviewer({ HOUGE_SELFWRITE_REVIEWER: "claude" })).toBe("claude");
    expect(resolveSelfWriteReviewer({ HOUGE_SELFWRITE_REVIEWER: "CODEX" })).toBe("codex");
    expect(resolveSelfWriteReviewer({ HOUGE_SELFWRITE_REVIEWER: "garbage" })).toBe("claude");
  });

  it("resolveClaudeBin returns the disabled sentinel when unset (no bare-claude guess)", () => {
    expect(resolveClaudeBin({})).toBe(CLAUDE_BIN_UNSET);
    expect(resolveClaudeBin({ HOUGE_CLAUDE_BIN: "  " })).toBe(CLAUDE_BIN_UNSET);
    expect(resolveClaudeBin({ HOUGE_CLAUDE_BIN: "/Users/pluo/.local/bin/claude" })).toBe(
      "/Users/pluo/.local/bin/claude"
    );
  });

  it("resolveClaudeTimeoutMs defaults to 180000 (per-attempt), honors a valid override, rejects garbage", () => {
    expect(resolveClaudeTimeoutMs({})).toBe(180_000);
    expect(resolveClaudeTimeoutMs({ HOUGE_CLAUDE_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(resolveClaudeTimeoutMs({ HOUGE_CLAUDE_TIMEOUT_MS: "nope" })).toBe(180_000);
  });

  it("resolveClaudeModel defaults to sonnet, honors an override", () => {
    expect(resolveClaudeModel({})).toBe("sonnet");
    expect(resolveClaudeModel({ HOUGE_CLAUDE_MODEL: "opus" })).toBe("opus");
    expect(resolveClaudeModel({ HOUGE_CLAUDE_MODEL: "  " })).toBe("sonnet");
  });
});

describe("buildReviewPrompt", () => {
  it("includes the task, the diff, and the JSON-shape instruction (adversarial reviewer)", () => {
    const prompt = buildReviewPrompt("fix the 猴哥 bug", "diff --git a/x b/x\n+identity");
    expect(prompt).toContain("fix the 猴哥 bug");
    expect(prompt).toContain("diff --git a/x b/x");
    expect(prompt).toContain('{"verdict":"pass"|"reject"');
    expect(prompt).toMatch(/INDEPENDENT, adversarial code reviewer/);
    expect(prompt).toMatch(/Do NOT rubber-stamp/);
  });
});

describe("reviewDiff", () => {
  it("returns disabled error when reviewer=claude but HOUGE_CLAUDE_BIN is unset", () => {
    const result = reviewDiff({ task: "t", diff: "d", env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/disabled|HOUGE_CLAUDE_BIN/);
  });

  it("spawns the Claude bin and parses the verdict from the JSON envelope's result field", () => {
    const bin = fakeBin("claude", claudeEnvelope('{"verdict":"reject","reasons":["no-op fix"]}'));
    const result = reviewDiff({ task: "fix it", diff: "the diff", env: { HOUGE_CLAUDE_BIN: bin } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict.verdict).toBe("reject");
  });

  it("returns normalized Claude usage from the envelope on a successful review", () => {
    const bin = fakeBin(
      "claude",
      claudeEnvelope('{"verdict":"pass","fixes_task":true}', {
        input_tokens: 10,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 1000
      }, 0.08)
    );
    const result = reviewDiff({ task: "fix it", diff: "the diff", env: { HOUGE_CLAUDE_BIN: bin } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // input_tokens is the cache-INCLUSIVE total (fresh 10 + cache 6000), comparable across providers;
      // cached = cache_read + cache_creation; cost from total_cost_usd.
      expect(result.usage).toEqual({
        input_tokens: 10 + 6000,
        output_tokens: 200,
        cached_input_tokens: 6000,
        cost_usd: 0.08
      });
    }
  });

  it("maps an unparseable Claude response (no verdict in result) to a clean error", () => {
    const bin = fakeBin("claude", claudeEnvelope("I think it looks fine to me, no JSON here."));
    const result = reviewDiff({ task: "fix it", diff: "the diff", env: { HOUGE_CLAUDE_BIN: bin } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unparseable/);
  });

  it("dispatches to the Codex fallback (--json JSONL) when reviewer=codex and returns usage", () => {
    const bin = fakeBin("codex", codexJsonl('{"verdict":"pass","fixes_task":true}'));
    const result = reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: { HOUGE_SELFWRITE_REVIEWER: "codex", HOUGE_CODEX_BIN: bin }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.verdict).toBe("pass");
      // output includes reasoning_output_tokens (300 + 50); cached from cached_input_tokens.
      expect(result.usage).toEqual({
        input_tokens: 1200,
        output_tokens: 350,
        cached_input_tokens: 900
      });
    }
  });

  it("maps a missing reviewer binary (ENOENT) to a clean error", () => {
    const result = reviewDiff({
      task: "t",
      diff: "d",
      env: { HOUGE_CLAUDE_BIN: "/nonexistent/claude-binary-xyz" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });
});
