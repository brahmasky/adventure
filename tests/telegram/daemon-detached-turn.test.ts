import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KILLED_TEXT, PlannerSupervisor } from "../../src/omp/planner-supervisor.js";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";
import { pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";
import { until } from "../helpers/omp-worker.js";

pinOmpEnv();
const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
const update = (update_id: number, text: string) => ({ update_id, message: { message_id: update_id, text, from: { id: 111 }, chat: { id: 222 } } });

let root: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hdd-")); // short: the bridge socket must fit sun_path
  // /kill writes the tombstone and /rearm deletes the posture file: both stay inside the tmp root.
  for (const k of ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH"]) saved[k] = process.env[k];
  process.env.HOUGE_TOMBSTONE_PATH = join(root, "houge.kill");
  process.env.HOUGE_DISARM_PATH = join(root, "houge.disarm");
  // A destructive command asks Paco first; after the approval it runs in the chat workspace, then the fake hangs.
  useFakeOmp({ "*": { rpcHangAfterPrompt: true, rpcCall: { tool: "bash", args: { command: "rm -rf ./scratch-dir" } } } }, root);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const turnRun = (store: RunStore) => store.getLedgerEvents().find((e) => e.event_type === "loop_started")?.run_id ?? "";
const toolApprovalId = (store: RunStore) => store.listLiveApprovals(new Date().toISOString())[0]?.approval_id;

describe("detached turns in the daemon (Task 13)", () => {
  it("a waiting turn never blocks intake: /approve is processed while the turn is still running, and the call then runs", async () => {
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    const sent: string[] = [];
    const seen = { approvedWhileRunning: false };
    mkdirSync(join(root, "omp", "workspace", "chat-222", "scratch-dir"), { recursive: true });
    let calls = 0;
    try {
      await runTelegramDaemon({
        store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOWLIST,
        stopSignal: controller.signal, longPollTimeoutSeconds: 0, outboxPumpMs: 20,
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            if (calls === 1) return [update(1, "clean up the scratch dir")];
            if (calls === 2) {
              await until(() => toolApprovalId(store) !== undefined);
              return [update(2, `/approve ${toolApprovalId(store)}`)];
            }
            const id = store.getLedgerEvents().find((e) => e.event_type === "approval_requested")?.payload.approval_id as string;
            await until(() => store.getToolApproval(id)?.state !== "pending").catch(() => undefined);
            seen.approvedWhileRunning = store.getToolApproval(id)?.state !== "pending" && store.getRunState(turnRun(store)) === "running";
            await until(() => !existsSync(join(root, "omp", "workspace", "chat-222", "scratch-dir"))).catch(() => undefined);
            controller.abort();
            return [];
          },
          sendMessage: async ({ text }) => { sent.push(text); return { message_id: sent.length }; }
        }
      });
      expect(seen.approvedWhileRunning).toBe(true);
      expect(existsSync(join(root, "omp", "workspace", "chat-222", "scratch-dir"))).toBe(false); // the approved call ran
      expect(sent.some((t) => t.includes("rm"))).toBe(true); // the approval card reached Paco mid-turn (pump)
    } finally {
      store.close();
    }
  });

  it("/kill aborts the live turn without blocking the poll loop: the next poll runs while the run is still running", async () => {
    // The fake acks the abort but never ends the turn, so abortAll must wait out its grace bound
    // (≈5 s) before it stops the child. A detached /kill lets the next poll through meanwhile.
    useFakeOmp({ "*": { rpcHangAfterPrompt: true, rpcIgnoreAbort: true, rpcCall: { tool: "bash", args: { command: "rm -rf ./scratch-dir" } } } }, root);
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    const sent: string[] = [];
    let calls = 0;
    const seen = { nextPollWhileRunning: false };
    try {
      await runTelegramDaemon({
        store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOWLIST,
        stopSignal: controller.signal, longPollTimeoutSeconds: 0, outboxPumpMs: 20,
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            if (calls === 1) return [update(1, "clean up the scratch dir")];
            if (calls === 2) { await until(() => toolApprovalId(store) !== undefined); return [update(2, "/kill")]; }
            if (calls === 3) seen.nextPollWhileRunning = store.getRunState(turnRun(store)) === "running";
            await until(() => sent.includes(KILLED_TEXT), 15_000).catch(() => undefined);
            controller.abort();
            return [];
          },
          sendMessage: async ({ text }) => { sent.push(text); return { message_id: sent.length }; }
        }
      });
      expect(seen.nextPollWhileRunning).toBe(true);
      expect(sent).toContain(KILLED_TEXT);
      expect(store.getLedgerEvents(turnRun(store)).find((e) => e.event_type === "run_failed")?.payload).toMatchObject({ error_type: "killed" });
    } finally {
      store.close();
    }
  }, 30_000);

  it("/rearm clears every planner's crash-loop latch (spec §7)", async () => {
    const reset = vi.spyOn(PlannerSupervisor.prototype, "resetCrashGuard");
    useFakeOmp({ "*": { rpcText: "hi" } }, root);
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    const sent: string[] = [];
    let calls = 0;
    try {
      await runTelegramDaemon({
        store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOWLIST,
        stopSignal: controller.signal, longPollTimeoutSeconds: 0, outboxPumpMs: 20,
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            if (calls === 1) return [update(1, "hello")];
            if (calls === 2) { await until(() => sent.includes("hi")); return [update(2, "/rearm")]; }
            controller.abort();
            return [];
          },
          sendMessage: async ({ text }) => { sent.push(text); return { message_id: sent.length }; }
        }
      });
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });
});
