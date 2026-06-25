import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  CLAUDE_BIN_UNSET,
  parseVerdict,
  resolveClaudeBin,
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

  it("resolveClaudeTimeoutMs defaults to 120000, honors a valid override, rejects garbage", () => {
    expect(resolveClaudeTimeoutMs({})).toBe(120_000);
    expect(resolveClaudeTimeoutMs({ HOUGE_CLAUDE_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(resolveClaudeTimeoutMs({ HOUGE_CLAUDE_TIMEOUT_MS: "nope" })).toBe(120_000);
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

  it("spawns the Claude bin in print mode and returns the parsed verdict", () => {
    const bin = fakeBin("claude", '{"verdict":"reject","reasons":["no-op fix"]}');
    const result = reviewDiff({ task: "fix it", diff: "the diff", env: { HOUGE_CLAUDE_BIN: bin } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict.verdict).toBe("reject");
  });

  it("maps an unparseable Claude response to a clean error", () => {
    const bin = fakeBin("claude", "I think it looks fine to me, no JSON here.");
    const result = reviewDiff({ task: "fix it", diff: "the diff", env: { HOUGE_CLAUDE_BIN: bin } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unparseable/);
  });

  it("dispatches to the Codex fallback when reviewer=codex", () => {
    const bin = fakeBin("codex", '{"verdict":"pass","fixes_task":true}');
    const result = reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: { HOUGE_SELFWRITE_REVIEWER: "codex", HOUGE_CODEX_BIN: bin }
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict.verdict).toBe("pass");
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
