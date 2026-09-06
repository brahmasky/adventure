import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import {
  createPiProvider,
  PI_DEFAULT_MAX_ANSWER_BYTES,
  PI_DEFAULT_MAX_BYTES,
  type SpawnImpl,
  type SpawnResult
} from "../../../src/llm/providers/pi.js";

/** Build a SpawnResult with sane defaults so tests only set what they assert. */
function spawnResult(partial: Partial<SpawnResult> = {}): SpawnResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...partial
  };
}

/** A JSONL stream that mimics pi --mode json for a successful answer. */
function jsonlSuccess(text: string): string {
  return [
    JSON.stringify({ type: "session", sessionId: "abc" }),
    JSON.stringify({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: text.slice(0, 3) }
    }),
    JSON.stringify({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: text.slice(3) }
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }]
      }
    }),
    JSON.stringify({ type: "agent_end", messages: [] })
  ].join("\n");
}

const ENV_KEYS_TO_RESTORE = [
  "HOUGE_TELEGRAM_BOT_TOKEN",
  "HOUGE_LLM_MODEL_PI",
  "HOUGE_LLM_MODEL",
  "HOUGE_LLM_TIMEOUT_MS_PI",
  "HOUGE_LLM_TIMEOUT_MS",
  "HOUGE_PI_ENV_PASSTHROUGH",
  "PI_TEST_SECRET"
];

const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS_TO_RESTORE) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS_TO_RESTORE) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("createPiProvider", () => {
  it("exposes the provider name 'pi'", () => {
    const provider = createPiProvider({ spawnImpl: async () => spawnResult() });
    expect(provider.name).toBe("pi");
  });

  it("parses a JSONL stream and returns the message_end assistant text", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ stdout: jsonlSuccess("The capital of France is Paris.") })
    );
    const provider = createPiProvider({ spawnImpl, model: "pi-model-x" });

    const result = await provider.answer({ question: "What is the capital of France?" });

    expect(result).toEqual({
      ok: true,
      provider: "pi",
      model: "pi-model-x",
      answer: "The capital of France is Paris."
    });
  });

  it("returns normalized usage on the result when message_end carries a usage block, with pi's reported model", async () => {
    const stdout = [
      JSON.stringify({ type: "session", sessionId: "abc" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "kimi-k2.7",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 60 }
        }
      })
    ].join("\n");
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
    const provider = createPiProvider({ spawnImpl, model: "configured-x" });

    const result = await provider.answer({ question: "hi" });

    // Slice 2: usage rides the result ONLY — the audit chokepoint on `answerWithChain` records it.
    expect(result).toEqual({
      ok: true,
      provider: "pi",
      model: "kimi-k2.7",
      answer: "OK",
      usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 60 }
    });
  });

  it("result.usage alone carries the normalized usage (slice 2)", async () => {
    const stdout = [
      JSON.stringify({ type: "session", sessionId: "abc" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "kimi-k2.7",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 60 }
        }
      })
    ].join("\n");
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
    const provider = createPiProvider({ spawnImpl, model: "configured-x" });

    const result = await provider.answer({ question: "hi" });

    expect(result.ok && result.usage).toEqual({ input_tokens: 100, output_tokens: 25, cached_input_tokens: 60 });
  });

  it("normalizes pi's NATIVE usage schema (input/output/cacheRead — verified on pi 0.81.1)", async () => {
    // Regression: pi 0.81.1 emits `input`/`output`/`cacheRead`, not the OpenAI `*_tokens`
    // names. Before this was handled, extractPiUsage returned undefined and every pi (kimi)
    // turn was invisible in the usage ledger. `input` is the TOTAL prompt count (includes the
    // cached subset reported by `cacheRead`).
    const stdout = [
      JSON.stringify({ type: "session", sessionId: "abc" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "kimi-coder",
          model: "kimi-for-coding",
          content: [{ type: "text", text: "OK" }],
          usage: { input: 1789, output: 22, cacheRead: 256, cacheWrite: 0, totalTokens: 1811, cost: { total: 0 } }
        }
      })
    ].join("\n");
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
    const provider = createPiProvider({ spawnImpl });

    const result = await provider.answer({ question: "hi" });

    expect(result.ok && result.usage).toEqual({ input_tokens: 1789, output_tokens: 22, cached_input_tokens: 256 });
    expect(result.ok && result.model).toBe("kimi-for-coding");
  });

  it("omits usage on the result when pi reports no usage block, and still answers", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: jsonlSuccess("Paris.") }));
    const provider = createPiProvider({ spawnImpl, model: "pi-model-x" });

    const result = await provider.answer({ question: "hi" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage).toBeUndefined();
  });

  it("reports the model pi actually used (from message_end) over the configured one", async () => {
    const stdout = [
      JSON.stringify({ type: "session", sessionId: "abc" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", model: "kimi-k2.6", content: [{ type: "text", text: "OK" }] }
      })
    ].join("\n");
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
    const provider = createPiProvider({ spawnImpl, model: "configured-x" });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({ ok: true, provider: "pi", model: "kimi-k2.6", answer: "OK" });
  });

  it("concatenates multiple text blocks within message_end content", async () => {
    const stdout = [
      JSON.stringify({ type: "session" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Hello " },
            { type: "thinking", text: "ignore me" },
            { type: "text", text: "world" }
          ]
        }
      })
    ].join("\n");
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
    const provider = createPiProvider({ spawnImpl, model: "m" });

    const result = await provider.answer({ question: "hi" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer).toBe("Hello world");
  });

  it("uses the LAST message_end when several assistant message_end lines exist", async () => {
    const stdout = [
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "first" }] }
      }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "second" }] }
      })
    ].join("\n");
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
    const provider = createPiProvider({ spawnImpl, model: "m" });

    const result = await provider.answer({ question: "hi" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer).toBe("second");
  });

  it("falls back to accumulated text_delta values when no message_end text exists", async () => {
    const stdout = [
      JSON.stringify({ type: "session" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "par" }
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "tial" }
      }),
      JSON.stringify({ type: "agent_end", messages: [] })
    ].join("\n");
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
    const provider = createPiProvider({ spawnImpl, model: "m" });

    const result = await provider.answer({ question: "hi" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer).toBe("partial");
  });

  it("ignores non-JSON lines defensively", async () => {
    const stdout = [
      "this is not json",
      "",
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] }
      }),
      "{ broken json"
    ].join("\n");
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
    const provider = createPiProvider({ spawnImpl, model: "m" });

    const result = await provider.answer({ question: "hi" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer).toBe("ok");
  });

  describe("argv hardening", () => {
    it("passes the question on STDIN (never argv) with the no-shell flags", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("hi there") })
      );
      const provider = createPiProvider({ spawnImpl, model: "pi-model-x" });

      await provider.answer({ question: "What is up?" });

      const [file, args, opts] = spawnImpl.mock.calls[0]!;
      expect(file).toBe("pi");
      // Flags only — the question is NOT an argv token.
      expect(args).toEqual([
        "-p",
        "--no-tools",
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--mode",
        "json",
        "--model",
        "pi-model-x"
      ]);
      // --no-tools is kept (the real safety lever); --no-extensions is NOT
      // passed, so extension-registered providers (e.g. kimi-coder) still load.
      expect(args).toContain("--no-tools");
      expect(args).not.toContain("--no-extensions");
      expect(args).not.toContain("What is up?");
      expect(args).not.toContain("--");
      // The question is delivered on stdin.
      expect(opts.input).toBe("What is up?");
    });

    it("omits --model when no model is configured", async () => {
      delete process.env.HOUGE_LLM_MODEL_PI;
      delete process.env.HOUGE_LLM_MODEL;
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("hi") })
      );
      const provider = createPiProvider({ spawnImpl });

      await provider.answer({ question: "hello" });

      const [, args, opts] = spawnImpl.mock.calls[0]!;
      expect(args).not.toContain("--model");
      expect(opts.input).toBe("hello");
    });

    it("delivers a flag-looking question as stdin, making argv injection impossible", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("answer") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      const attack = "--model evil --dangerously-skip-permissions";
      await provider.answer({ question: attack });

      const [, args, opts] = spawnImpl.mock.calls[0]!;
      // The attack is on stdin and appears NOWHERE in argv.
      expect(opts.input).toBe(attack);
      expect(args).not.toContain(attack);
      expect(args.filter((a) => a === "evil")).toHaveLength(0);
      expect(args.filter((a) => a === "--dangerously-skip-permissions")).toHaveLength(0);
      // Only the model we explicitly set is present.
      expect(args.filter((a) => a === "--model")).toHaveLength(1);
    });
  });

  describe("env allowlist + safe cwd", () => {
    it("excludes the Telegram bot token and unrelated keys from the child env", async () => {
      process.env.HOUGE_TELEGRAM_BOT_TOKEN = "super-secret-token";
      process.env.PI_TEST_SECRET = "should-not-leak";
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      const opts = spawnImpl.mock.calls[0]![2];
      expect(opts.env.HOUGE_TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(opts.env.PI_TEST_SECRET).toBeUndefined();
    });

    it("includes allowlisted vars that are present in process.env", async () => {
      process.env.PATH = process.env.PATH ?? "/usr/bin";
      process.env.HOME = process.env.HOME ?? "/home/test";
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      const opts = spawnImpl.mock.calls[0]![2];
      expect(opts.env.PATH).toBe(process.env.PATH);
      expect(opts.env.HOME).toBe(process.env.HOME);
    });

    it("passes through extra vars named in HOUGE_PI_ENV_PASSTHROUGH", async () => {
      process.env.PI_TEST_SECRET = "explicitly-allowed";
      process.env.HOUGE_PI_ENV_PASSTHROUGH = "PI_TEST_SECRET";
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      const opts = spawnImpl.mock.calls[0]![2];
      expect(opts.env.PI_TEST_SECRET).toBe("explicitly-allowed");
    });

    it("spawns in an OS temp dir, not the project root", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      const opts = spawnImpl.mock.calls[0]![2];
      expect(opts.cwd).toBe(os.tmpdir());
      expect(opts.cwd).not.toBe(process.cwd());
    });
  });

  describe("timeout", () => {
    it("returns a non-success timeout error when the child times out", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ timedOut: true, code: null }));
      const provider = createPiProvider({ spawnImpl, model: "m", timeoutMs: 1234 });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.provider).toBe("pi");
        expect(result.error).toBe("pi timed out after 1234ms");
        // A timeout is a normal fallthrough failure, not "unavailable".
        expect(result.unavailable).toBeUndefined();
      }
    });

    it("passes the configured timeoutMs to the spawn impl", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m", timeoutMs: 4321 });

      await provider.answer({ question: "hi" });

      expect(spawnImpl.mock.calls[0]![2].timeoutMs).toBe(4321);
    });
  });

  describe("output bound", () => {
    it("passes a maxBytes cap to the spawn impl", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m", maxBytes: 99 });

      await provider.answer({ question: "hi" });

      expect(spawnImpl.mock.calls[0]![2].maxBytes).toBe(99);
    });

    it("fails (not success) when the raw stdout STREAM exceeds maxBytes (memory guard)", async () => {
      const big = jsonlSuccess("x".repeat(1000));
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: big }));
      const provider = createPiProvider({ spawnImpl, model: "m", maxBytes: 10 });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("pi output stream exceeded 10 byte cap");
    });

    it("passes the 8 MB stream default as maxBytes to the spawn impl (the real memory bound)", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      expect(PI_DEFAULT_MAX_BYTES).toBe(8_388_608);
      expect(spawnImpl.mock.calls[0]![2].maxBytes).toBe(PI_DEFAULT_MAX_BYTES);
    });

    it("accepts a realistic per-token JSONL stream (~60x the answer) under default caps", async () => {
      // Regression for the conflated cap: pi --mode json emits one message_update line PER
      // TOKEN, each with a full zeroed usage+cost struct. Measured live: an 812-word answer =
      // 5,661 answer bytes inside 331,528 stdout bytes. With the old 256 KB cap applied to
      // stdout, this ordinary answer failed on the stream cap and fell through to the next leg.
      const answer = "Using the measured ratio, ordinary prose overflows. ".repeat(120); // ~6 KB
      const deltaLine = (delta: string): string =>
        JSON.stringify({
          type: "message_update",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta }
        });
      const deltas: string[] = [];
      for (let i = 0; i < answer.length; i += 5) deltas.push(deltaLine(answer.slice(i, i + 5)));
      const stdout = [
        JSON.stringify({ type: "session", sessionId: "abc" }),
        ...deltas,
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            model: "kimi-for-coding",
            content: [{ type: "text", text: answer }],
            usage: { input: 10, output: 1300, cacheRead: 0, cacheWrite: 0, totalTokens: 1310, cost: { total: 0 } }
          }
        }),
        JSON.stringify({ type: "agent_end", messages: [] })
      ].join("\n");
      expect(deltas.length).toBeGreaterThan(1200);
      // The stream is well past the OLD 256 KB stdout cap while the answer is tiny.
      expect(Buffer.byteLength(stdout, "utf8")).toBeGreaterThan(262_144);
      expect(Buffer.byteLength(answer, "utf8")).toBeLessThan(8_192);

      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
      const provider = createPiProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result).toEqual({
        ok: true,
        provider: "pi",
        model: "kimi-for-coding",
        answer,
        usage: { input_tokens: 10, output_tokens: 1300, cached_input_tokens: 0 }
      });
    });

    it("fails (not success) when the EXTRACTED answer exceeds maxAnswerBytes", async () => {
      const stdout = [
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "y".repeat(101) }] }
        })
      ].join("\n");
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
      const provider = createPiProvider({ spawnImpl, model: "m", maxAnswerBytes: 100 });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("answer exceeded");
        expect(result.error).toBe("pi answer exceeded 100 byte cap");
        expect(result.unavailable).toBeUndefined();
      }
    });

    it("measures the answer cap in BYTES, not characters (CJK boundary)", async () => {
      // 34 CJK chars = 102 UTF-8 bytes. With a 100-byte cap this must FAIL; a `.length`
      // comparison (34 < 100) would wrongly pass it. Houge answers in Chinese constantly.
      const answer = "拥".repeat(34);
      expect(Buffer.byteLength(answer, "utf8")).toBe(102);
      const stdout = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: answer }] }
      });
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
      const provider = createPiProvider({ spawnImpl, model: "m", maxAnswerBytes: 100 });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("answer exceeded");
    });

    it("accepts an answer exactly AT maxAnswerBytes (boundary is inclusive)", async () => {
      const answer = "y".repeat(100);
      const stdout = [
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: answer }] }
        })
      ].join("\n");
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
      const provider = createPiProvider({ spawnImpl, model: "m", maxAnswerBytes: 100 });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.answer).toBe(answer);
    });

    it("defaults the answer cap to 256 KB (the original intent, now on the answer)", () => {
      expect(PI_DEFAULT_MAX_ANSWER_BYTES).toBe(262_144);
    });
  });

  describe("unavailable detection", () => {
    it("maps ENOENT (binary missing) to unavailable", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: null, spawnError: { code: "ENOENT" } })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.unavailable).toBe(true);
        expect(result.provider).toBe("pi");
      }
    });

    it("maps a plain-text auth error that EXITS 0 to unavailable, NOT success", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: "No API key found. Run /login to authenticate."
        })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unavailable).toBe(true);
    });

    it("detects auth markers even when wrapped in ANSI color codes", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({
          code: 0,
          stdout: "[31mError: not logged in[0m"
        })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unavailable).toBe(true);
    });

    it("maps a non-zero exit with no answer text to unavailable", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ code: 1, stderr: "boom" })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.unavailable).toBe(true);
    });

    it("never reports success when no answer text is extracted (clean exit, empty JSONL)", async () => {
      const stdout = [
        JSON.stringify({ type: "session" }),
        JSON.stringify({ type: "agent_end", messages: [] })
      ].join("\n");
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ code: 0, stdout }));
      const provider = createPiProvider({ spawnImpl, model: "m" });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
    });
  });

  describe("system prompt", () => {
    it("passes a Houge-controlled system prompt as --system-prompt (argv, not stdin)", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi", system: "Be neutral and concise." });

      const [, args, opts] = spawnImpl.mock.calls[0]!;
      const idx = args.indexOf("--system-prompt");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("Be neutral and concise.");
      // The system prompt is a flag value; the question still rides stdin.
      expect(opts.input).toBe("hi");
      expect(opts.input).not.toContain("Be neutral");
    });

    it("omits --system-prompt entirely when no system prompt is set", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      expect(spawnImpl.mock.calls[0]![1]).not.toContain("--system-prompt");
    });
  });

  describe("model + env resolution", () => {
    it("prefers req.model over config.model", async () => {
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "config-model" });

      const result = await provider.answer({ question: "hi", model: "req-model" });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.model).toBe("req-model");
      expect(spawnImpl.mock.calls[0]![1]).toContain("req-model");
    });

    it("uses HOUGE_LLM_MODEL_PI and IGNORES the cross-provider global", async () => {
      // Global is set but pi-specific is not: pi must NOT pick up the global
      // (its model namespace differs from the API providers'). It omits --model
      // and defers to pi's own configured default.
      delete process.env.HOUGE_LLM_MODEL_PI;
      process.env.HOUGE_LLM_MODEL = "kimi-k2.7-code-highspeed";
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl });

      const result = await provider.answer({ question: "hi" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.model).toBe("pi-default"); // not the global
      expect(spawnImpl.mock.calls[0]![1]).not.toContain("--model");

      // The pi-specific override IS honored.
      process.env.HOUGE_LLM_MODEL_PI = "pi-specific";
      const result2 = await provider.answer({ question: "hi" });
      if (result2.ok) expect(result2.model).toBe("pi-specific");
      expect(spawnImpl.mock.calls[1]![1]).toContain("pi-specific");
    });

    it("resolves timeoutMs from HOUGE_LLM_TIMEOUT_MS_PI", async () => {
      process.env.HOUGE_LLM_TIMEOUT_MS_PI = "7777";
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl, model: "m" });

      await provider.answer({ question: "hi" });

      expect(spawnImpl.mock.calls[0]![2].timeoutMs).toBe(7777);
    });
  });
});
