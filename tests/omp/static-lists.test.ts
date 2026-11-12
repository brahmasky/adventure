import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { judgeSeat } from "../../src/llm/registry.js";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import { ROLE_LEGS, ROLE_NAMES, STATIC_ROLE_LISTS, staticRoleChains, staticSelectorKeys, type CatalogModel, type RoleName } from "../../src/omp/model-roles.js";
import { runModelRolesTick } from "../../src/omp/model-roles-tick.js";
import { formatModelString, parseModelString } from "../../src/omp/model-string.js";
import { tierDef, tierVersion } from "../../src/omp/model-tiers.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.3 (D4-A): HOUGE_MODEL_ROLES=static is the rollback; it is catalog-free, so it rots silently. Re-pinned at this ship
// (judge seat 2 empty: static is catalog-free, so it pins no renamed Gemini id; those join the pro tier via the resolver, spec 2026-11-03 §6.1), and checked daily in resolved mode so Paco
// learns the rollback is stale before he needs it.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const FIX = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const f = (l: Array<{ provider: string; model: string }>) => l.map((m) => formatModelString(m as never)).join(",");
/** Static Fast and Thinking run the Default list by design (no model added in a rollback), so they are checked against Default's tiers. */
const tierRole = (r: RoleName): RoleName => (r === "fast" || r === "thinking" ? "default" : r);
const stale = () => store.listOpenIncidents().filter((i) => i.kind === "static_list_stale").map((i) => i.subject).sort();

describe("the re-pinned static lists", () => {
  it("are the seeded heads, seat for seat; judge seat 2 has none", () => {
    const c = staticRoleChains();
    expect(f(c.planner)).toBe("anthropic/claude-opus-5-5:medium,google-antigravity/claude-opus-5-5:medium,kimi-code/k3:low");
    expect(f(c.reader)).toBe("google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low,openai-codex/gpt-6.1-sol:low");
    expect(f(c.media)).toBe("google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low");
    expect(f(c.ticks)).toBe("kimi-code/k3:low");
    expect(f(c.judges)).toBe("kimi-code/k3,openai-codex/gpt-6.1-sol");
    expect(f(c.chair)).toBe("anthropic/claude-opus-5-5:low");
    expect(f(c.reviewer)).toBe("kimi-code/k3:high,google-antigravity/claude-opus-5-5:medium");
    expect(f(c.growReview)).toBe("kimi-code/k3:high,openai-codex/gpt-6.1-sol:high");
    expect(judgeSeat(resolveOmpConfig({}, c), 2)).toEqual([]);
  });
  it("every static selector is a member of its role's tiers (judges: its seat's tier)", () => {
    for (const role of ROLE_NAMES) {
      STATIC_ROLE_LISTS[role].forEach((s, i) => {
        const m = parseModelString(s);
        const legs = role === "judges" ? [ROLE_LEGS.judges[i]!] : ROLE_LEGS[tierRole(role)];
        expect(legs.some((l) => tierDef(l.tier).provider === m.provider && tierVersion(tierDef(l.tier), m.model) !== null), `${role} ${s}`).toBe(true);
      });
    }
  });
  it("in resolved mode an empty judge seat runs no model: seat 2 fails alone", async () => {
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => FIX() });
    await roles.refreshCatalog();
    expect(roles.chains().judges[2]).toBeUndefined();
    expect(judgeSeat(resolveOmpConfig({}, roles.chains()), 2)).toEqual([]);
    expect(judgeSeat(resolveOmpConfig({}, roles.chains()), 1).map(formatModelString)).toEqual(["openai-codex/gpt-6.1-sol"]);
  });
});

describe("static_list_stale (resolved mode only)", () => {
  const T0 = Date.parse("2026-11-02T09:00:00.000Z");
  const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();
  let catalog: () => CatalogModel[] = FIX;
  const tick = (now: string) => runModelRolesTick({ store, roles: new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog() }), now, notify: () => {} });
  it("opens one incident per uncatalogued static selector, resolves it when the selector returns, and on a re-pin", async () => {
    expect(staticSelectorKeys()).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-5-5", "kimi-code/k3",
      "google-antigravity/gemini-3.8-flash", "openai-codex/gpt-6.1-sol"]);
    catalog = () => FIX().filter((m) => m.id !== "k3");
    await tick(day(0));
    expect(stale()).toEqual(["kimi-code/k3"]);
    store.openIncident({ kind: "static_list_stale", subject: "openai-codex/gpt-5.5", detail: {}, now: day(0) }); // a pre-re-pin row
    catalog = FIX;
    await tick(day(1));
    expect(stale()).toEqual([]);
  });
  it("a read listing nothing of a provider is partial (P13): no stale page and no card for it; its open rows stay open (final review Minor 7)", async () => {
    // Antigravity auth lapsed for one morning: the tiers rightly stay put, so paging "re-pin STATIC_ROLE_LISTS" and asking
    // Paco to fill gemini-pro would be false; a gone selector of a provider the read did list still pages.
    store.openIncident({ kind: "static_list_stale", subject: "google-antigravity/gemini-3.8-flash", detail: {}, now: day(-1) });
    catalog = () => FIX().filter((m) => m.provider !== "google-antigravity" && m.id !== "k3");
    const cards: unknown[] = [];
    await runModelRolesTick({ store, roles: new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog() }),
      now: day(0), notify: () => {}, card: (c) => cards.push(c) });
    // k3 gone from a listed provider empties the kimi tier (its card is due); gemini-pro, whose provider was not read, sends none
    expect([stale(), cards.map((c) => (c as { tier: string }).tier)]).toEqual([["google-antigravity/gemini-3.8-flash", "kimi-code/k3"], ["kimi"]]);
  });
  it("does not run in static mode (no tick at all) nor on a catalog outage", async () => {
    catalog = () => [] as CatalogModel[]; // parse → null → outage
    await tick(day(0));
    expect(stale()).toEqual([]);
  });
});
