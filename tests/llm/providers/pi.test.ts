import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import {
  createPiProvider,
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
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--mode",
        "json",
        "--model",
        "pi-model-x"
      ]);
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

    it("fails (not success) when output exceeds the byte cap", async () => {
      const big = jsonlSuccess("x".repeat(1000));
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: big }));
      const provider = createPiProvider({ spawnImpl, model: "m", maxBytes: 10 });

      const result = await provider.answer({ question: "hi" });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/exceed|cap|byte/i);
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

    it("falls back to HOUGE_LLM_MODEL_PI then HOUGE_LLM_MODEL", async () => {
      delete process.env.HOUGE_LLM_MODEL_PI;
      process.env.HOUGE_LLM_MODEL = "generic-model";
      const spawnImpl = vi.fn<SpawnImpl>(async () =>
        spawnResult({ stdout: jsonlSuccess("ok") })
      );
      const provider = createPiProvider({ spawnImpl });

      const result = await provider.answer({ question: "hi" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.model).toBe("generic-model");

      process.env.HOUGE_LLM_MODEL_PI = "pi-specific";
      const result2 = await provider.answer({ question: "hi" });
      if (result2.ok) expect(result2.model).toBe("pi-specific");
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
