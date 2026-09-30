import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { formatApprovalsText, Gateway, NO_PENDING_APPROVALS_TEXT } from "../../src/gateway/gateway.js";
import { TelegramNotificationAdapter } from "../../src/notifications/telegram-notification-adapter.js";
import { toolApprovalWaiters } from "../../src/omp/tool-approval-sink.js";
import { RunStore } from "../../src/run/run-store.js";
import type { TelegramSendMessageInput } from "../../src/telegram/telegram-client.js";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

let seq = 0;
const event = (type: "approvals" | "approve" | "deny", approval_id?: string) => buildTypedTaskEvent({
  source: "telegram", type, ...(approval_id ? { approval_id } : {}), requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `telegram:ap:${++seq}`,
  source_reference: `telegram:update:${seq}:message:1`, created_at: new Date().toISOString()
});

function toolApproval(store: RunStore, summary: string, expiresInMs: number): string {
  const run_id = createQueuedTurnRun(store, `turn ${summary}`);
  store.claimRun(run_id, `planner:555:${summary}`, 120);
  return store.createToolApproval({ run_id, worker_id: `planner:555:${summary}`, tool_call_id: "tc1", capability: "shell_external",
    input_hash: "h", action_fingerprint: "f", requester: { kind: "user", id: "paco" }, summary, side_effect_level: "external_write",
    expires_at: new Date(Date.now() + expiresInMs).toISOString() }).approval_id;
}

function reply(store: RunStore, key: string): string {
  for (let n = store.claimNextNotification("t", 30); n; n = store.claimNextNotification("t", 30)) {
    store.markNotificationDelivered(n.notification_id, "x");
    if (n.idempotency_key === key) return String(n.payload.text);
  }
  throw new Error(`no notification ${key}`);
}

describe("/approvals (Task 13, ruling 3)", () => {
  it("parses as a no-argument command", () => {
    expect(parseTelegramCommand("/approvals")).toEqual({ ok: true, command: { type: "approvals" } });
    expect(parseTelegramCommand("/approvals now").ok).toBe(false);
  });

  it("lists answerable tool approvals only: a pending row past its expiry is never shown (a dead id cannot be approved)", () => {
    const store = RunStore.openInMemory();
    const live = toolApproval(store, "git push", 60_000);
    const dead = toolApproval(store, "rm -rf", -1_000); // still `pending` in the table: not swept yet
    const ev = event("approvals");
    expect(new Gateway(store).intake(ev)).toMatchObject({ ok: true, status: "approvals_returned" });
    const text = reply(store, `${ev.idempotency_key}:approvals`);
    expect(text).toBe(formatApprovalsText(store.listLiveApprovals(new Date().toISOString())));
    expect(text).toContain(live);
    expect(text).not.toContain(dead);
    store.close();
  });

  it("says so when nothing is waiting", () => {
    const store = RunStore.openInMemory();
    const ev = event("approvals");
    new Gateway(store).intake(ev);
    expect(reply(store, `${ev.idempotency_key}:approvals`)).toBe(NO_PENDING_APPROVALS_TEXT);
    store.close();
  });

  it("goes out through the rich renderer (Telegram HTML, never raw markdown)", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({ sendMessage: async (i) => { sent.push(i); return { message_id: 1 }; } });
    const text = formatApprovalsText([{ approval_id: "appr_1", summary: "git push", expires_at: "2026-09-30T10:00:00.000Z" }]);
    await adapter.send({ notification_id: "n", target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: "k",
      payload: { text }, state: "sending", attempt_count: 1, provider_message_id: null });
    expect(sent[0]).toMatchObject({ parse_mode: "HTML" });
    expect(sent[0]!.text).toContain("<b>git push</b>");
    expect(sent[0]!.text).toContain("<code>/approve appr_1</code>");
  });
});

describe("/approve wakes a tool approval waited on mid-turn", () => {
  it("resolves the bridge's waiter with the decision the moment the gateway records it", async () => {
    const store = RunStore.openInMemory();
    const id = toolApproval(store, "git push", 60_000);
    const waiting = toolApprovalWaiters.wait(id, 5_000);
    expect(new Gateway(store).intake(event("approve", id))).toMatchObject({ ok: true, status: "approval_resolved" });
    await expect(waiting).resolves.toBe("approved");
    expect(store.getToolApproval(id)?.state).toBe("approved");
    store.close();
  });

  it("a deny resolves the waiter as denied", async () => {
    const store = RunStore.openInMemory();
    const id = toolApproval(store, "rm -rf", 60_000);
    const waiting = toolApprovalWaiters.wait(id, 5_000);
    new Gateway(store).intake(event("deny", id));
    await expect(waiting).resolves.toBe("denied");
    store.close();
  });
});
