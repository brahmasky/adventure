import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateAgyVoiceModel, parseAgyModels, pickVoiceModel, resetAgyModelCacheForTest, resolveAgyVoiceModel } from "../../../src/llm/providers/agy-models.js";
import type { SpawnImpl, SpawnResult } from "../../../src/omp/child-env.js";

// Live `agy models` output shape (probed 2026-10-07): a progress line, then `<id>\t<display name>`, newest first.
const LISTING = [
  "Fetching available models...",
  "gemini-3.9-flash-high\tGemini 3.9 Flash (High)",
  "gemini-3.9-flash-low\tGemini 3.9 Flash (Low)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)",
  ""
].join("\n");

const ok = (stdout: string): SpawnResult => ({ stdout, stderr: "", code: 0, timedOut: false });

afterEach(() => resetAgyModelCacheForTest());

describe("agy voice model — resolved from agy's own catalog, never a pinned version (Paco, 2026-10-07)", () => {
  it("parses id and display name per line and skips the progress line", () => {
    expect(parseAgyModels(LISTING).slice(0, 2)).toEqual([
      { id: "gemini-3.9-flash-high", name: "Gemini 3.9 Flash (High)" },
      { id: "gemini-3.9-flash-low", name: "Gemini 3.9 Flash (Low)" }
    ]);
  });

  // The pin went stale the day a newer Flash shipped; the newest Flash at low effort follows the catalog instead.
  it("picks the first (newest) Gemini Flash at low effort, by display name (what --model takes today)", () => {
    expect(pickVoiceModel(parseAgyModels(LISTING))).toBe("Gemini 3.9 Flash (Low)");
  });

  it("returns null when the catalog has no Gemini Flash low model", () => {
    expect(pickVoiceModel(parseAgyModels("claude-opus-5-5-low\tClaude Opus 5.5 (Low)\n"))).toBeNull();
  });

  // One `agy models` per process window, not per voice note: the listing costs seconds.
  it("caches the resolution: two calls spawn the listing once", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => ok(LISTING));
    expect(await resolveAgyVoiceModel("agy", spawnImpl)).toBe("Gemini 3.9 Flash (Low)");
    expect(await resolveAgyVoiceModel("agy", spawnImpl)).toBe("Gemini 3.9 Flash (Low)");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0]![1]).toEqual(["models"]);
  });

  // A failed listing must not fail the voice note: no model is passed and agy uses its own default. The failure is
  // remembered for 10 min, so a stalled `agy models` costs one voice note its timeout, not every one.
  it("a failed listing resolves to null, is cached briefly, and is retried after 10 minutes", async () => {
    const failing = vi.fn<SpawnImpl>(async () => ({ stdout: "", stderr: "boom", code: 1, timedOut: false }));
    expect(await resolveAgyVoiceModel("agy", failing, 0)).toBeNull();
    const good = vi.fn<SpawnImpl>(async () => ok(LISTING));
    expect(await resolveAgyVoiceModel("agy", good, 9 * 60_000)).toBeNull();
    expect(good).not.toHaveBeenCalled();
    expect(await resolveAgyVoiceModel("agy", good, 11 * 60_000)).toBe("Gemini 3.9 Flash (Low)");
  });

  // agy listing newest-first is an observation, not a contract: the highest version wins whatever the order.
  it("picks by version number, not list order (3.10 beats 3.9)", () => {
    const shuffled = "gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\ngemini-3.10-flash-low\tGemini 3.10 Flash (Low)\ngemini-3.9-flash-low\tGemini 3.9 Flash (Low)\n";
    expect(pickVoiceModel(parseAgyModels(shuffled))).toBe("Gemini 3.10 Flash (Low)");
  });

  // The name rides argv as --model's value; a name agy prints that looks like a flag or carries odd bytes is dropped.
  it("drops display names that are not a plain model name", () => {
    expect(parseAgyModels("gemini-4.0-flash-low\t--dangerously-skip-permissions\ngemini-3.9-flash-low\tGemini 3.9 Flash (Low)\n"))
      .toEqual([{ id: "gemini-3.9-flash-low", name: "Gemini 3.9 Flash (Low)" }]);
  });

  it("invalidate drops a cached success so the next call lists again", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => ok(LISTING));
    expect(await resolveAgyVoiceModel("agy", spawnImpl)).toBe("Gemini 3.9 Flash (Low)");
    invalidateAgyVoiceModel("Gemini 3.9 Flash (Low)");
    // a stale listing still shows the refused name: it is skipped for the next-best Flash low, never cached again
    expect(await resolveAgyVoiceModel("agy", spawnImpl)).toBe("Gemini 3.8 Flash (Low)");
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });
});
