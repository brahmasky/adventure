import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import {
  createAgyCliProvider,
  AGY_DEFAULT_MODEL,
  ERROR_EXCERPT_MAX
} from "../../../src/llm/providers/agy-cli.js";
import type { SpawnImpl, SpawnResult } from "../../../src/llm/providers/cli-spawn.js";

/** Build a SpawnResult with sane defaults so tests only set what they assert. */
function spawnResult(partial: Partial<SpawnResult> = {}): SpawnResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...partial };
}

/**
 * A real `agy --output-format json` envelope. Shapes below are copied from live probes against
 * agy 2026-09-06 — including the fact that an ERROR envelope still EXITS 0.
 */
function envelope(partial: Record<string, unknown> = {}): string {
  return JSON.stringify({
    conversation_id: "c-1",
    status: "SUCCESS",
    response: "",
    duration_seconds: 1.2,
    num_turns: 1,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    ...partial
  });
}

/** The prompt is whatever follows `--print`, wherever the flags end up ordered. */
function promptArg(args: string[]): string | undefined {
  return args[args.indexOf("--print") + 1];
}

const ENV_KEYS = [
  "HOUGE_AGY_BIN",
  "HOUGE_AGY_MODEL",
  "HOUGE_AGY_ENV_PASSTHROUGH",
  "HOUGE_LLM_TIMEOUT_MS_AGY",
  "HOUGE_LLM_TIMEOUT_MS",
  "HOUGE_TELEGRAM_BOT_TOKEN",
  "GEMINI_API_KEY",
  "AGY_TEST_SECRET"
];

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("createAgyCliProvider", () => {
  it("exposes the provider name 'agy-cli'", () => {
    expect(createAgyCliProvider({ spawnImpl: async () => spawnResult() }).name).toBe("agy-cli");
  });

  it("returns the trimmed `response` field of a SUCCESS envelope as the answer", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ stdout: envelope({ response: "  Paris.\n" }) })
    );
    const provider = createAgyCliProvider({ spawnImpl, model: "Gemini 3.8 Flash (Low)" });

    const result = await provider.answer({ question: "Capital of France?" });

    expect(result).toEqual({
      ok: true,
      provider: "agy-cli",
      model: "Gemini 3.8 Flash (Low)",
      answer: "Paris.",
      // The fixture envelope carries a zeroed usage block; it rides the result (slice 2).
      usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, thinking_tokens: 0 }
    });
  });

  it("requests JSON output, disables slash commands, and passes the prompt as the --print value", async () => {
    // Hermetic: clear BOTH env vars this asserts a default for. HOUGE_AGY_BIN especially — the
    // self-write test-gate runs `npm test` inheriting the daemon's .env (where HOUGE_AGY_BIN is set),
    // so without this delete the binary resolves to the real path and `toBe("agy")` red-fails the gate,
    // silently blocking ALL self-writes (this exact bug blocked the 猴哥 fix, 2026-06-26).
    delete process.env.HOUGE_AGY_MODEL;
    delete process.env.HOUGE_AGY_BIN;
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl });

    await provider.answer({ question: "hello" });

    const [file, args, opts] = spawnImpl.mock.calls[0]!;
    expect(file).toBe("agy");
    expect(args).toEqual([
      "--model",
      AGY_DEFAULT_MODEL,
      "--output-format",
      "json",
      "--disable-slash-commands",
      "--print",
      "hello"
    ]);
    // The prompt rides argv (not stdin); stdin stays empty.
    expect(opts.input).toBe("");
  });

  it("lets HOUGE_AGY_MODEL override the code default", async () => {
    // The design's remedy for the next vendor retirement is "an env edit, not a redeploy" — which
    // is only true if the env actually wins. Asserting the default's literal value instead would
    // be a restatement of the constant that goes red exactly when someone correctly updates it.
    process.env.HOUGE_AGY_MODEL = "Gemini 3.1 Pro (Low)";
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl });

    const result = await provider.answer({ question: "hi" });

    expect(spawnImpl.mock.calls[0]![1][1]).toBe("Gemini 3.1 Pro (Low)");
    expect(result.ok && result.model).toBe("Gemini 3.1 Pro (Low)");
  });

  it("prefers an explicit config model over the env", async () => {
    process.env.HOUGE_AGY_MODEL = "Gemini 3.1 Pro (Low)";
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl, model: "Gemini 3.8 Flash (Low)" });

    await provider.answer({ question: "hi" });

    expect(spawnImpl.mock.calls[0]![1][1]).toBe("Gemini 3.8 Flash (Low)");
  });

  it("folds the system prompt into the prompt (agy has no --system-prompt flag)", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "Q", system: "Be neutral." });

    const args = spawnImpl.mock.calls[0]![1];
    expect(promptArg(args)).toBe("Be neutral.\n\nQ");
  });

  it("keeps a flag-like prompt as ONE argv element (injection-safe)", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });
    const attack = "--dangerously-skip-permissions --model evil";

    await provider.answer({ question: attack });

    const args = spawnImpl.mock.calls[0]![1];
    // The attack string is the single value after --print, never split into separate flags.
    expect(promptArg(args)).toBe(attack);
    // Length is pinned too: the prompt must add exactly ONE element, never split into flags.
    expect(args).toHaveLength(7);
    expect(args.filter((a) => a === "--dangerously-skip-permissions")).toHaveLength(0);
    expect(args.filter((a) => a === "evil")).toHaveLength(0);
  });

  it("never passes --dangerously-skip-permissions", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "hi" });

    expect(spawnImpl.mock.calls[0]![1]).not.toContain("--dangerously-skip-permissions");
  });

  it("always disables slash commands, so untrusted reader content cannot expand one", async () => {
    // agy is agentic and this leg now serves the Dual-LLM reader, whose input is attacker-controlled.
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "/deploy production now" });

    expect(spawnImpl.mock.calls[0]![1]).toContain("--disable-slash-commands");
  });

  it("uses HOUGE_AGY_BIN for the binary path", async () => {
    process.env.HOUGE_AGY_BIN = "/abs/path/agy";
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "hi" });

    expect(spawnImpl.mock.calls[0]![0]).toBe("/abs/path/agy");
  });

  it("excludes secrets from the child env", async () => {
    process.env.HOUGE_TELEGRAM_BOT_TOKEN = "super-secret";
    process.env.GEMINI_API_KEY = "key-should-not-leak";
    process.env.AGY_TEST_SECRET = "nope";
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "hi" });

    const opts = spawnImpl.mock.calls[0]![2];
    expect(opts.env.HOUGE_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(opts.env.GEMINI_API_KEY).toBeUndefined();
    expect(opts.env.AGY_TEST_SECRET).toBeUndefined();
  });

  describe("working directory containment", () => {
    // agy is agentic and roots its workspace at the cwd. `os.tmpdir()` itself is NOT empty — it
    // holds Houge's own live state (approval-park/resume trees, capability dirs, and
    // `houge-worktree-*` repo checkouts), so handing it to an agent driven by attacker-controlled
    // reader content would be a read-and-plant primitive over Houge's own runtime.
    it("runs in a FRESH, EMPTY directory that is not the shared temp dir", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      const cwd = spawnImpl.mock.calls[0]![2].cwd;
      expect(cwd).not.toBe(os.tmpdir());
      expect(cwd.startsWith(os.tmpdir())).toBe(true);
      expect(cwd).toContain("houge-agy-");
    });

    it("gives each call its own directory", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "one" });
      await provider.answer({ question: "two" });

      const [first, second] = spawnImpl.mock.calls.map((c) => c[2].cwd);
      expect(first).not.toBe(second);
    });

    it("removes the directory afterwards, even when the leg fails", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: envelope({ status: "ERROR", error: "boom" }) })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      expect(existsSync(spawnImpl.mock.calls[0]![2].cwd)).toBe(false);
    });

    it("was actually empty while the child ran", async () => {
      let contents: string[] = [];
      const spawnImpl = vi.fn<SpawnImpl>(async (_file, _args, opts) => {
        contents = readdirSync(opts.cwd);
        return spawnResult({ stdout: envelope({ response: "ok" }) });
      });
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      expect(contents).toEqual([]);
    });
  });

  it("opts a passthrough var into the child env via HOUGE_AGY_ENV_PASSTHROUGH", async () => {
    process.env.AGY_TEST_SECRET = "explicitly-allowed";
    process.env.HOUGE_AGY_ENV_PASSTHROUGH = "AGY_TEST_SECRET";
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: envelope({ response: "ok" }) }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "hi" });

    expect(spawnImpl.mock.calls[0]![2].env.AGY_TEST_SECRET).toBe("explicitly-allowed");
  });

  it("maps ENOENT (binary missing) to unavailable so the chain falls through", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ code: null, spawnError: { code: "ENOENT" } })
    );
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "agy-cli",
      error: "agy binary not found (ENOENT)",
      unavailable: true
    });
  });

  it("maps our timeout to a (non-unavailable) failure", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ timedOut: true, code: null }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m", timeoutMs: 5000 });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({ ok: false, provider: "agy-cli", error: "agy timed out after 5000ms" });
  });

  it("treats an over-cap stdout as an error, not a truncated success", async () => {
    const huge = "x".repeat(11);
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: huge }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m", maxBytes: 10 });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({ ok: false, provider: "agy-cli", error: "agy output exceeded 10 byte cap" });
  });

  describe("envelope status is authoritative (agy exits 0 even on ERROR)", () => {
    it("NEVER returns an ERROR envelope as a successful answer", async () => {
      // The D1 trap: with --output-format json, a dead model exits 0 with non-empty stdout. Any
      // exit-code-driven success path would hand the raw JSON blob back as Houge's answer.
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: envelope({ status: "ERROR", error: "boom" }) })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
    });

    it("maps a retired model pin to unavailable", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: envelope({
            status: "ERROR",
            error:
              'invalid model selection (--model "Gemini 3.5 Flash (Low)"): model is not recognized'
          })
        })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "Gemini 3.5 Flash (Low)" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.unavailable).toBe(true);
        expect(result.error).toContain("invalid model selection");
      }
    });

    it("maps an auth wall to unavailable", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: envelope({ status: "ERROR", error: "not logged in" }) })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unavailable).toBe(true);
    });

    it("maps an upstream response timeout to a plain (non-unavailable) failure", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: envelope({ status: "ERROR", error: "timeout waiting for response" })
        })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unavailable).toBeUndefined();
    });

    it("flattens and caps provider error prose to one bounded line", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: envelope({ status: "ERROR", error: `head\n${"z".repeat(500)}` })
        })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("\n");
        expect(result.error.length).toBeLessThan(300);
      }
    });
  });

  describe("SUCCESS with no usable answer", () => {
    it("fails and names the denied tool actions", async () => {
      // Real shape when agy's model attempts a tool and headless mode auto-denies it: SUCCESS,
      // empty response. Returning that as an answer would silently blank an external read.
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: envelope({
            response: "",
            denied_actions: [{ action: "command", display_name: "RunCommand" }]
          })
        })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("denied");
        expect(result.error).toContain("command");
      }
    });

    it("fails on an empty response with no denied actions", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: envelope({ response: "   \n" }) })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("agy produced no answer");
    });
  });

  describe("unparseable stdout", () => {
    it("fails without claiming unavailable when the process exited clean", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ code: 0, stdout: "not json at all" }));
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("no JSON envelope");
        expect(result.unavailable).toBeUndefined();
      }
    });

    it("maps a non-zero exit with no envelope to unavailable", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 1, stdout: "", stderr: "agy: fatal" })
      );
      const provider = createAgyCliProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unavailable).toBe(true);
    });
  });

  describe("envelope shapes a vendor upgrade actually delivers", () => {
    // Every one of these silently disables D1 detection or kills a healthy leg, and each is a
    // shape a future agy release could ship without warning.
    it("fails safely when an ERROR envelope carries no error field", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: JSON.stringify({ status: "ERROR", response: "" }) })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("ERROR");
        expect(result.unavailable).toBeUndefined();
      }
    });

    it("does NOT match markers nested inside an error object (documents the limit)", async () => {
      // If agy ever nests the message, marker matching stops working and a retired model degrades
      // to a plain error. Pinned so the day it happens, this test names the cause.
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: JSON.stringify({
            status: "ERROR",
            error: { message: "invalid model selection (--model \"x\")" }
          })
        })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unavailable).toBeUndefined();
    });

    it("fails when status is missing entirely", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: JSON.stringify({ response: "hello" }) })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("missing");
    });

    it("fails when response is not a string", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: JSON.stringify({ status: "SUCCESS", response: { text: "hi" } }) })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
    });

    it("treats valid-JSON-but-not-an-object stdout as no envelope", async () => {
      for (const stdout of ["[]", '"hi"', "42", "null"]) {
        const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ code: 0, stdout }));
        const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("no JSON envelope");
      }
    });

    it("parses an envelope wrapped in ANSI colour codes", async () => {
      // stdout is a pipe today, but TERM is in the child env allowlist — if colour ever lands on
      // stdout, a failed parse would silently turn a healthy leg into a permanent 'unavailable'.
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: `\u001b[32m${envelope({ response: "Paris." })}\u001b[0m` })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.answer).toBe("Paris.");
    });

    it("survives malformed denied_actions entries", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: envelope({ response: "", denied_actions: ["a string", {}, null, 42] })
        })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("agy produced no answer");
    });
  });

  describe("failure text stays bounded and diagnosable", () => {
    it("bounds the denied-action list, which attacker-driven content influences", async () => {
      // On the reader path the model is being steered by a hostile page, so WHICH tools it
      // attempts — and therefore this array — is influenceable from outside.
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: envelope({
            response: "",
            denied_actions: Array.from({ length: 50 }, () => ({ action: `x\ny\n${"z".repeat(500)}` }))
          })
        })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("\n");
        expect(result.error.length).toBeLessThanOrEqual(ERROR_EXCERPT_MAX + 1);
      }
    });

    it("keeps the head of a truncated error and marks the elision", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: envelope({ status: "ERROR", error: `head ${"z".repeat(500)}` }) })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("head");
        expect(result.error).toContain("…");
      }
    });

    it("surfaces the stderr cause when no envelope was produced", async () => {
      // An auth wall prints to stderr and nothing to stdout. Reporting only
      // "no JSON envelope (exit 1)" would make the next D1-class failure harder to diagnose than
      // the last one — in the change written to make such failures visible.
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 1, stdout: "", stderr: "Please log in to continue (/login)" })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("log in");
        expect(result.unavailable).toBe(true);
      }
    });

    it("classifies an auth wall on stderr as unavailable even when the exit code is clean", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 0, stdout: "", stderr: "not logged in" })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unavailable).toBe(true);
    });

    it("does NOT misread an ANSWER that quotes an auth phrase as an auth wall", async () => {
      // A general prose model may legitimately mention "sign in" / "/login". Markers are matched
      // against the envelope's error field only — this pins that they never reach the answer.
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: envelope({ response: "Click Sign in and visit /login to continue." }) })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.answer).toContain("Sign in");
    });
  });

  describe("usage telemetry", () => {
    it("returns usage on the result — thinking reported separately, never re-added; cache_read as cached input (slice 2)", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: envelope({ response: "hi", usage: { input_tokens: 5590, output_tokens: 1511, thinking_tokens: 842, cache_read_tokens: 8090, total_tokens: 7101 } }) })
      );
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });
      expect(result.ok && result.usage).toEqual({ input_tokens: 5590, output_tokens: 1511, cached_input_tokens: 8090, thinking_tokens: 842 });
    });

    it("omits usage on the result when the envelope has none, and still answers", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: JSON.stringify({ status: "SUCCESS", response: "hi" }) }));
      const result = await createAgyCliProvider({ spawnImpl, model: "m" }).answer({ question: "hi" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.usage).toBeUndefined();
    });

  });
});
