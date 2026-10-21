import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";
import { pinOmpEnv } from "../helpers/omp-env.js";

// Final fix F1 (testing review 1): the four daemon wires of 2b-ii, which only the live gate exercised before. Boot reconciles
// improvement jobs; the signal-path tick runs the improve tick WITH the job hooks (without them a recurrence never queues a
// job) and BEFORE the digest (the digest shows what the tick proposed); the digest gets the operator chat (null = no digest).
pinOmpEnv();

const calls = vi.hoisted(() => ({ order: [] as string[], improve: [] as Array<Record<string, unknown>>, digest: [] as Array<Record<string, unknown>>, boot: [] as unknown[][] }));
vi.mock("../../src/improve/tick.js", async (orig) => ({ ...(await orig<typeof import("../../src/improve/tick.js")>()),
  runImproveTick: vi.fn(async (d: Record<string, unknown>) => { calls.order.push("improve"); calls.improve.push(d); return { ran: false }; }) }));
vi.mock("../../src/decisions/digest.js", async (orig) => ({ ...(await orig<typeof import("../../src/decisions/digest.js")>()),
  runDecisionDigestTick: vi.fn((i: Record<string, unknown>) => { calls.order.push("digest"); calls.digest.push(i); return { ran: false, sent: false }; }) }));
vi.mock("../../src/core/skill-job.js", async (orig) => { const real = await orig<typeof import("../../src/core/skill-job.js")>();
  return { ...real, reconcileJobsAtBoot: vi.fn((...a: Parameters<typeof real.reconcileJobsAtBoot>) => { calls.order.push("boot"); calls.boot.push(a); return real.reconcileJobsAtBoot(...a); }) }; });

let dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; });
const ALLOWLIST = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }] };

describe("runTelegramDaemon — the improvement wiring (2b-ii, final fix F1)", () => {
  it("boot reconciles jobs; the cycle runs the improve tick with the job hooks and the operator chat, then the digest for that chat", async () => {
    const { skillJobHooks } = await import("../../src/core/skill-job.js");
    const root = mkdtempSync(join(tmpdir(), "houge-daemon-improve-")); dirs.push(root);
    const store = RunStore.openInMemory();
    const controller = new AbortController();
    await runTelegramDaemon({ store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: controller.signal, longPollTimeoutSeconds: 0,
      llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
      telegramClient: { getUpdates: async () => { controller.abort(); return []; }, sendMessage: async () => ({ message_id: 1 }) } });
    expect(calls.order).toEqual(["boot", "improve", "digest"]);
    expect(calls.boot[0]![2]).toBe("222");
    expect(calls.improve[0]).toMatchObject({ chatId: "222", jobs: skillJobHooks });
    expect(calls.improve[0]!.llm).toEqual({ pick: expect.any(Function), distill: expect.any(Function), classify: expect.any(Function), compose: expect.any(Function), verify: expect.any(Function) });
    expect(calls.digest[0]).toMatchObject({ chatId: "222", store });
    store.close();
  });
});
