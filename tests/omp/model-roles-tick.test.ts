import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLine, runModelRolesTick } from "../../src/omp/model-roles-tick.js";
import { ROLE_LISTS, selectorKey, type CatalogModel } from "../../src/omp/model-roles.js";
import { parseModelString } from "../../src/omp/model-string.js";
import { RoleResolver, type OverrideKey, type ResolvedRole } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.1: model resolution changes silently when a provider retires a model (Opus 4 → 5.5 happened in months). The daily
// tick turns that into one Telegram line per changed role, and a role left with no candidate into a `role_unresolved` incident
// that clears when it resolves again. It must spawn `omp models` at most once a day, never notify on a catalog outage (the
// lists then run as written, which is not a change), and never commit half a tick when the daemon stops mid-read.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-07T09:00:00.000Z");
const at = (days: number, minutes = 0) => new Date(T0 + days * DAY + minutes * 60_000).toISOString();

function fakeRoles(initial: Record<string, string | null>) {
  let heads = initial; let catalogOk = true; let refreshes = 0;
  let onRefresh: () => void = () => {};
  const roles = {
    refreshCatalog: async () => { refreshes += 1; onRefresh(); return catalogOk; },
    resolveAll: (): ResolvedRole[] => Object.entries(heads).map(([key, head]) =>
      ({ key: key as OverrideKey, head, candidates: head ? [head] : [], source: "list" as const }))
  };
  return {
    roles, refreshes: () => refreshes,
    set(h: Record<string, string | null>, ok = true) { heads = h; catalogOk = ok; },
    onRefresh(f: () => void) { onRefresh = f; }
  };
}
const HEADS = { default: "anthropic/claude-opus-5-5:medium", thinking: "anthropic/claude-opus-5-5:high", vision: "google-antigravity/gemini-3.8-flash:low" };
const tick = (f: ReturnType<typeof fakeRoles>, now: string, notices: string[] = [], signal?: AbortSignal) =>
  runModelRolesTick({ store, roles: f.roles, now, notify: (t) => notices.push(t), ...(signal ? { signal } : {}) });
const resolvedRows = () => store.getLedgerEvents().filter((e) => e.event_type === "model_roles_resolved");
const unresolvedIncidents = () => store.listOpenIncidents().filter((i) => i.kind === "role_unresolved");

describe("runModelRolesTick", () => {
  it("the first run records the baseline and notifies nothing (nothing changed yet)", async () => {
    const f = fakeRoles(HEADS); const notices: string[] = [];
    expect(await tick(f, at(0), notices)).toEqual({ ran: true, changed: [], unresolved: [] });
    expect(notices).toEqual([]);
    expect(resolvedRows()).toHaveLength(1);
    expect(store.latestModelRolesResolved()).toMatchObject({ resolved_at: at(0), catalog_ok: true });
  });

  it("runs once per 24 h: inside the window it does not even read the catalog (no omp spawn per poll cycle)", async () => {
    const f = fakeRoles(HEADS);
    await tick(f, at(0));
    expect(await tick(f, at(0, 23 * 60 + 59))).toEqual({ ran: false, changed: [], unresolved: [] });
    expect(f.refreshes()).toBe(1);
    expect((await tick(f, at(1))).ran).toBe(true);
    expect(f.refreshes()).toBe(2);
  });

  it("one line per changed role, naming the new and the old head; unchanged roles stay silent", async () => {
    const f = fakeRoles(HEADS); const notices: string[] = [];
    await tick(f, at(0));
    f.set({ ...HEADS, thinking: "google-antigravity/claude-opus-5-5:high" });
    expect(await tick(f, at(1), notices)).toMatchObject({ ran: true, changed: ["thinking"] });
    expect(notices).toEqual([changeLine("thinking", HEADS.thinking, "google-antigravity/claude-opus-5-5:high")]);
    expect(notices[0]).toBe("🔁 Thinking now resolves to `google-antigravity/claude-opus-5-5:high`, was `anthropic/claude-opus-5-5:high`.");
  });

  it("a role with no candidate opens role_unresolved (subject = the role key) once, and resolving again clears it", async () => {
    const f = fakeRoles(HEADS);
    await tick(f, at(0));
    f.set({ ...HEADS, vision: null });
    expect((await tick(f, at(1))).unresolved).toEqual(["vision"]);
    expect(unresolvedIncidents().map((i) => i.subject)).toEqual(["vision"]);
    await tick(f, at(2));
    expect(unresolvedIncidents()).toHaveLength(1); // still unresolved: still one incident, not a second
    f.set(HEADS);
    expect((await tick(f, at(3))).unresolved).toEqual([]);
    expect(unresolvedIncidents()).toHaveLength(0);
  });

  it("a catalog outage advances the latch but notifies nothing and touches no incident; the next good read diffs against the last good one", async () => {
    const f = fakeRoles(HEADS); const notices: string[] = [];
    await tick(f, at(0));
    f.set({ ...HEADS, thinking: "kimi-code/k3:high", vision: null }, false);
    expect(await tick(f, at(1), notices)).toEqual({ ran: true, changed: [], unresolved: [] });
    expect(notices).toEqual([]);
    expect(unresolvedIncidents()).toHaveLength(0);
    expect(store.latestModelRolesResolved()).toMatchObject({ resolved_at: at(1), catalog_ok: false });
    f.set({ ...HEADS, thinking: "kimi-code/k3:high" });
    expect((await tick(f, at(2), notices)).changed).toEqual(["thinking"]);
    expect(notices).toHaveLength(1);
  });

  it("a stop during the catalog read commits nothing, so the next boot's tick runs the whole unit", async () => {
    const f = fakeRoles(HEADS); const ctl = new AbortController();
    f.onRefresh(() => ctl.abort());
    expect((await tick(f, at(0), [], ctl.signal)).ran).toBe(false);
    expect(resolvedRows()).toHaveLength(0);
  });

  it("static mode has no tick (spec §4.3): no catalog read, no row", async () => {
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    const f = fakeRoles(HEADS);
    expect((await tick(f, at(0))).ran).toBe(false);
    expect(f.refreshes()).toBe(0);
    expect(resolvedRows()).toHaveLength(0);
  });

  it("against the real resolver: a retired Thinking head produces the Thinking notice naming the next catalogued selector", async () => {
    // Every list selector catalogued, so each head is its list's first entry; then the Thinking head's provider/id disappears.
    const all = new Map<string, CatalogModel>();
    for (const list of Object.values(ROLE_LISTS)) for (const s of list) {
      const m = parseModelString(s);
      all.set(selectorKey(m), { provider: m.provider, id: m.model, thinking: ["low", "medium", "high"] });
    }
    let catalog = [...all.values()];
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog });
    const notices: string[] = [];
    await runModelRolesTick({ store, roles, now: at(0), notify: (t) => notices.push(t) });
    const retired = selectorKey(parseModelString(ROLE_LISTS.thinking[0]!));
    catalog = catalog.filter((m) => selectorKey({ provider: m.provider, model: m.id }) !== retired);
    const r = await runModelRolesTick({ store, roles, now: at(1), notify: (t) => notices.push(t) });
    expect(r.changed).toContain("thinking");
    const line = notices.find((t) => t.startsWith("🔁 Thinking "));
    expect(line).toContain(parseModelString(ROLE_LISTS.thinking[1]!).model);
  });
});
