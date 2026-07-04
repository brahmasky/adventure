import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  CLAUDE_BIN_UNSET,
  KIMI_CLI_BIN_UNSET,
  parseVerdict,
  resolveClaudeBin,
  resolveClaudeModel,
  resolveClaudeTimeoutMs,
  resolveKimiCliBin,
  resolveKimiCliModel,
  resolveKimiCliTimeoutMs,
  resolveSelfWriteReviewer,
  reviewDiff,
  writeKimiReviewerAgent
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

/** A fake bin that records argv + stdin to files, then prints `output` on stdout and exits 0/`exit`. */
function capturingBin(name: string, output: string, opts: { argvFile?: string; stdinFile?: string } = {}, exit = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-rev-bin-"));
  temps.push(dir);
  const bin = join(dir, name);
  const safe = output.replace(/'/g, `'\\''`);
  const lines = ["#!/usr/bin/env bash"];
  if (opts.argvFile) {
    lines.push(`: > "${opts.argvFile}"`);
    lines.push(`for a in "$@"; do printf '%s\\n' "$a" >> "${opts.argvFile}"; done`);
  }
  if (opts.stdinFile) lines.push(`cat > "${opts.stdinFile}"`);
  else lines.push("cat > /dev/null");
  lines.push(`printf '%s' '${safe}'`);
  lines.push(`exit ${exit}`);
  writeFileSync(bin, lines.join("\n") + "\n");
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

/** kimi-cli `--final-message-only` stdout: the plain-text verdict JSON, then the trailing resume line. */
function kimiOutput(verdictJson: string): string {
  return `${verdictJson}\nTo resume this session: kimi -r 2e9db88f-3ec0-4268-a589-89bbc315c74f`;
}

describe("parseVerdict", () => {
  it("parses a clean JSON verdict object", async () => {
    const v = parseVerdict('{"verdict":"pass","fixes_task":true,"introduces_bugs":false,"scope_creep":false,"reasons":["ok"]}');
    expect(v).not.toBeNull();
    expect(v?.verdict).toBe("pass");
    expect(v?.fixes_task).toBe(true);
  });

  it("extracts the JSON from surrounding prose", async () => {
    const v = parseVerdict('Sure, here is my review:\n{"verdict":"reject","reasons":["deletes a test"]}\nHope that helps.');
    expect(v?.verdict).toBe("reject");
  });

  it("returns null on garbage", async () => {
    expect(parseVerdict("not json at all")).toBeNull();
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict(undefined)).toBeNull();
  });

  it("returns null when the JSON is valid but the verdict field is missing/invalid", async () => {
    expect(parseVerdict('{"fixes_task":true}')).toBeNull();
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseVerdict("{ this is { broken json")).toBeNull();
  });

  // Regression (live gate, 2026-06-25): the greedy first-{-to-last-} match broke on a real diff
  // where the reviewer's reasoning contained stray braces before the verdict object.
  it("ignores stray braces in prose and takes the real verdict object", async () => {
    const v = parseVerdict(
      'Looking at the code `if (x) { return y; }` and the object `{foo}` mentioned above...\n' +
      '{"verdict":"pass","fixes_task":true,"introduces_bugs":false,"scope_creep":false,"reasons":["ok"]}'
    );
    expect(v?.verdict).toBe("pass");
  });

  it("handles markdown-fenced JSON", async () => {
    const v = parseVerdict('Here is my verdict:\n```json\n{"verdict":"reject","reasons":["deletes a test"]}\n```');
    expect(v?.verdict).toBe("reject");
  });

  it("takes the LAST valid verdict object when several appear", async () => {
    const v = parseVerdict(
      'Draft: {"verdict":"reject","reasons":["first pass thought"]}\n' +
      'Final: {"verdict":"pass","fixes_task":true,"reasons":["on reflection it is correct"]}'
    );
    expect(v?.verdict).toBe("pass");
  });

  it("matches the verdict case-insensitively", async () => {
    expect(parseVerdict('{"verdict":"PASS"}')?.verdict).toBe("pass");
    expect(parseVerdict('{"verdict":" Reject "}')?.verdict).toBe("reject");
  });

  it("does not get fooled by a brace inside a JSON string value", async () => {
    const v = parseVerdict('{"verdict":"reject","reasons":["it left a dangling { brace in code"]}');
    expect(v?.verdict).toBe("reject");
  });
});

describe("config resolvers", () => {
  it("resolveSelfWriteReviewer defaults to kimi, honors claude and codex", async () => {
    expect(resolveSelfWriteReviewer({})).toBe("kimi"); // default flipped to kimi (cheap + diverse)
    expect(resolveSelfWriteReviewer({ HOUGE_SELFWRITE_REVIEWER: "claude" })).toBe("claude");
    expect(resolveSelfWriteReviewer({ HOUGE_SELFWRITE_REVIEWER: "CODEX" })).toBe("codex");
    expect(resolveSelfWriteReviewer({ HOUGE_SELFWRITE_REVIEWER: "kimi" })).toBe("kimi");
    expect(resolveSelfWriteReviewer({ HOUGE_SELFWRITE_REVIEWER: "  CLAUDE " })).toBe("claude");
    expect(resolveSelfWriteReviewer({ HOUGE_SELFWRITE_REVIEWER: "garbage" })).toBe("kimi");
  });

  it("resolveClaudeBin returns the disabled sentinel when unset (no bare-claude guess)", async () => {
    expect(resolveClaudeBin({})).toBe(CLAUDE_BIN_UNSET);
    expect(resolveClaudeBin({ HOUGE_CLAUDE_BIN: "  " })).toBe(CLAUDE_BIN_UNSET);
    expect(resolveClaudeBin({ HOUGE_CLAUDE_BIN: "/Users/pluo/.local/bin/claude" })).toBe(
      "/Users/pluo/.local/bin/claude"
    );
  });

  it("resolveClaudeTimeoutMs defaults to 180000 (per-attempt), honors a valid override, rejects garbage", async () => {
    expect(resolveClaudeTimeoutMs({})).toBe(180_000);
    expect(resolveClaudeTimeoutMs({ HOUGE_CLAUDE_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(resolveClaudeTimeoutMs({ HOUGE_CLAUDE_TIMEOUT_MS: "nope" })).toBe(180_000);
  });

  it("resolveClaudeModel defaults to sonnet, honors an override", async () => {
    expect(resolveClaudeModel({})).toBe("sonnet");
    expect(resolveClaudeModel({ HOUGE_CLAUDE_MODEL: "opus" })).toBe("opus");
    expect(resolveClaudeModel({ HOUGE_CLAUDE_MODEL: "  " })).toBe("sonnet");
  });

  it("resolveKimiCliBin returns the disabled sentinel when unset (no bare-kimi-cli guess)", async () => {
    expect(resolveKimiCliBin({})).toBe(KIMI_CLI_BIN_UNSET);
    expect(resolveKimiCliBin({ HOUGE_KIMI_CLI_BIN: "  " })).toBe(KIMI_CLI_BIN_UNSET);
    expect(resolveKimiCliBin({ HOUGE_KIMI_CLI_BIN: "/Users/pluo/.local/bin/kimi-cli" })).toBe(
      "/Users/pluo/.local/bin/kimi-cli"
    );
  });

  it("resolveKimiCliModel is empty (omit --model) when unset, honors an override", async () => {
    expect(resolveKimiCliModel({})).toBe("");
    expect(resolveKimiCliModel({ HOUGE_KIMI_CLI_MODEL: "  " })).toBe("");
    expect(resolveKimiCliModel({ HOUGE_KIMI_CLI_MODEL: "kimi-for-coding" })).toBe("kimi-for-coding");
  });

  it("resolveKimiCliTimeoutMs defaults to 180000 (per-attempt), honors a valid override, rejects garbage", async () => {
    expect(resolveKimiCliTimeoutMs({})).toBe(180_000);
    expect(resolveKimiCliTimeoutMs({ HOUGE_KIMI_CLI_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(resolveKimiCliTimeoutMs({ HOUGE_KIMI_CLI_TIMEOUT_MS: "nope" })).toBe(180_000);
  });
});

describe("buildReviewPrompt", () => {
  it("includes the task, the diff, and the JSON-shape instruction (adversarial reviewer)", async () => {
    const prompt = buildReviewPrompt("fix the 猴哥 bug", "diff --git a/x b/x\n+identity");
    expect(prompt).toContain("fix the 猴哥 bug");
    expect(prompt).toContain("diff --git a/x b/x");
    expect(prompt).toContain('{"verdict":"pass"|"reject"');
    expect(prompt).toMatch(/INDEPENDENT, adversarial code reviewer/);
    expect(prompt).toMatch(/Do NOT rubber-stamp/);
  });
});

describe("reviewDiff", () => {
  it("defaults to the kimi reviewer; returns disabled error when HOUGE_KIMI_CLI_BIN is unset", async () => {
    const result = await reviewDiff({ task: "t", diff: "d", env: {} }); // no reviewer set → default kimi
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/kimi reviewer disabled/);
  });

  it("returns disabled error when reviewer=claude but HOUGE_CLAUDE_BIN is unset", async () => {
    const result = await reviewDiff({ task: "t", diff: "d", env: { HOUGE_SELFWRITE_REVIEWER: "claude" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/disabled|HOUGE_CLAUDE_BIN/);
  });

  it("spawns the Claude bin and parses the verdict from the JSON envelope's result field", async () => {
    const bin = fakeBin("claude", claudeEnvelope('{"verdict":"reject","reasons":["no-op fix"]}'));
    const result = await reviewDiff({ task: "fix it", diff: "the diff", env: { HOUGE_SELFWRITE_REVIEWER: "claude", HOUGE_CLAUDE_BIN: bin } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict.verdict).toBe("reject");
  });

  it("returns normalized Claude usage from the envelope on a successful review", async () => {
    const bin = fakeBin(
      "claude",
      claudeEnvelope('{"verdict":"pass","fixes_task":true}', {
        input_tokens: 10,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 1000
      }, 0.08)
    );
    const result = await reviewDiff({ task: "fix it", diff: "the diff", env: { HOUGE_SELFWRITE_REVIEWER: "claude", HOUGE_CLAUDE_BIN: bin } });
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

  it("maps an unparseable Claude response (no verdict in result) to a clean error", async () => {
    const bin = fakeBin("claude", claudeEnvelope("I think it looks fine to me, no JSON here."));
    const result = await reviewDiff({ task: "fix it", diff: "the diff", env: { HOUGE_SELFWRITE_REVIEWER: "claude", HOUGE_CLAUDE_BIN: bin } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unparseable/);
  });

  it("dispatches to the Codex fallback (--json JSONL) when reviewer=codex and returns usage", async () => {
    const bin = fakeBin("codex", codexJsonl('{"verdict":"pass","fixes_task":true}'));
    const result = await reviewDiff({
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

  it("maps a missing reviewer binary (ENOENT) to a clean error", async () => {
    const result = await reviewDiff({
      task: "t",
      diff: "d",
      env: { HOUGE_SELFWRITE_REVIEWER: "claude", HOUGE_CLAUDE_BIN: "/nonexistent/claude-binary-xyz" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });

  it("returns disabled error when reviewer=kimi but HOUGE_KIMI_CLI_BIN is unset", async () => {
    const result = await reviewDiff({ task: "t", diff: "d", env: { HOUGE_SELFWRITE_REVIEWER: "kimi" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/disabled|HOUGE_KIMI_CLI_BIN/);
  });

  it("dispatches to the kimi reviewer (plain-text stdout + trailing resume line) and parses a pass", async () => {
    const bin = fakeBin("kimi-cli", kimiOutput('{"verdict":"pass","fixes_task":true,"introduces_bugs":false,"scope_creep":false}'));
    const result = await reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: bin }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.verdict).toBe("pass");
      // final-message-only emits no usage telemetry → no usage on the result.
      expect(result.usage).toBeUndefined();
    }
  });

  it("dispatches to the kimi reviewer and parses a reject (a real answer, not retried)", async () => {
    const bin = fakeBin("kimi-cli", kimiOutput('{"verdict":"reject","reasons":["deletes a test to pass the gate"]}'));
    const result = await reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: bin }
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict.verdict).toBe("reject");
  });

  it("maps an unparseable kimi response to a clean error", async () => {
    const bin = fakeBin("kimi-cli", "I think it looks fine to me, no JSON here.");
    const result = await reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: bin }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unparseable/);
  });

  it("passes the prompt on stdin and the expected argv to kimi-cli (no --model when unset)", async () => {
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-rev-cap-")), "argv");
    const stdinFile = join(mkdtempSync(join(tmpdir(), "houge-rev-cap-")), "stdin");
    temps.push(argvFile, stdinFile);
    const bin = capturingBin("kimi-cli", kimiOutput('{"verdict":"pass"}'), { argvFile, stdinFile });

    const result = await reviewDiff({
      task: "fix the 猴哥 bug",
      diff: "diff --git a/x b/x",
      env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: bin }
    });
    expect(result.ok).toBe(true);

    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    // Fixed leading flags; then --agent-file pins the no-tools reviewer agent (dynamic temp path).
    expect(argv.slice(0, 5)).toEqual(["--print", "--quiet", "--final-message-only", "--input-format", "text"]);
    const ai = argv.indexOf("--agent-file");
    expect(ai).toBeGreaterThan(-1);
    expect(argv[ai + 1]).toMatch(/reviewer\.yaml$/);
    expect(argv).not.toContain("--model");
    // The adversarial review prompt (task + diff) arrives on stdin.
    const stdin = readFileSync(stdinFile, "utf8");
    expect(stdin).toContain("fix the 猴哥 bug");
    expect(stdin).toContain("diff --git a/x b/x");
    expect(stdin).toContain("INDEPENDENT, adversarial code reviewer");
  });

  it("confines the kimi reviewer to a NO-TOOLS agent (tools: []) — the writer≠checker isolation fix", async () => {
    const { dir, agentFile } = writeKimiReviewerAgent();
    temps.push(dir);
    const yaml = readFileSync(agentFile, "utf8");
    // tools: [] strips Shell/ReadFile/etc., so a prompt-injected diff can't make the reviewer
    // read/write the host (proven live: an unconfined kimi-cli read a secret + wrote into the repo).
    expect(yaml).toContain("tools: []");
    expect(yaml).toContain("system_prompt_path: ./reviewer-system.md");
    expect(existsSync(join(dir, "reviewer-system.md"))).toBe(true);
  });

  it("passes --model to kimi-cli when HOUGE_KIMI_CLI_MODEL is set", async () => {
    const argvFile = join(mkdtempSync(join(tmpdir(), "houge-rev-cap-")), "argv");
    temps.push(argvFile);
    const bin = capturingBin("kimi-cli", kimiOutput('{"verdict":"pass"}'), { argvFile });

    const result = await reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: bin, HOUGE_KIMI_CLI_MODEL: "kimi-for-coding" }
    });
    expect(result.ok).toBe(true);

    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv.slice(0, 5)).toEqual(["--print", "--quiet", "--final-message-only", "--input-format", "text"]);
    expect(argv).toContain("--agent-file");
    expect(argv.slice(-2)).toEqual(["--model", "kimi-for-coding"]);
  });

  it("maps a missing kimi-cli binary (ENOENT) to a clean error", async () => {
    const result = await reviewDiff({
      task: "t",
      diff: "d",
      env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: "/nonexistent/kimi-cli-xyz" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });
});

describe("reviewDiff — H1 fallback chain (unavailable → next backend; a delivered verdict is terminal)", () => {
  it("records the winning backend on a primary success (attribution)", async () => {
    const bin = fakeBin("kimi-cli", kimiOutput('{"verdict":"pass","fixes_task":true}'));
    const result = await reviewDiff({ task: "t", diff: "d", env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: bin } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reviewer).toBe("kimi");
  });

  it("configured kimi unavailable → falls to claude, whose PASS verdict wins with attribution", async () => {
    const claude = fakeBin("claude", claudeEnvelope('{"verdict":"pass","fixes_task":true}'));
    const result = await reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: "/nonexistent/kimi-cli-xyz", HOUGE_CLAUDE_BIN: claude }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.verdict).toBe("pass");
      expect(result.reviewer).toBe("claude");
    }
  });

  it("a fallback REJECT is a delivered verdict: terminal for the chain, codex never probed", async () => {
    const claude = fakeBin("claude", claudeEnvelope('{"verdict":"reject","reasons":["scope creep"]}'));
    const codexArgv = join(mkdtempSync(join(tmpdir(), "houge-rev-cap-")), "argv");
    temps.push(codexArgv);
    const codex = capturingBin("codex", codexJsonl('{"verdict":"pass"}'), { argvFile: codexArgv });
    const result = await reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: {
        HOUGE_SELFWRITE_REVIEWER: "kimi",
        HOUGE_KIMI_CLI_BIN: "/nonexistent/kimi-cli-xyz",
        HOUGE_CLAUDE_BIN: claude,
        HOUGE_CODEX_ENABLED: "1",
        HOUGE_CODEX_BIN: codex
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.verdict).toBe("reject"); // never fallen past to codex's pass
      expect(result.reviewer).toBe("claude");
    }
    expect(existsSync(codexArgv)).toBe(false); // codex never spawned
  });

  it("skips a DISABLED codex fallback (HOUGE_CODEX_ENABLED off) instead of spawning it", async () => {
    const codexArgv = join(mkdtempSync(join(tmpdir(), "houge-rev-cap-")), "argv");
    temps.push(codexArgv);
    const codex = capturingBin("codex", codexJsonl('{"verdict":"pass"}'), { argvFile: codexArgv });
    const result = await reviewDiff({
      task: "t",
      diff: "d",
      env: { HOUGE_SELFWRITE_REVIEWER: "kimi", HOUGE_KIMI_CLI_BIN: "/nonexistent/kimi-cli-xyz", HOUGE_CODEX_BIN: codex }
    });
    expect(result.ok).toBe(false); // kimi ENOENT, claude unset, codex disabled → chain exhausted
    if (!result.ok) {
      expect(result.error).toMatch(/kimi reviewer binary not found/);
      expect(result.error).toMatch(/claude reviewer skipped \(not configured\)/);
      expect(result.error).toMatch(/codex reviewer skipped \(not configured\)/);
    }
    expect(existsSync(codexArgv)).toBe(false); // disabled → never spawned
  });

  it("falls through to an ENABLED codex when kimi and claude are both unavailable", async () => {
    const codex = fakeBin("codex", codexJsonl('{"verdict":"pass","fixes_task":true}'));
    const result = await reviewDiff({
      task: "fix it",
      diff: "the diff",
      env: {
        HOUGE_SELFWRITE_REVIEWER: "kimi",
        HOUGE_KIMI_CLI_BIN: "/nonexistent/kimi-cli-xyz",
        HOUGE_CODEX_ENABLED: "1",
        HOUGE_CODEX_BIN: codex
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reviewer).toBe("codex");
  });

  it("whole chain unavailable → the attempt fails exactly as before, with every backend's detail", async () => {
    const result = await reviewDiff({
      task: "t",
      diff: "d",
      env: {
        HOUGE_SELFWRITE_REVIEWER: "claude",
        HOUGE_CLAUDE_BIN: "/nonexistent/claude-xyz",
        HOUGE_KIMI_CLI_BIN: "/nonexistent/kimi-cli-xyz"
      }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Claude reviewer binary not found/);
      expect(result.error).toMatch(/kimi reviewer binary not found/);
      expect(result.error).toMatch(/codex reviewer skipped/);
    }
  });

  it("the chain honors the configured reviewer FIRST (claude configured → kimi is the fallback)", async () => {
    const claude = fakeBin("claude", claudeEnvelope('{"verdict":"pass"}'));
    const kimi = fakeBin("kimi-cli", kimiOutput('{"verdict":"reject","reasons":["should not be reached"]}'));
    const result = await reviewDiff({
      task: "t",
      diff: "d",
      env: { HOUGE_SELFWRITE_REVIEWER: "claude", HOUGE_CLAUDE_BIN: claude, HOUGE_KIMI_CLI_BIN: kimi }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reviewer).toBe("claude");
      expect(result.verdict.verdict).toBe("pass");
    }
  });
});
