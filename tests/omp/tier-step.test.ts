import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import { applyProbe, planTier, REJECT_PROBE_MS, type TierState } from "../../src/omp/tier-step.js";

// Spec §4.1–§4.2: a retired head falls back to its already-probed previous at once (a retired judge costs at most a day);
// a newer head is adopted only through a probe; a rejected one is left alone for 7 days; one probe per tier per tick (P13).
const cat = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const NOW = "2026-11-02T09:00:00.000Z";
const st = (tier: TierState["tier"], adopted: string | null, previous: string | null = null, rej: [string, string] | null = null): TierState =>
  ({ tier, adopted, previous, adopted_at: adopted ? "2026-11-01T00:00:00.000Z" : null, rejected_selector: rej?.[0] ?? null, rejected_at: rej?.[1] ?? null });

describe("planTier", () => {
  it("a newer catalog head is probed as head", () => {
    expect(planTier(st("kimi", "k3"), cat(), NOW).probe).toEqual({ id: "k3.1-pro", selector: "kimi-code/k3.1-pro", purpose: "head" });
  });
  it("an adopted head with no previous probes the next-newest below it", () => {
    expect(planTier(st("codex-sol", "gpt-6.1-sol"), cat(), NOW).probe).toEqual({ id: "gpt-6-sol", selector: "openai-codex/gpt-6-sol", purpose: "previous" });
  });
  it("nothing to do: head adopted and previous live", () => {
    expect(planTier(st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"), cat(), NOW)).toEqual({ before: st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"), state: st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"), probe: null });
  });
  it("a retired adopted head moves to its previous with no probe (then fills the previous)", () => {
    const p = planTier(st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"), cat().filter((m) => m.id !== "gpt-6.1-sol"), NOW);
    expect(p.state).toEqual({ ...st("codex-sol", "gpt-6-sol"), adopted_at: NOW });
    expect(p.probe).toEqual({ id: "gpt-5.6-sol", selector: "openai-codex/gpt-5.6-sol", purpose: "previous" });
  });
  it("a retired head with no live previous empties the tier; an empty catalog family probes nothing", () => {
    const p = planTier(st("kimi", "k3"), cat().filter((m) => !(m.provider === "kimi-code" && /^k\d/.test(m.id))), NOW); // kimi-k2 etc. stay listed
    expect(p.state).toEqual(st("kimi", null));
    expect(p.probe).toBeNull();
    expect(planTier(st("gemini-pro", null), cat(), NOW).probe).toBeNull();
  });
  it("a read that lists nothing of the provider changes no tier and probes nothing (P13, partial read)", () => {
    const before = st("kimi", "k3.1-pro", "k3");
    expect(planTier(before, cat().filter((m) => m.provider !== "kimi-code"), NOW)).toEqual({ before, state: before, probe: null });
  });
  it("a head rejected less than 7 days ago is skipped; at 7 days it is probed again", () => {
    const at = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
    expect(planTier(st("kimi", "k3", null, ["kimi-code/k3.1-pro", at(REJECT_PROBE_MS - 1)]), cat(), NOW).probe).toBeNull();
    expect(planTier(st("kimi", "k3", null, ["kimi-code/k3.1-pro", at(REJECT_PROBE_MS)]), cat(), NOW).probe?.id).toBe("k3.1-pro");
  });
});

describe("applyProbe", () => {
  const head = planTier(st("kimi", "k3"), cat(), NOW);
  it("pass on a head adopts it and keeps the old head as previous", () => {
    expect(applyProbe(head, { result: "pass", kind: "ok" }, NOW)).toEqual({ ...st("kimi", "k3.1-pro", "k3"), adopted_at: NOW });
  });
  it("model_missing keeps the tier and records the rejection", () => {
    expect(applyProbe(head, { result: "model_missing", kind: "model_missing" }, NOW)).toEqual(st("kimi", "k3", null, ["kimi-code/k3.1-pro", NOW]));
  });
  it("inconclusive, or no probe run, changes nothing", () => {
    expect(applyProbe(head, { result: "inconclusive", kind: "quota" }, NOW)).toEqual(st("kimi", "k3"));
    expect(applyProbe(head, null, NOW)).toEqual(st("kimi", "k3"));
  });
  it("pass on a previous fills the previous only", () => {
    expect(applyProbe(planTier(st("codex-sol", "gpt-6.1-sol"), cat(), NOW), { result: "pass", kind: "ok" }, NOW)).toEqual(st("codex-sol", "gpt-6.1-sol", "gpt-6-sol"));
  });
});
