import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.2: overrides are append-only ledger rows: the latest row per key wins and an empty pattern resets the key.
// They are read at every resolution, so a wrong read here silently routes every turn of a role to the wrong model.
describe("RunStore — model role overrides", () => {
  it("returns the latest pattern per key and drops a reset key", () => {
    const store = RunStore.openInMemory();
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus", actor: "paco" });
    store.recordModelRoleOverride({ key: "judges:1", pattern: "gemini-3.1-pro", actor: "paco" });
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus-4-6", actor: "paco" });
    store.recordModelRoleOverride({ key: "judges:1", pattern: "", actor: "paco" });
    expect([...store.latestModelRoleOverrides()]).toEqual([["thinking", "opus-4-6"]]);
    store.close();
  });

  it("writes one run-less model_role_override row carrying key, pattern and actor only", () => {
    const store = RunStore.openInMemory();
    store.recordModelRoleOverride({ key: "fast", pattern: "sonnet", actor: "paco" });
    const rows = store.getLedgerEvents().filter((e) => e.event_type === "model_role_override");
    expect(rows.map((e) => [e.run_id, e.payload])).toEqual([[undefined, { key: "fast", pattern: "sonnet", actor: "paco" }]]);
    store.close();
  });

  it("skips a row whose key is not a role or a judge seat (a hand-edited or future payload is never trusted)", () => {
    const store = RunStore.openInMemory();
    store.recordMemoryEvent("model_role_override", { key: "planner", pattern: "opus", actor: "x" }, "model_roles");
    store.recordMemoryEvent("model_role_override", { key: "judges:x", pattern: "opus", actor: "x" }, "model_roles");
    expect(store.latestModelRoleOverrides().size).toBe(0);
    store.close();
  });

  it("refuses a row without its required fields (the ledger validator)", () => {
    const store = RunStore.openInMemory();
    expect(() => store.recordMemoryEvent("model_role_override", { key: "fast", actor: "x" })).toThrow(/pattern/);
    expect(() => store.recordMemoryEvent("model_catalog_unavailable", {})).toThrow(/reason/);
    store.close();
  });
});
