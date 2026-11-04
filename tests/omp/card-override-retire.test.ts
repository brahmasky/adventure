import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { ProbeFn, ProbeOutcome } from "../../src/omp/model-probe.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import { retireCardOverrides, runModelRolesTick } from "../../src/omp/model-roles-tick.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-03 §6.4: Paco's card tap pinned judges:2 to gemini-4-argon. Once the gemini-pro tier itself adopts argon (or
// newer) the pin is redundant and would hold seat 2 past any newer Gemini, so the tick retires it. Only a card-written
// override is retired: a /models set of the same pattern is Paco's own choice and stays.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const FIX = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const PASS: ProbeOutcome = { result: "pass", kind: "ok" };
const probe: ProbeFn = async () => PASS;
const day = (n: number) => new Date(Date.parse("2026-11-04T09:00:00.000Z") + n * 86_400_000).toISOString();
const ARGON = "gemini-4-argon";
const resolver = () => new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => FIX() });
const adopt = (adopted: string | null) => store.writeModelTier({ tier: "gemini-pro", adopted, previous: null, adopted_at: day(-1), rejected_selector: null, rejected_at: null }, day(-1));
const tapPass = () => store.recordModelProbe({ tier: "gemini-pro", selector: `google-antigravity/${ARGON}`, purpose: "tap", result: "pass", kind: "ok" });
const overrides = () => store.getLedgerEvents().filter((e) => e.event_type === "model_role_override").map((e) => e.payload);
async function tick(now = day(0), notes: string[] = []) {
  return runModelRolesTick({ store, roles: resolver(), probe, now, notify: (t) => notes.push(t) });
}
const seatSource = () => {
  const row = store.getLedgerEvents().filter((e) => e.event_type === "model_roles_resolved").at(-1)!;
  return (row.payload as { roles: Array<{ key: string; source: string }> }).roles.find((r) => r.key === "judges:2")!.source;
};
const RETIRED = "Judges 2 now follows Google's pro tier (gemini-4-argon); your card choice is no longer needed.";

describe("retireCardOverrides through the tick", () => {
  it("a tap-marked override is reset once the tier adopts it: reset row, one log line, source list, no shadow line", async () => {
    tapPass();
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco", via: "tap" });
    const notes: string[] = [];
    await tick(day(0), notes);
    expect(overrides()).toEqual([{ key: "judges:2", pattern: ARGON, actor: "paco", via: "tap" }, { key: "judges:2", pattern: "", actor: "houge:tier" }]);
    expect(notes.filter((n) => n === RETIRED)).toEqual([RETIRED]);
    expect(notes.some((n) => n.startsWith("ℹ️ Tier head"))).toBe(false);
    expect(seatSource()).toBe("list");
    expect(store.latestModelRoleOverrides().has("judges:2")).toBe(false);
  });
  it("one tick writes one resolution row and the retirement precedes it (the row already says list)", async () => {
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco", via: "tap" });
    await tick();
    expect(store.getLedgerEvents().filter((e) => e.event_type === "model_roles_resolved")).toHaveLength(1);
    const types = store.getLedgerEvents().map((e) => e.event_type);
    expect(types.indexOf("model_role_override") < types.lastIndexOf("model_role_override")).toBe(true);
    expect(types.lastIndexOf("model_role_override")).toBeLessThan(types.indexOf("model_roles_resolved"));
    expect(seatSource()).toBe("list");
  });
  it("a catalog outage tick retires nothing, even when the stored tier head already covers the tap (codex whole-diff)", async () => {
    adopt(ARGON);
    tapPass();
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco", via: "tap" });
    const notes: string[] = [];
    const down = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => { throw new Error("catalog down"); } });
    await runModelRolesTick({ store, roles: down, probe, now: day(0), notify: (t) => notes.push(t) });
    expect(overrides()).toEqual([{ key: "judges:2", pattern: ARGON, actor: "paco", via: "tap" }]);
    expect(notes).not.toContain(RETIRED);
    expect(store.latestModelRoleOverrides().has("judges:2")).toBe(true);
  });
  it("a legacy row (a run-less tap-pass probe immediately before a via-less override) is retired too", async () => {
    tapPass();
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco" });
    await tick();
    expect(overrides().at(-1)).toEqual({ key: "judges:2", pattern: "", actor: "houge:tier" });
  });
  it("a tap-pass probe immediately followed by a /models set of the same pattern is Paco's own choice and is kept", async () => {
    tapPass();
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco", via: "set" });
    const notes: string[] = [];
    await tick(day(0), notes);
    expect(store.latestModelRoleOverrides().get("judges:2")).toBe(ARGON);
    expect(notes).not.toContain(RETIRED);
    expect(seatSource()).toBe("override");
  });
  it("tap, then /models reset, then /models set of the same pattern is Paco's own choice and is kept", async () => {
    tapPass();
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco", via: "tap" });
    store.recordModelRoleOverride({ key: "judges:2", pattern: "", actor: "paco" });
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco" });
    const notes: string[] = [];
    await tick(day(0), notes);
    expect(store.latestModelRoleOverrides().get("judges:2")).toBe(ARGON);
    expect(notes).not.toContain(RETIRED);
    expect(seatSource()).toBe("override");
  });
  it("is kept while the tier's head is older than the override", async () => {
    // Tier adopted at a lower version than the pinned pattern: the pin still buys something the tier lacks.
    adopt("gemini-3.5-pro");
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco", via: "tap" });
    const notes: string[] = [];
    expect(retireCardOverrides(store, (t) => notes.push(t))).toEqual([]);
    expect([overrides().length, notes]).toEqual([1, []]);
  });
  it("is kept when the override pattern is not a member of the tier", async () => {
    adopt(ARGON);
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gpt-oss-120b", actor: "paco", via: "tap" });
    expect(retireCardOverrides(store, () => undefined)).toEqual([]);
    expect(store.latestModelRoleOverrides().get("judges:2")).toBe("gpt-oss-120b");
  });
  it("a head newer than the pin covers it: retired", () => {
    adopt("gemini-5-zeta");
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco", via: "tap" });
    const notes: string[] = [];
    expect(retireCardOverrides(store, (t) => notes.push(t))).toEqual(["judges:2"]);
    expect(notes).toEqual(["Judges 2 now follows Google's pro tier (gemini-5-zeta); your card choice is no longer needed."]);
  });
  it("the live shape (seq 3307 tap-pass probe directly before seq 3308 override) is matched; an unrelated row in between breaks the adjacency", () => {
    adopt(ARGON);
    tapPass();
    store.recordMemoryEvent("model_catalog_unavailable", { reason: "x" }, "model_roles");
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco" });
    expect(retireCardOverrides(store, () => undefined)).toEqual([]);
  });
  it("latestOverrideRows returns the latest row per key with the run-less row just before it", () => {
    tapPass();
    store.recordModelRoleOverride({ key: "judges:2", pattern: ARGON, actor: "paco" });
    const row = store.latestOverrideRows().get("judges:2")!;
    expect([row.pattern, row.via, row.prev?.event_type, row.prev?.payload.purpose]).toEqual([ARGON, null, "model_probe", "tap"]);
    expect(row.sequence).toBeGreaterThan(0);
  });
});
