// tests/telegram/handled-intake-denials.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, StandingHookError } from "../../src/run/run-store.js";
import { isHandledIntakeDenial, runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";
import { pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

pinOmpEnv();

// Live gate 2026-10-01: Paco's /approve of an already-denied id earned APPROVAL_NOT_PENDING, which the
// daemon treated as a poll failure. The update offset was never acknowledged, the same update replayed
// forever, and every later message (his correct /approve included) queued behind it. Every refusal a
// user's /approve or /deny can earn must be a handled denial, or one stale id wedges intake.
describe("approval refusals never wedge Telegram intake", () => {
  function setup(expiresInMs = 60_000) {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    store.claimRun(run_id, "planner:c1:a", 120);
    const row = store.createToolApproval({ run_id, worker_id: "planner:c1:a", tool_call_id: "tc1", capability: "shell_external",
      input_hash: "h", action_fingerprint: "f", requester: { kind: "user", id: "paco" }, summary: "git push",
      side_effect_level: "external_write", expires_at: new Date(Date.now() + expiresInMs).toISOString() });
    return { store, row };
  }
  let n = 0;
  const trigger = (store: RunStore, approval_id: string, type: "approve" | "deny", who = "paco") => {
    n += 1;
    return store.processApprovalTrigger({
      event: buildTypedTaskEvent({ source: "telegram", type, approval_id, requested_by: { kind: "user", id: who },
        notify: { kind: "local" }, idempotency_key: `telegram:${n}:${type}`, source_reference: `telegram:update:${n}:message:${n}`,
        created_at: new Date().toISOString() }),
      decision: type === "approve" ? "approved" : "denied",
      resolved_at: new Date().toISOString()
    });
  };
  const codeOf = (r: ReturnType<typeof trigger>) => (r.ok ? "ok" : r.error.code);

  it("a stale id (already denied) is a handled denial, not a poll failure", () => {
    const { store, row } = setup();
    expect(trigger(store, row.approval_id, "deny").ok).toBe(true);
    const code = codeOf(trigger(store, row.approval_id, "approve"));
    expect(code).toBe("APPROVAL_NOT_PENDING");
    expect(isHandledIntakeDenial(code)).toBe(true);
  });

  it("a mistyped id (the card's markdown once ate the underscore) is a handled denial", () => {
    const { store, row } = setup();
    const code = codeOf(trigger(store, row.approval_id.replace("appr_", "appr"), "deny"));
    expect(code).toBe("APPROVAL_NOT_FOUND");
    expect(isHandledIntakeDenial(code)).toBe(true);
  });

  it("someone other than the requester answering is a handled denial", () => {
    const { store, row } = setup();
    const code = codeOf(trigger(store, row.approval_id, "approve", "stranger"));
    expect(code).not.toBe("ok");
    expect(isHandledIntakeDenial(code)).toBe(true);
  });

  it("an expired approval is a handled denial", () => {
    const { store, row } = setup(-1_000);
    const code = codeOf(trigger(store, row.approval_id, "approve"));
    expect(code).not.toBe("ok");
    expect(isHandledIntakeDenial(code)).toBe(true);
  });
});

// The same live gate: the refusal was handled but silent. Through the real poll loop, a malformed `/deny` and a
// stale `/approve` each get their one reply in the same cycle, and the batch keeps going.
describe("refused commands are answered through the poll loop", () => {
  it("`/deny` (no id) and `/approve <unknown id>` each get a reply; the later turn still runs", async () => {
    const store = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "houge-refusal-"));
    const sent: string[] = [];
    try {
      useFakeOmp({ "*": { rpcText: "answered" } }, root);
      const msg = (update_id: number, text: string) => ({ update_id, message: { message_id: update_id, text, from: { id: 111 }, chat: { id: 222 } } });
      await runTelegramPollOnce({
        store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) },
        allowlist: { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] },
        telegramClient: {
          getUpdates: async () => [msg(90, "/deny"), msg(91, "/approve appr_nope"), msg(92, "hello")],
          sendMessage: async ({ text }) => { sent.push(text); return { message_id: sent.length }; }
        }
      });
      expect(sent.filter((t) => t.includes("/deny requires an approval id"))).toHaveLength(1);
      expect(sent.filter((t) => t.includes("appr_nope") && t.includes("/approvals"))).toHaveLength(1);
      expect(sent.some((t) => t.includes("answered"))).toBe(true);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Stage 4A whole-branch review: two approval refusals the store can return were missing from the handled set. The poll loop
// threw on each, never acknowledged the update, and replayed it forever — every later update (/kill included) and the
// schedule tick behind it stalled. Through the real poll loop: the offset passes the refused update and the next one runs.
describe("standing-approval refusals never wedge Telegram intake", () => {
  const PACO_CHAT = 222; const OTHER_CHAT = 333;
  const msg = (update_id: number, text: string, chat = PACO_CHAT) => ({ update_id, message: { message_id: update_id, text, from: { id: 111 }, chat: { id: chat } } });
  /** A scheduled run notifying Paco's chat, with one pending shell_external approval (the lease is held, so the poll's worker leaves the run alone). */
  function scheduledApproval(store: RunStore): string {
    const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post it", requested_by: { kind: "schedule", id: "sch_1" },
      notify: { kind: "telegram", chat_id: String(PACO_CHAT) }, idempotency_key: "schedule:sch_1:1", source_reference: "scheduled_tasks.sch_1" }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    store.claimRun(r.run_id, "planner:222:w", 86_400);
    return store.createToolApproval({ run_id: r.run_id, worker_id: "planner:222:w", tool_call_id: "tc1", capability: "shell_external", input_hash: "h", action_fingerprint: "f",
      requester: { kind: "user", id: "paco" }, summary: "HTTP write", side_effect_level: "external_write", expires_at: new Date(Date.now() + 60_000).toISOString() }).approval_id;
  }
  async function poll(store: RunStore, root: string, updates: ReturnType<typeof msg>[]) {
    const sent: Array<{ chat_id: string; text: string }> = [];
    useFakeOmp({ "*": { rpcText: "answered" } }, root);
    await runTelegramPollOnce({
      store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) },
      allowlist: { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [
        { telegram_chat_id: PACO_CHAT, label: "p", allowed_identity_ids: ["paco"] }, { telegram_chat_id: OTHER_CHAT, label: "o", allowed_identity_ids: ["paco"] }] },
      telegramClient: { getUpdates: async () => updates, sendMessage: async ({ chat_id, text }) => { sent.push({ chat_id: String(chat_id), text }); return { message_id: sent.length }; } }
    });
    return sent;
  }
  function withRoot<T>(fn: (store: RunStore, root: string) => Promise<T>): Promise<T> {
    const store = RunStore.openInMemory(); const root = mkdtempSync(join(tmpdir(), "houge-sr-")); // short: the bridge socket path caps at 103 bytes
    return fn(store, root).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  }

  it("an approve from another chat (APPROVAL_CHAT_MISMATCH) advances the offset, tells the foreign chat nothing, and the next update runs", () => withRoot(async (store, root) => {
    const approval_id = scheduledApproval(store);
    const sent = await poll(store, root, [msg(70, `/approve ${approval_id}`, OTHER_CHAT), msg(71, "hello")]);
    expect(store.getOffset("telegram")).toBe(72);
    expect(store.getToolApproval(approval_id)?.state).toBe("pending");
    expect(sent.filter((m) => m.chat_id === String(OTHER_CHAT))).toEqual([]); // silence on purpose: a foreign chat must not learn the id is live
    expect(sent.some((m) => m.text.includes("answered"))).toBe(true);
  }));

  it("a deny whose standing hook fails (STANDING_HOOK_FAILED) advances the offset, gets its Revoke reply, and the next update runs", () => withRoot(async (store, root) => {
    const approval_id = scheduledApproval(store);
    // the hook's own SQL failing, injected at the seam the store wraps (a dropped table would also break the probe turn)
    (store as unknown as { standingDeny: () => void }).standingDeny = () => { throw new StandingHookError("disk I/O error"); };
    const sent = await poll(store, root, [msg(80, `/deny ${approval_id}`), msg(81, "hello")]);
    expect(store.getOffset("telegram")).toBe(82);
    expect(store.getToolApproval(approval_id)?.state).toBe("pending");
    expect(sent.filter((m) => m.text.includes("/schedule") && m.text.includes("Revoke"))).toHaveLength(1);
    expect(sent.some((m) => m.text.includes("answered"))).toBe(true);
  }));
});
