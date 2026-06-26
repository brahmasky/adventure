import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { createAgyCliProvider, AGY_DEFAULT_MODEL } from "../../../src/llm/providers/agy-cli.js";
import type { SpawnImpl, SpawnResult } from "../../../src/llm/providers/cli-spawn.js";

/** Build a SpawnResult with sane defaults so tests only set what they assert. */
function spawnResult(partial: Partial<SpawnResult> = {}): SpawnResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...partial };
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

  it("returns the trimmed plain-text stdout as the answer", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "  Paris.\n" }));
    const provider = createAgyCliProvider({ spawnImpl, model: "Gemini 3.5 Flash (Low)" });

    const result = await provider.answer({ question: "Capital of France?" });

    expect(result).toEqual({
      ok: true,
      provider: "agy-cli",
      model: "Gemini 3.5 Flash (Low)",
      answer: "Paris."
    });
  });

  it("passes the prompt as the --print argv value and defaults the model", async () => {
    delete process.env.HOUGE_AGY_MODEL;
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "ok" }));
    const provider = createAgyCliProvider({ spawnImpl });

    await provider.answer({ question: "hello" });

    const [file, args, opts] = spawnImpl.mock.calls[0]!;
    expect(file).toBe("agy");
    expect(args).toEqual(["--model", AGY_DEFAULT_MODEL, "--print", "hello"]);
    // The prompt rides argv (not stdin); stdin stays empty.
    expect(opts.input).toBe("");
  });

  it("folds the system prompt into the prompt (agy has no --system-prompt flag)", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "ok" }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "Q", system: "Be neutral." });

    const args = spawnImpl.mock.calls[0]![1];
    expect(args[3]).toBe("Be neutral.\n\nQ");
  });

  it("keeps a flag-like prompt as ONE argv element (injection-safe)", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "ok" }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });
    const attack = "--dangerously-skip-permissions --model evil";

    await provider.answer({ question: attack });

    const args = spawnImpl.mock.calls[0]![1];
    // The attack string is the single value after --print, never split into separate flags.
    expect(args).toEqual(["--model", "m", "--print", attack]);
    expect(args.filter((a) => a === "--dangerously-skip-permissions")).toHaveLength(0);
    expect(args.filter((a) => a === "evil")).toHaveLength(0);
  });

  it("never passes --dangerously-skip-permissions", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "ok" }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "hi" });

    expect(spawnImpl.mock.calls[0]![1]).not.toContain("--dangerously-skip-permissions");
  });

  it("uses HOUGE_AGY_BIN for the binary path", async () => {
    process.env.HOUGE_AGY_BIN = "/abs/path/agy";
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "ok" }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "hi" });

    expect(spawnImpl.mock.calls[0]![0]).toBe("/abs/path/agy");
  });

  it("runs in a temp cwd and excludes secrets from the child env", async () => {
    process.env.HOUGE_TELEGRAM_BOT_TOKEN = "super-secret";
    process.env.GEMINI_API_KEY = "key-should-not-leak";
    process.env.AGY_TEST_SECRET = "nope";
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "ok" }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    await provider.answer({ question: "hi" });

    const opts = spawnImpl.mock.calls[0]![2];
    expect(opts.cwd).toBe(os.tmpdir());
    expect(opts.env.HOUGE_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(opts.env.GEMINI_API_KEY).toBeUndefined();
    expect(opts.env.AGY_TEST_SECRET).toBeUndefined();
  });

  it("opts a passthrough var into the child env via HOUGE_AGY_ENV_PASSTHROUGH", async () => {
    process.env.AGY_TEST_SECRET = "explicitly-allowed";
    process.env.HOUGE_AGY_ENV_PASSTHROUGH = "AGY_TEST_SECRET";
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "ok" }));
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

  it("treats an auth marker as unavailable", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ stdout: "Please log in to continue", code: 1 })
    );
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    const result = await provider.answer({ question: "hi" });

    expect(result).toEqual({
      ok: false,
      provider: "agy-cli",
      error: "agy is not authenticated",
      unavailable: true
    });
  });

  it("does NOT misread a clean-exit answer that quotes an auth phrase as an auth wall", async () => {
    // A general prose model may legitimately mention "sign in" / "/login" in its answer. Exit 0 +
    // real content is never an auth wall — it must succeed, not get discarded.
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ stdout: "To use the app, click Sign in and visit /login.", code: 0 })
    );
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    const result = await provider.answer({ question: "how do I access the app?" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer).toContain("Sign in");
  });

  it("fails (no answer) when stdout is empty", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout: "   \n", code: 0 }));
    const provider = createAgyCliProvider({ spawnImpl, model: "m" });

    const result = await provider.answer({ question: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("agy produced no answer");
  });
});
