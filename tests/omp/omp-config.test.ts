import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_LEASE_TTL_S, OMP_ENV_VARS, ompConfigProblems, PLANNER_HEARTBEAT_MS, RETIRED_OMP_CHAIN_VARS, resolveOmpConfig, warnRetiredOmpChainVars
} from "../../src/omp/omp-config.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { parseModelChain } from "../../src/omp/model-string.js";

const saved: Record<string, string | undefined> = {};
const PINNED = [...OMP_ENV_VARS, ...RETIRED_OMP_CHAIN_VARS];
beforeEach(() => { for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// With no RoleResolver, the chains are the static role lists: today's HOUGE_OMP_* defaults (spec §4.3 rollback parity).
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

  // Spec 2026-10-06 §4.2: the model roles own every seat chain. A stale HOUGE_OMP_* line in .env must neither steer a
  // seat nor fail the config check that refuses every turn (omp_config_invalid).
  it("takes its chains from the caller (the RoleResolver), never from a retired env variable", () => {
    const chains = { ...staticRoleChains(), ticks: parseModelChain("google-antigravity/gemini-3.8-flash:low") };
    expect(resolveOmpConfig({ HOUGE_OMP_TICKS: "kimi-code/k3:high" }, chains).ticks).toEqual(chains.ticks);
    expect(resolveOmpConfig({ HOUGE_OMP_PLANNER: "nonsense" }).planner).toEqual(staticRoleChains().planner);
    expect(ompConfigProblems({ HOUGE_OMP_PLANNER: "nonsense" })).toEqual([]);
    expect(OMP_ENV_VARS).not.toContain("HOUGE_OMP_PLANNER");
    expect(resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0" }).sandbox).toBe(false);
  });

  it("names a still-set retired chain variable once per process, so a stale .env is visible but never fatal", () => {
    const lines: string[] = [];
    expect(warnRetiredOmpChainVars({ HOUGE_OMP_PLANNER: "kimi-code/k3", HOUGE_OMP_READER: " " }, (l) => lines.push(l))).toEqual(["HOUGE_OMP_PLANNER"]);
    expect(warnRetiredOmpChainVars({ HOUGE_OMP_PLANNER: "kimi-code/k3" }, (l) => lines.push(l))).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HOUGE_OMP_PLANNER");
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

