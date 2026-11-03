import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectorKey, type CatalogModel } from "../../src/omp/model-roles.js";
import { parseModelString } from "../../src/omp/model-string.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { runRolesTick, type RunTelegramDaemonOptions } from "../../src/telegram/telegram-daemon.js";
import { SEED_LISTS } from "../helpers/model-roles.js";

// Spec 2026-11-03 §4: a model change is a background notice. It lands in change_log even when no operator chat is
// configured, and never reaches the outbox (chat is for Paco).
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });

const at = (d: number) => new Date(Date.parse("2026-10-07T09:00:00.000Z") + d * 86_400_000).toISOString();
const outboxCount = () => (store as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get().n;

describe("runRolesTick", () => {
  it("writes the change notice to the change log with no chat, and queues nothing for chat", async () => {
    const all = new Map<string, CatalogModel>();
    for (const s of Object.values(SEED_LISTS).flat()) {
      const m = parseModelString(s);
      all.set(selectorKey(m), { provider: m.provider, id: m.model, thinking: ["low", "medium", "high"] });
    }
    let catalog = [...all.values()];
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog });
    const worker = { modelRoles: () => roles } as unknown as Parameters<typeof runRolesTick>[1];
    const options = { store } as unknown as RunTelegramDaemonOptions;
    const signal = new AbortController().signal;
    await runRolesTick(options, worker, at(0), null, signal);
    catalog = catalog.filter((m) => selectorKey({ provider: m.provider, model: m.id }) !== "anthropic/claude-opus-5-5");
    await runRolesTick(options, worker, at(1), null, signal);
    const rows = store.listChangeLog("2026-10-01T00:00:00.000Z", 20);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.topic === "model_change")).toBe(true);
    expect(rows.some((r) => r.text.startsWith("🔁 Thinking "))).toBe(true);
    expect(outboxCount()).toBe(0);
  });
});
