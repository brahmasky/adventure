import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ASK_SYSTEM_PROMPT,
  createLlmAnswerAdapter
} from "../../src/capabilities/llm-answer.js";
import type { LlmProvider, LlmRequest } from "../../src/llm/types.js";

/** A provider that records the request it received, so we can assert on `system`. */
function capturingProvider(): { provider: LlmProvider; last(): LlmRequest | undefined } {
  let captured: LlmRequest | undefined;
  return {
    provider: {
      name: "capture",
      async answer(req) {
        captured = req;
        return { ok: true, provider: "capture", model: "m", answer: "ok" };
      }
    },
    last: () => captured
  };
}

const SAVED_ASK_PROMPT = process.env.HOUGE_ASK_SYSTEM_PROMPT;
afterEach(() => {
  if (SAVED_ASK_PROMPT === undefined) delete process.env.HOUGE_ASK_SYSTEM_PROMPT;
  else process.env.HOUGE_ASK_SYSTEM_PROMPT = SAVED_ASK_PROMPT;
});

describe("createLlmAnswerAdapter", () => {
  it("maps a successful provider result to the capability output", async () => {
    const fakeProvider: LlmProvider = {
      name: "fake",
      async answer({ question }) {
        return { ok: true, provider: "fake", model: "fake-model", answer: `A:${question}` };
      }
    };
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider] });

    const result = await adapter({ question: "What is the capital of France?" });

    expect(result).toEqual({
      ok: true,
      output: {
        question: "What is the capital of France?",
        answer: "A:What is the capital of France?",
        model: "fake-model",
        provider: "fake"
      }
    });
  });

  it("threads the default identity system prompt to the chain", async () => {
    delete process.env.HOUGE_ASK_SYSTEM_PROMPT;
    const { provider, last } = capturingProvider();
    const adapter = createLlmAnswerAdapter({ chain: [provider] });

    await adapter({ question: "hi" });

    expect(last()?.system).toBe(DEFAULT_ASK_SYSTEM_PROMPT);
  });

  it("lets HOUGE_ASK_SYSTEM_PROMPT override the default", async () => {
    process.env.HOUGE_ASK_SYSTEM_PROMPT = "Answer like a pirate.";
    const { provider, last } = capturingProvider();
    const adapter = createLlmAnswerAdapter({ chain: [provider] });

    await adapter({ question: "hi" });

    expect(last()?.system).toBe("Answer like a pirate.");
  });

  it("lets a per-call input.system take precedence over the env and default", async () => {
    process.env.HOUGE_ASK_SYSTEM_PROMPT = "env one";
    const { provider, last } = capturingProvider();
    const adapter = createLlmAnswerAdapter({ chain: [provider] });

    await adapter({ question: "hi", system: "call one" });

    expect(last()?.system).toBe("call one");
  });

  it("rejects a missing or empty question without calling the chain", async () => {
    let called = false;
    const fakeProvider: LlmProvider = {
      name: "fake",
      async answer() {
        called = true;
        return { ok: true, provider: "fake", model: "fake-model", answer: "x" };
      }
    };
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider] });

    expect(await adapter({ question: "" })).toEqual({
      ok: false,
      error: "question must be a non-empty string"
    });
    expect(await adapter({})).toEqual({
      ok: false,
      error: "question must be a non-empty string"
    });
    expect(called).toBe(false);
  });

  it("maps a chain failure to a flat capability error", async () => {
    const fakeProvider: LlmProvider = {
      name: "fake",
      async answer() {
        return { ok: false, provider: "fake", error: "boom" };
      }
    };
    const adapter = createLlmAnswerAdapter({ chain: [fakeProvider] });

    const result = await adapter({ question: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("boom");
    }
  });
});

describe("provider usage tagging (D4 interim wiring)", () => {
  it("tags agy-cli usage with its own provider name, not a metered one", async () => {
    // The one line that makes agy's tokens reach `recordLlmCall` at all. A copy-paste slip here
    // would attribute flat-rate CLI tokens to a metered provider and feed the ADR 0019 fuse
    // spend that never happened — and every other test would stay green, because they all inject
    // a chain and bypass `buildLlmChain` entirely.
    const seen: Array<{ provider: string; model: string }> = [];
    const spawnCalls: string[][] = [];

    // Route the real agy provider at a fake binary that emits a SUCCESS envelope with usage.
    const previousBin = process.env.HOUGE_AGY_BIN;
    const previousModel = process.env.HOUGE_AGY_MODEL;
    process.env.HOUGE_AGY_MODEL = "test-model";
    try {
      const { createAgyCliProvider } = await import("../../src/llm/providers/agy-cli.js");
      const provider = createAgyCliProvider({
        onUsage: (usage, model) => seen.push({ provider: "agy-cli", model }),
        spawnImpl: async (_file, args) => {
          spawnCalls.push(args);
          return {
            code: 0,
            stdout: JSON.stringify({
              status: "SUCCESS",
              response: "hi",
              usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 0 }
            }),
            stderr: "",
            timedOut: false
          };
        }
      });

      const result = await provider.answer({ question: "q" });

      expect(result.ok).toBe(true);
      expect(seen).toEqual([{ provider: "agy-cli", model: "test-model" }]);
    } finally {
      if (previousBin === undefined) delete process.env.HOUGE_AGY_BIN;
      else process.env.HOUGE_AGY_BIN = previousBin;
      if (previousModel === undefined) delete process.env.HOUGE_AGY_MODEL;
      else process.env.HOUGE_AGY_MODEL = previousModel;
    }
  });

  it("carries agy usage all the way through createLlmAnswerAdapter's own chain build", async () => {
    // End-to-end over the actual diff line in llm-answer.ts: a REAL agy binary stub, resolved
    // through buildLlmChain by provider name, with the adapter's construction-time hook. Without
    // `agyConfig` threaded in, this reports nothing and the interim D4 fix does not exist.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    // A stub that ignores argv entirely and emits one real-shaped envelope on stdout.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "houge-agy-stub-"));
    const stub = path.join(dir, "agy-stub.sh");
    fs.writeFileSync(
      stub,
      "#!/bin/sh\nprintf '%s' '" +
        JSON.stringify({
          status: "SUCCESS",
          response: "Paris.",
          usage: { input_tokens: 120, output_tokens: 5, thinking_tokens: 40, cache_read_tokens: 7 }
        }) +
        "'\n",
      { mode: 0o755 }
    );

    const saved = {
      bin: process.env.HOUGE_AGY_BIN,
      model: process.env.HOUGE_AGY_MODEL,
      providers: process.env.HOUGE_LLM_PROVIDERS
    };
    process.env.HOUGE_AGY_BIN = stub;
    try {
      const seen: Array<{ provider: string; usage: unknown; model: string }> = [];
      const adapter = createLlmAnswerAdapter({
        providers: "agy-cli",
        onUsage: (provider, usage, model) => seen.push({ provider, usage, model })
      });

      const result = await adapter({ question: "Capital of France?" });

      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.provider).toBe("agy-cli");
      // agy nests thinking inside output, so output_tokens is reported as-is (never +thinking),
      // and cache_read maps to cached input. Thinking rides alongside, informational only.
      expect(seen[0]!.usage).toEqual({
        input_tokens: 120,
        output_tokens: 5,
        cached_input_tokens: 7,
        thinking_tokens: 40
      });
    } finally {
      for (const [key, value] of [
        ["HOUGE_AGY_BIN", saved.bin],
        ["HOUGE_AGY_MODEL", saved.model],
        ["HOUGE_LLM_PROVIDERS", saved.providers]
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
