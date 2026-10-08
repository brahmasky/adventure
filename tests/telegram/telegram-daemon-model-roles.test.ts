import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelsRefusalText } from "../../src/gateway/models-commands.js";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";
import { pinEnabledFlags, pinOmpEnv } from "../helpers/omp-env.js";

// PINNED_ENV: no omp variable from the real .env; HOUGE_OMP_BIN is a non-executable path, so the catalog read fails (null)
// without spawning anything real, and the tick takes its catalog-unavailable branch.
pinOmpEnv();
pinEnabledFlags();

const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
let dirs: string[] = [];
beforeEach(() => { vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); });
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

async function cycle(store: RunStore, updates: unknown[] = []): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "houge-daemon-roles-")); dirs.push(root);
  const controller = new AbortController(); const sent: string[] = []; let calls = 0;
  await runTelegramDaemon({
    store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: controller.signal, longPollTimeoutSeconds: 0,
    llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
    telegramClient: {
      getUpdates: async () => { calls += 1; if (calls === 1) return updates as never[]; controller.abort(); return []; },
      sendMessage: async ({ text }) => { sent.push(text); return { message_id: sent.length }; }
    }
  });
  return sent;
}
const rows = (store: RunStore) => store.getLedgerEvents().filter((e) => e.event_type === "model_roles_resolved");

describe("daemon: model roles", () => {
  it("/models through the real poll loop answers with the role list from the worker's resolver", async () => {
    const store = RunStore.openInMemory();
    try {
      const sent = await cycle(store, [{ update_id: 70, message: { message_id: 70, text: "/models", from: { id: 111 }, chat: { id: 222 } } }]);
      const reply = sent.find((t) => t.includes("Model roles"));
      expect(reply).toBeDefined();
      expect(reply).toContain("default");
      expect(sent).not.toContain(modelsRefusalText("unavailable"));
    } finally { store.close(); }
  });

  it("the tick runs on the first cycle and not again within the day", async () => {
    const store = RunStore.openInMemory();
    try {
      await cycle(store);
      expect(rows(store)).toHaveLength(1);
      expect(rows(store)[0]!.payload.catalog_ok).toBe(false); // NO_OMP_BIN: the catalog read failed, the latch still advanced
      // The boot read and the tick's read are two consecutive failures: Task 7's resolver pages Paco once (a sustained
      // outage must reach him), and the tick itself adds no incident of its own.
      const catalogIncidents = () => store.listOpenIncidents().filter((i) => i.kind === "model_catalog_unavailable");
      expect(catalogIncidents()).toHaveLength(1);
      expect(store.listOpenIncidents().filter((i) => i.kind === "role_unresolved")).toHaveLength(0);
      await cycle(store);
      expect(rows(store)).toHaveLength(1);
      expect(catalogIncidents()).toHaveLength(1);
    } finally { store.close(); }
  });

  it("static mode: no tick", async () => {
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    const store = RunStore.openInMemory();
    try {
      await cycle(store);
      expect(rows(store)).toHaveLength(0);
    } finally { store.close(); }
  });
});
