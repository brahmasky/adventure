import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIN_LEASE_TTL_S, OMP_ENV_VARS, ompConfigProblems, PLANNER_HEARTBEAT_MS, resolveOmpConfig } from "../../src/omp/omp-config.js";

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

  it("runs sandboxed by default — production must not start unsandboxed by omission", () => {
    const c = resolveOmpConfig({});
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

  it("rejects a lease TTL under 3x the heartbeat: the recovery timer would fail a live turn between renewals (round 2 N2)", () => {
    expect(MIN_LEASE_TTL_S * 1000).toBe(3 * PLANNER_HEARTBEAT_MS);
    expect(() => resolveOmpConfig({ HOUGE_OMP_LEASE_TTL_S: String(MIN_LEASE_TTL_S - 1) })).toThrow(/HOUGE_OMP_LEASE_TTL_S/);
    expect(ompConfigProblems({ HOUGE_OMP_LEASE_TTL_S: "20" })).toEqual(["HOUGE_OMP_LEASE_TTL_S"]);
    expect(resolveOmpConfig({ HOUGE_OMP_LEASE_TTL_S: String(MIN_LEASE_TTL_S) }).leaseTtlS).toBe(MIN_LEASE_TTL_S);
    expect(ompConfigProblems({})).toEqual([]);
  });
});

