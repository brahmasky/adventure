import { describe, expect, it } from "vitest";
import { formatModelString, parseModelString, type ModelString } from "../../src/omp/model-string.js";
import { ROLE_LISTS, STATIC_ROLE_LISTS, staticRoleChains, type CatalogModel, type RoleChains } from "../../src/omp/model-roles.js";
import { CATALOG_RETRY_MS, NO_LEG_REFRESH_MS, RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { fixtureCatalog, pinnedRoles } from "../helpers/model-roles.js";

const fmt = (l: ModelString[]) => l.map(formatModelString);
const notes = (store: RunStore, type: "model_catalog_unavailable" | "model_roles_fallback") =>
  store.getLedgerEvents().filter((e) => e.event_type === type).map((e) => e.payload);
const openCatalogIncidents = (store: RunStore) => store.listOpenIncidents().filter((i) => i.kind === "model_catalog_unavailable");
/** The seven chains as ROLE_LISTS (resolved mode before any catalog read: Decision 4 keeps every list whole). */
const listChains = (): RoleChains => {
  const s = (r: keyof typeof ROLE_LISTS) => ROLE_LISTS[r].map(parseModelString);
  return { planner: s("default"), reader: s("reader"), media: s("vision"), ticks: s("tiny"), judges: s("judges"), chair: s("chair"), reviewer: s("reviewer") };
};

// Spec 2026-10-06 §4 / §9: every seat now runs on this service. The tests pin what surrounds the pure resolution:
// the catalog lifecycle (Decision 4, F14), overrides read at each resolution, the rollback switch, the empty-role
// fallback (F7) and chains().
describe("RoleResolver", () => {
  it("before any catalog read, every chain is its resolved list, whole: a catalog outage never empties a role (Decision 4)", () => {
    const store = RunStore.openInMemory();
    const roles = new RoleResolver({ store, env: () => ({}), readCatalog: async () => null });
    expect(roles.catalog()).toBeNull();
    expect(roles.chains()).toEqual(listChains());
    store.close();
  });

  it("a good read replaces the catalog; a failed or throwing read keeps the last good one and leaves one note per read", async () => {
    const store = RunStore.openInMemory();
    let next: () => Promise<CatalogModel[] | null> = async () => fixtureCatalog();
    const roles = new RoleResolver({ store, env: () => ({}), readCatalog: () => next() });
    expect(await roles.refreshCatalog()).toBe(true);
    next = async () => null;
    expect(await roles.refreshCatalog()).toBe(false);
    next = async () => { throw new Error("spawn EAGAIN"); };
    expect(await roles.refreshCatalog()).toBe(false);
    expect(roles.catalog()).toEqual(fixtureCatalog());
    expect(notes(store, "model_catalog_unavailable")).toEqual([{ reason: "read_failed" }, { reason: "read_failed" }]);
    store.close();
  });

  // F14: a catalog outage used to be a ledger note only, left for a day. Paco must hear of a persistent one, and the
  // roles must recover within the hour, not at the next daily tick.
  it("two consecutive failed reads open one alerted model_catalog_unavailable incident; the next good read resolves it", async () => {
    const store = RunStore.openInMemory();
    let ok = false;
    const roles = new RoleResolver({ store, env: () => ({}), readCatalog: async () => (ok ? fixtureCatalog() : null) });
    await roles.refreshCatalog();
    expect(openCatalogIncidents(store)).toEqual([]); // one failure is a note, not a page
    await roles.refreshCatalog();
    await roles.refreshCatalog();
    expect(openCatalogIncidents(store).map((i) => i.subject)).toEqual(["omp"]); // opened once, not per failure
    ok = true;
    await roles.refreshCatalog();
    expect(openCatalogIncidents(store)).toEqual([]);
    store.close();
  });

  it("retries a failed read once it is an hour old, and never while the last read succeeded", async () => {
    const store = RunStore.openInMemory();
    let t = 0;
    let reads = 0;
    let ok = false;
    const roles = new RoleResolver({ store, env: () => ({}), now: () => t, readCatalog: async () => { reads++; return ok ? fixtureCatalog() : null; } });
    await roles.refreshCatalog();
    t = CATALOG_RETRY_MS - 1;
    expect(roles.retryFailedRead()).toBeNull();
    t = CATALOG_RETRY_MS;
    ok = true;
    expect(await roles.retryFailedRead()).toBe(true);
    t += 10 * CATALOG_RETRY_MS;
    expect(roles.retryFailedRead()).toBeNull(); // healthy: the daily tick owns the next read
    expect(reads).toBe(2);
    store.close();
  });

  it("requestRefresh (a no_planner_leg) re-reads at most once per 10 minutes", async () => {
    const store = RunStore.openInMemory();
    let t = 0;
    let reads = 0;
    const roles = new RoleResolver({ store, env: () => ({}), now: () => t, readCatalog: async () => { reads++; return fixtureCatalog(); } });
    roles.requestRefresh();
    await roles.refreshCatalog(); // joins the read in flight
    t = NO_LEG_REFRESH_MS - 1;
    roles.requestRefresh();
    t = NO_LEG_REFRESH_MS;
    roles.requestRefresh();
    await roles.refreshCatalog(); // joins the read requestRefresh started: one omp spawn, not two
    expect(reads).toBe(2); // the first read and the one at 10 min; never one at 10 min − 1 ms
    store.close();
  });

  it("reads Paco's override at every resolution: set, then reset, with no restart", async () => {
    const store = RunStore.openInMemory();
    const roles = await pinnedRoles(store, fixtureCatalog());
    expect(fmt(roles.candidates("thinking"))[0]).toBe("anthropic/claude-opus-5-5:high");
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus-4-6", actor: "paco" });
    expect(fmt(roles.candidates("thinking"))[0]).toBe("google-antigravity/claude-opus-4-6:high");
    store.recordModelRoleOverride({ key: "thinking", pattern: "", actor: "paco" });
    expect(fmt(roles.candidates("thinking"))[0]).toBe("anthropic/claude-opus-5-5:high");
    store.close();
  });

  it("HOUGE_MODEL_ROLES=static runs today's chains, ignoring the catalog and the overrides, read per call (§4.3)", async () => {
    const store = RunStore.openInMemory();
    let env: NodeJS.ProcessEnv = { HOUGE_MODEL_ROLES: "static" };
    store.recordModelRoleOverride({ key: "default", pattern: "k3", actor: "paco" });
    const roles = new RoleResolver({ store, env: () => env, readCatalog: async () => fixtureCatalog().filter((m) => m.provider === "kimi-code") });
    expect(await roles.refreshCatalog()).toBe(false); // static has no catalog (F3): no read
    expect(roles.chains()).toEqual(staticRoleChains());
    expect(fmt(roles.candidates("fast", { effort: "low" }))).toEqual([...STATIC_ROLE_LISTS.default]); // routed effort not applied
    expect(notes(store, "model_roles_fallback")).toEqual([]); // static never "falls back": it is the static list
    env = {};
    await roles.refreshCatalog();
    expect(fmt(roles.candidates("default"))).toEqual(["kimi-code/k3:low"]);
    store.close();
  });

  // F3 / spec §4.3: static is the rollback and has no catalog. Reading omp's catalog anyway would page Paco with
  // model_catalog_unavailable for a catalog nothing uses, and keep retrying it hourly.
  it("HOUGE_MODEL_ROLES=static never reads the catalog: no boot read, no retry, no refresh, no note, no incident", async () => {
    const store = RunStore.openInMemory();
    let reads = 0; let t = 0;
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "static" }), now: () => t,
      readCatalog: async () => { reads += 1; return null; } });
    expect(await roles.refreshCatalog()).toBe(false);
    expect(await roles.refreshCatalog()).toBe(false);
    t += CATALOG_RETRY_MS + NO_LEG_REFRESH_MS;
    expect(roles.retryFailedRead()).toBeNull();
    roles.requestRefresh();
    await Promise.resolve();
    expect(reads).toBe(0);
    expect(notes(store, "model_catalog_unavailable")).toEqual([]);
    expect(openCatalogIncidents(store)).toEqual([]);
    store.close();
  });

  it("candidates() skips the child's refused selectors and clamps the turn's routed effort per model (Decision 2)", async () => {
    const store = RunStore.openInMemory();
    const roles = await pinnedRoles(store, fixtureCatalog());
    expect(fmt(roles.candidates("default", { refused: new Set(["anthropic/claude-opus-5-5"]), effort: "medium" })))
      .toEqual(["google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:high"]);
    store.close();
  });

  // F7: a catalog snapshot can drop every candidate of a role (Decision 3 saw the catalog move twice in a day, and a
  // provider whose auth lapses leaves `omp models`). Fast steps up; every other role must still have something to run.
  it("a catalog that empties Fast returns no candidate (the supervisor steps up); Default and Thinking fall back to their static list", async () => {
    const store = RunStore.openInMemory();
    // A catalog with one model no planner list names.
    const roles = await pinnedRoles(store, fixtureCatalog().filter((m) => m.provider === "google-antigravity" && m.id === "gemini-3.1-pro"));
    expect(roles.candidates("fast")).toEqual([]);
    expect(fmt(roles.candidates("default"))).toEqual([...STATIC_ROLE_LISTS.default]);
    expect(fmt(roles.candidates("thinking", { effort: "high" }))).toEqual([...STATIC_ROLE_LISTS.thinking]); // unfiltered, unclamped
    expect(fmt(roles.candidates("default", { refused: new Set(["anthropic/claude-opus-5-5"]) })))
      .toEqual(STATIC_ROLE_LISTS.default.slice(1)); // the spawn axis still walks past what the child refused
    store.close();
  });

  it("notes model_roles_fallback once per role per catalog read, however often the role is resolved", async () => {
    const store = RunStore.openInMemory();
    const roles = await pinnedRoles(store, fixtureCatalog().filter((m) => !/claude|k3/.test(m.id)));
    roles.candidates("default"); roles.candidates("default"); roles.chains();
    // No claude and no k3 in the catalog: Default, judge seat 0, Chair and Reviewer resolve empty (Fast and Tiny keep gemini-3.8-flash).
    expect(notes(store, "model_roles_fallback")).toEqual([{ role: "default" }, { role: "judges:0" }, { role: "chair" }, { role: "reviewer" }]);
    await roles.refreshCatalog();
    roles.candidates("default");
    expect(notes(store, "model_roles_fallback")).toHaveLength(5); // a new read, a new note
    store.close();
  });

  it("chains() keeps every judge on its own index; an emptied seat or role runs its static selector, never an empty chain", async () => {
    const store = RunStore.openInMemory();
    const trimmed = fixtureCatalog().filter((m) => m.provider !== "openai-codex" && !(m.provider === "google-antigravity" && m.id === "gemini-3.8-flash"));
    const roles = await pinnedRoles(store, trimmed, { "judges:0": "opus-4-6" });
    const c = roles.chains();
    expect(fmt(c.judges)).toEqual(["google-antigravity/claude-opus-4-6", "openai-codex/gpt-5.5", "google-antigravity/gemini-3.1-pro"]);
    expect(c.media).toEqual(staticRoleChains().media);
    expect(fmt(c.reader)).toEqual(["kimi-code/k3:low"]); // not empty: no fallback
    expect(notes(store, "model_roles_fallback")).toEqual([{ role: "vision" }, { role: "judges:1" }]);
    store.close();
  });

  it("resolveAll() lists every role and judge seat with its head, its candidates and its source; an emptied role shows head null", async () => {
    const store = RunStore.openInMemory();
    const roles = await pinnedRoles(store, fixtureCatalog(), { vision: "gemini-3.1-pro" });
    const all = roles.resolveAll();
    expect(all.map((r) => r.key)).toEqual(["fast", "default", "thinking", "reader", "vision", "tiny", "judges:0", "judges:1", "judges:2", "chair", "reviewer"]);
    expect(all.find((r) => r.key === "vision")).toEqual({ key: "vision", head: "google-antigravity/gemini-3.1-pro:low",
      candidates: ["google-antigravity/gemini-3.1-pro:low", "google-antigravity/gemini-3.8-flash:low"], source: "override" });
    expect(all.find((r) => r.key === "default")?.source).toBe("list");
    const bare = await pinnedRoles(store, fixtureCatalog().filter((m) => !/claude|k3/.test(m.id)));
    expect(bare.resolveAll().find((r) => r.key === "default")).toMatchObject({ head: null, candidates: [] }); // role_unresolved sees it (Task 11)
    store.close();
  });
});
