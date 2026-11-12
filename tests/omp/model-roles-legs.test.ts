import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import { JUDGE_SEATS, keysOfTier, resolveRole, ROLE_LEGS, ROLE_NAMES, roleSelectors, soleKeysOf, type ResolveInput, type RoleName } from "../../src/omp/model-roles.js";
import { formatModelString } from "../../src/omp/model-string.js";
import { tierHeadsOf } from "../../src/omp/model-tiers.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { fixtureCatalog, SEED_LISTS } from "../helpers/model-roles.js";

// Spec §4.1: a role is a list of tier legs; each leg is its tier's adopted head then its previous head, so a retired head
// falls back to an already-probed model, never to a guess. A judge seat is its tier's adopted head alone: a judge never
// falls back inside a panel run (ADR 0027). The resolver reads model_tiers at every call, so an adoption needs no restart.
const NONE: ReadonlySet<string> = new Set();
const keyOf = (role: string, seat?: number) => (seat === undefined ? role : `${role}:${seat}`);
type Slot = { role: RoleName; seat?: number };
const slots = (): Slot[] => ROLE_NAMES.flatMap((role): Slot[] => (role === "judges" ? Array.from({ length: JUDGE_SEATS }, (_, seat) => ({ role, seat })) : [{ role }]));
const resolved = (i: Partial<ResolveInput> & Pick<ResolveInput, "role">) =>
  resolveRole({ catalog: fixtureCatalog(), override: null, refused: NONE, mode: "resolved", ...i }).map(formatModelString);

describe("legs over the seeded heads", () => {
  it("resolve every key to today's lists minus the three selectors the catalog dropped; judges:2 is empty", () => {
    for (const { role, seat } of slots()) expect(resolved({ role, ...(seat === undefined ? {} : { seat }) }), keyOf(role, seat)).toEqual(SEED_LISTS[keyOf(role, seat)]);
  });
  it("the legs are spec §4.1's, in order; three judge seats", () => {
    expect(JUDGE_SEATS).toBe(3);
    expect(ROLE_LEGS.default).toEqual([{ tier: "opus@anthropic", effort: "medium" }, { tier: "opus@antigravity", effort: "medium" }, { tier: "kimi", effort: "low" }]);
    expect(ROLE_LEGS.judges).toEqual([{ tier: "kimi" }, { tier: "codex-sol" }, { tier: "gemini-pro" }]);
    expect(ROLE_LEGS.reviewer).toEqual([{ tier: "kimi", effort: "high" }, { tier: "opus@antigravity", effort: "medium" }]);
  });
  // Paco 2026-11-12: photos stopped whenever the one Gemini leg was down or its login refused. Kimi reads images, so it backs the seat.
  it("vision has a second leg on Kimi behind Gemini Flash, so a photo outlives the first leg failing", () => {
    expect(ROLE_LEGS.vision).toEqual([{ tier: "gemini-flash", effort: "low" }, { tier: "kimi", effort: "low" }]);
    expect(resolved({ role: "vision", catalog: fixtureCatalog().filter((m) => m.id !== "gemini-3.8-flash") })).toEqual(["kimi-code/k3:low"]);
  });
});

describe("previous heads", () => {
  const heads = tierHeadsOf([{ tier: "codex-sol", adopted: "gpt-6.1-sol", previous: "gpt-6-sol" }]);
  it("follow the adopted head in a leg", () => {
    expect(roleSelectors("reader", undefined, "resolved", heads).map(formatModelString))
      .toEqual(["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6.1-sol:low", "openai-codex/gpt-6-sol:low"]);
  });
  it("never join a judge seat (no chain inside a panel run)", () => {
    expect(roleSelectors("judges", 1, "resolved", heads).map(formatModelString)).toEqual(["openai-codex/gpt-6.1-sol"]);
  });
  it("an adopted head the catalog no longer lists drops; its previous still resolves", () => {
    const cat = [...fixtureCatalog(), { provider: "openai-codex", id: "gpt-6-sol", thinking: null }].filter((m) => m.id !== "gpt-6.1-sol");
    expect(resolved({ role: "reader", catalog: cat, tiers: heads })).toEqual(["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6-sol:low"]);
  });
});

describe("keysOfTier", () => {
  it("names every role and judge seat with a leg on the tier", () => {
    expect(keysOfTier("kimi")).toEqual(["default", "thinking", "reader", "vision", "tiny", "reviewer", "grow_review", "judges:0"]);
    expect(keysOfTier("gemini-pro")).toEqual(["grow_review", "judges:2"]);
  });
  // Vision's Kimi leg means no role rests on Gemini Flash alone: an empty flash tier sends no tap card, the roles walk on.
  it("no role is served by the gemini-flash tier alone once vision has a Kimi leg", () => {
    expect(soleKeysOf("gemini-flash")).toEqual([]);
    expect(soleKeysOf("gemini-pro")).toEqual(["judges:2"]);
  });
});

describe("RoleResolver reads model_tiers at every resolution", () => {
  it("a tier write changes the next resolution without a restart; three judge seats, index-stable", async () => {
    const store = RunStore.openInMemory();
    const nov2 = parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => nov2 });
    await roles.refreshCatalog();
    const bare = (s: string | null | undefined) => (s ? s.split(":")[0]! : null); // resolveAll clamps efforts to the catalog's levels; compare provider/id
    expect(roles.resolveAll().map((r) => [r.key, bare(r.head)])).toEqual(slots().map(({ role, seat }) => [keyOf(role, seat), bare(SEED_LISTS[keyOf(role, seat)]![0])]));
    store.writeModelTier({ tier: "opus@anthropic", adopted: "claude-opus-5", previous: null, adopted_at: "t", rejected_selector: null, rejected_at: null }, "t");
    expect(bare(roles.resolveAll().find((r) => r.key === "chair")?.head)).toBe("anthropic/claude-opus-5");
    expect(roles.chains().judges).toHaveLength(3);
    store.close();
  });
});
