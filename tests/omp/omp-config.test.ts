import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OMP_ENV_VARS, resolveOmpConfig } from "../../src/omp/omp-config.js";

const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of OMP_ENV_VARS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of OMP_ENV_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("omp config — defaults are the decided seat chains (spec §8, D7, D10)", () => {
  it("defaults the planner to Opus 5.5 then Opus 4.6 via Antigravity then k3", () => {
    const c = resolveOmpConfig({});
    expect(c.planner.map((m) => `${m.provider}/${m.model}`)).toEqual([
      "anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6", "kimi-code/k3"
    ]);
  });

  it("keeps a GPT reader leg last so planner/reader family collapse stays rare (D10)", () => {
    const families = resolveOmpConfig({}).reader.map((m) => m.model);
    expect(families.at(-1)).toBe("gpt-5.5");
  });

  it("pins the omp version and runs sandboxed by default — production must not start unsandboxed by omission", () => {
    const c = resolveOmpConfig({});
    expect(c.version).toBe("18.4.4");
    expect(c.sandbox).toBe(true);
    expect(c.profile).toBe("houge");
  });

  it("reads overrides and rejects a malformed chain at resolve time", () => {
    expect(resolveOmpConfig({ HOUGE_OMP_TICKS: "kimi-code/k3:high" }).ticks[0]?.effort).toBe("high");
    expect(resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0" }).sandbox).toBe(false);
    expect(() => resolveOmpConfig({ HOUGE_OMP_PLANNER: "nonsense" })).toThrow();
  });

  it("falls back to the default for a non-numeric timeout rather than NaN", () => {
    expect(resolveOmpConfig({ HOUGE_OMP_TURN_TIMEOUT_MS: "soon" }).turnTimeoutMs).toBe(600_000);
  });
});
