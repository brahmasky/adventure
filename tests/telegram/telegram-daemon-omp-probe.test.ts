import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportOmpCheck } from "../../src/llm/registry.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { setSharedOmpVersionCacheForTest, type OmpVersionCache } from "../../src/omp/omp-version-cache.js";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon, type RunTelegramDaemonOptions } from "../../src/telegram/telegram-daemon.js";
import { pinEnabledFlags, pinOmpEnv } from "../helpers/omp-env.js";

// Spec §3 Boot: an idle daemon must still learn its omp version at boot and start the probe; a broken omp must page as
// before and never stop boot. PINNED_ENV: HOUGE_OMP_BIN is a non-executable path, so the default check is not_runnable.
pinOmpEnv();
pinEnabledFlags();

const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
let dirs: string[] = [];
afterEach(() => { setSharedOmpVersionCacheForTest(null); for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

async function boot(store: RunStore, extra: Partial<RunTelegramDaemonOptions> = {}): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "houge-daemon-probe-")); dirs.push(root);
  const controller = new AbortController();
  const result = await runTelegramDaemon({
    store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: controller.signal, longPollTimeoutSeconds: 0,
    llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
    telegramClient: { getUpdates: async () => { controller.abort(); return []; }, sendMessage: async () => ({ message_id: 1 }) },
    ...extra
  });
  return result.cycles;
}
const openOmpUnavailable = (store: RunStore) => store.listOpenIncidents().filter((i) => i.kind === "omp_unavailable");
const probeRows = (store: RunStore) => store.getLedgerEvents().filter((e) => e.event_type === "omp_contract_probe");

describe("daemon boot: omp version check and contract probe", () => {
  it("the boot check's new version reaches the probe runner, and a passing check clears omp_unavailable", async () => {
    const store = RunStore.openInMemory();
    try {
      const cfg = resolveOmpConfig(process.env);
      reportOmpCheck(store, cfg, { ok: false, kind: "not_runnable", version: null, reason: "omp not runnable: ENOENT" });
      expect(openOmpUnavailable(store)).toHaveLength(1);
      let listener: ((v: string) => void) | null = null; let checks = 0;
      const cache: OmpVersionCache = {
        current: async () => { checks += 1; listener?.("18.7.0"); return { ok: true, version: "18.7.0" }; },
        lastVersion: () => "18.7.0",
        setNewVersionListener: (cb) => { listener = cb; }
      };
      setSharedOmpVersionCacheForTest(cfg, cache);
      const probed: string[] = []; const seen: Array<string | null> = [];
      await boot(store, { ompProbeRunner: (d) => { seen.push(d.currentVersion()); return { maybeProbe: (v) => { probed.push(v); } }; } });
      expect(probed).toEqual(["18.7.0"]);
      expect(seen).toEqual(["18.7.0"]); // currentVersion reads the cache's last version
      expect(checks).toBe(1);
      expect(openOmpUnavailable(store)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("a stub omp pages omp_unavailable once, boot completes, and no probe runs", async () => {
    const store = RunStore.openInMemory();
    try {
      expect(await boot(store)).toBeGreaterThan(0);
      expect(openOmpUnavailable(store)).toHaveLength(1);
      expect(probeRows(store)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("a probe runner that fails to start never stops boot nor skips the boot version check", async () => {
    const store = RunStore.openInMemory();
    try {
      const cycles = await boot(store, { ompProbeRunner: () => { throw new Error("runner exploded"); } });
      expect(cycles).toBeGreaterThan(0);
      expect(openOmpUnavailable(store)).toHaveLength(1); // the stub omp still paged
    } finally { store.close(); }
  });
});
