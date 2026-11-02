import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import {
  catalogHead, compareVersions, outputPriceAt, proposalsFor, SEED_HEADS, seedTierHeads, tierDef, tierHeadsOf, TIER_IDS, tierMembers, tierVersion,
  type TierId
} from "../../src/omp/model-tiers.js";

const FIXTURE = new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname;
const catalog = (): CatalogModel[] => { const c = parseOmpCatalog(readFileSync(FIXTURE, "utf8")); if (!c) throw new Error("fixture did not parse"); return c; };
const NOV2 = Date.parse("2026-11-02T00:00:00Z");

describe("tiers over the 2026-11-02 catalog", () => {
  it("each tier's head is spec §4.1's (D1-A: Kimi widened to -pro; gemini-pro empty)", () => {
    const heads = Object.fromEntries(TIER_IDS.map((t) => [t, catalogHead(tierDef(t), catalog())]));
    expect(heads).toEqual({
      "opus@anthropic": "claude-opus-5-5", "opus@antigravity": "claude-opus-5-5", "sonnet@anthropic": "claude-sonnet-5-5",
      "sonnet@antigravity": "claude-sonnet-5-5", "gemini-flash": "gemini-3.8-flash", "gemini-pro": null, "codex-sol": "gpt-6.1-sol", kimi: "k3.1-pro"
    });
  });
  it("members are ordered newest first and exclude snapshots, -lite, -highspeed, -256k, previews and other families", () => {
    expect(tierMembers(tierDef("opus@anthropic"), catalog())).toEqual(
      ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4-0"]);
    expect(tierMembers(tierDef("gemini-flash"), catalog())).toEqual(["gemini-3.8-flash", "gemini-2.5-flash"]);
    expect(tierMembers(tierDef("codex-sol"), catalog())).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"]);
    expect(tierMembers(tierDef("kimi"), catalog())).toEqual(["k3.1-pro", "k3"]);
    const notIn: Array<[TierId, string]> = [["opus@anthropic", "claude-opus-4-20250514"], ["opus@anthropic", "claude-opus-4-5-20251101"],
      ["gemini-flash", "gemini-3.5-flash-lite"], ["kimi", "k3.1-pro-highspeed"], ["kimi", "k3-256k"], ["kimi", "kimi-k2-turbo-preview"], ["codex-sol", "gpt-6.1-terra"]];
    for (const [t, id] of notIn) expect(tierVersion(tierDef(t), id), `${t} ${id}`).toBeNull();
    expect(tierMembers(tierDef("opus@anthropic"), catalog())).not.toContain("claude-fable-5-1");
  });
  it("versions compare by integer segment, a missing segment is 0; equal versions: the shorter id wins", () => {
    const v = (t: TierId, id: string) => tierVersion(tierDef(t), id)!;
    expect(compareVersions(v("opus@anthropic", "claude-opus-5"), v("opus@anthropic", "claude-opus-5-5"))).toBeLessThan(0);
    expect(compareVersions(v("codex-sol", "gpt-6-sol"), v("codex-sol", "gpt-6.1-sol"))).toBeLessThan(0);
    expect(compareVersions(v("codex-sol", "gpt-6.1-sol"), v("codex-sol", "gpt-6.10-sol"))).toBeLessThan(0);
    expect(compareVersions(v("gemini-flash", "gemini-3.8-flash"), v("gemini-flash", "gemini-2.5-flash"))).toBeGreaterThan(0);
    const tie: CatalogModel[] = [{ provider: "anthropic", id: "claude-opus-5-0", thinking: null }, { provider: "anthropic", id: "claude-opus-5", thinking: null }];
    expect(tierMembers(tierDef("opus@anthropic"), tie)).toEqual(["claude-opus-5", "claude-opus-5-0"]);
  });
});

describe("seeded heads (spec §4.2 bootstrap)", () => {
  it("are today's known-good selectors; gemini-pro has none; tierHeadsOf fills a missing tier from its seed and ignores unknown rows", () => {
    expect(SEED_HEADS).toEqual({ "opus@anthropic": "claude-opus-5-5", "opus@antigravity": "claude-opus-5-5", "sonnet@anthropic": "claude-sonnet-5-5",
      "sonnet@antigravity": "claude-sonnet-5-5", "gemini-flash": "gemini-3.8-flash", "gemini-pro": null, "codex-sol": "gpt-6.1-sol", kimi: "k3" });
    expect(seedTierHeads().get("kimi")).toEqual({ adopted: "k3", previous: null });
    const h = tierHeadsOf([{ tier: "kimi", adopted: "k3.1-pro", previous: "k3" }, { tier: "nonsense", adopted: "x", previous: null }]);
    expect(h.get("kimi")).toEqual({ adopted: "k3.1-pro", previous: "k3" });
    expect(h.get("codex-sol")).toEqual({ adopted: "gpt-6.1-sol", previous: null });
    expect(h.size).toBe(TIER_IDS.length);
  });
});

describe("empty-tier proposals (spec §4.4)", () => {
  it("argon's output price is the effective rate in force: 10 until 2026-12-01T08:00Z, then 20", () => {
    const argon = catalog().find((m) => m.id === "gemini-4-argon")!;
    expect(outputPriceAt(argon, NOV2)).toBe(10);
    expect(outputPriceAt(argon, Date.parse("2026-12-01T07:59:59Z"))).toBe(10);
    expect(outputPriceAt(argon, Date.parse("2026-12-01T08:00:00Z"))).toBe(20);
    expect(outputPriceAt({ provider: "x", id: "y", thinking: null }, NOV2)).toBeNull();
  });
  it("gemini-pro proposes Google ids no tier reads, no preview, no -lite, by output price highest first", () => {
    expect(proposalsFor(tierDef("gemini-pro"), catalog(), NOV2)).toEqual(["gemini-4-argon", "gpt-oss-120b"]);
  });
  it("at most three, price order", () => {
    const m = (id: string, output: number): CatalogModel => ({ provider: "google-antigravity", id, thinking: null, price: { output, rates: [] } });
    expect(proposalsFor(tierDef("gemini-pro"), [m("a", 1), m("b", 4), m("c", 3), m("d", 2)], NOV2)).toEqual(["b", "c", "d"]);
  });
});
