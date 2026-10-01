// tests/telegram/approval-buttons.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";
import { APPROVAL_TAP_ANSWER_TIMEOUT_MS, answerApprovalTap, runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";
import { parseApprovalCallback } from "../../src/triggers/telegram-command-parser.js";
import { normalizeTelegramUpdate, type TelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import { pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";
import { until } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

pinOmpEnv();

// Live gate 2026-10-01: the approval card asked the operator to TYPE `/approve <id>`, and the renderer ate the
// id's underscore. A button carries the exact id. The tap must be the typed command in every way that matters:
// the same gateway intake, the same requester identity and allowlist, deduped on the callback's update.
const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function root(): string { const d = mkdtempSync(join(tmpdir(), "houge-apprbtn-")); dirs.push(d); return d; }

function pendingToolApproval(store: RunStore): string {
  const run_id = createQueuedTurnRun(store);
  store.claimRun(run_id, "planner:c1:a", 120);
  return store.createToolApproval({ run_id, worker_id: "planner:c1:a", tool_call_id: "tc1", capability: "shell_external",
    input_hash: "h", action_fingerprint: "f", requester: { kind: "user", id: "paco" }, summary: "git push",
    side_effect_level: "external_write", expires_at: new Date(Date.now() + 60_000).toISOString() }).approval_id;
}

function cardFor(store: RunStore, approval_id: string) {
  for (let n = store.claimNextNotification("t", 30); n; n = store.claimNextNotification("t", 30)) {
    if (n.intent_type === "approval_prompt" && n.approval_id === approval_id) return n;
  }
  return undefined;
}

function tap(update_id: number, data: string, from = 111): TelegramUpdate {
  return { update_id, callback_query: { id: `cb${update_id}`, from: { id: from }, message: { message_id: 9, chat: { id: 222 } }, data } };
}

describe("approval cards carry Approve / Deny buttons", () => {
  it("a tool-approval card has both buttons, each under Telegram's 64-byte callback_data cap", () => {
    const store = RunStore.openInMemory();
    try {
      const id = pendingToolApproval(store);
      const buttons = cardFor(store, id)?.payload.buttons;
      expect(buttons?.map((b) => b.data)).toEqual([`approval:approve:${id}`, `approval:deny:${id}`]);
      for (const b of buttons ?? []) expect(Buffer.byteLength(b.data, "utf8")).toBeLessThanOrEqual(64);
    } finally { store.close(); }
  });

  it("a run-level approval card gets the same buttons", () => {
    const store = RunStore.openInMemory();
    try {
      const intake = new Gateway(store).intake(buildTypedTaskEvent({ source: "cli", type: "run", program: "research-brief", goal: "g",
        requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "222" }, idempotency_key: "cli:x", source_reference: "argv" }));
      if (!intake.ok) throw new Error("expected run");
      store.claimRun(intake.run_id, "w", 30);
      const { approval_id } = store.createApprovalRequest({ run_id: intake.run_id, approval_type: "capability", capability: "local_project_write",
        action_fingerprint: "fp", adapter_input_hash: "h", adapter_input_json: "{}", action_summary: "Write x", side_effect_level: "local_write",
        risk_level: "medium", affected_resources: [], requester: { kind: "user", id: "paco" }, expires_at: "2099-01-01T00:00:00.000Z" });
      expect(cardFor(store, approval_id)?.payload.buttons?.map((b) => b.data)).toEqual([`approval:approve:${approval_id}`, `approval:deny:${approval_id}`]);
    } finally { store.close(); }
  });
});

describe("parseApprovalCallback", () => {
  it("parses approval:<approve|deny>:<id> and rejects anything else", () => {
    expect(parseApprovalCallback("approval:approve:appr_x")).toEqual({ type: "approve", approval_id: "appr_x" });
    expect(parseApprovalCallback("approval:deny:appr_x")).toEqual({ type: "deny", approval_id: "appr_x" });
    for (const bad of ["approval:approve:", "approval:merge:appr_x", "approval:approve:a:b", "selfwrite:merge:run_x", "approve:appr_x", 7, undefined]) {
      expect(parseApprovalCallback(bad), String(bad)).toBeNull();
    }
  });
});

describe("a button tap normalizes to the typed /approve event", () => {
  it("same type, id, requester and chat as the typed command; keyed on the callback update", () => {
    const typed = normalizeTelegramUpdate({ update_id: 5, message: { message_id: 3, text: "/approve appr_x", from: { id: 111 }, chat: { id: 222 } } }, ALLOWLIST);
    const tapped = normalizeTelegramUpdate(tap(6, "approval:approve:appr_x"), ALLOWLIST);
    if (!typed.ok || !tapped.ok) throw new Error("expected both to normalize");
    const pick = (e: TypedTaskEvent) => ({ source: e.source, type: e.type, approval_id: e.approval_id, requested_by: e.requested_by, notify: e.notify });
    expect(pick(tapped.event as TypedTaskEvent)).toEqual(pick(typed.event as TypedTaskEvent));
    expect((tapped.event as TypedTaskEvent).idempotency_key).toBe("telegram:6:callback:cb6");
    expect((tapped.event as TypedTaskEvent).metadata?.telegram_callback_id).toBe("cb6");
  });

  it("a tap from someone off the allowlist never becomes an approval", () => {
    const r = normalizeTelegramUpdate(tap(7, "approval:approve:appr_x", 999), ALLOWLIST);
    expect(r.ok).toBe(false);
  });
});

describe("a tap resolves the approval through the gateway, end to end", () => {
  function client(store: RunStore, updates: () => TelegramUpdate[] | Promise<TelegramUpdate[]>, sent: string[], answered: string[]) {
    return {
      getUpdates: async () => updates(),
      sendMessage: async ({ text }: { text: string }) => { sent.push(text); return { message_id: sent.length }; },
      answerCallbackQuery: async ({ callback_query_id }: { callback_query_id: string }) => { answered.push(callback_query_id); }
    };
  }

  it("poll runner: Approve stops the spinner, approves, shows the outcome; a redelivered tap is deduped", async () => {
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    const answered: string[] = [];
    try {
      const id = pendingToolApproval(store);
      const r = root();
      useFakeOmp({ "*": { rpcText: "x" } }, r);
      const omp = { dataDir: r, distDir: tmpOmpDist(r) };
      const telegramClient = client(store, () => [tap(70, `approval:approve:${id}`)], sent, answered);
      await runTelegramPollOnce({ store, projectRoot: r, omp, allowlist: ALLOWLIST, telegramClient });
      expect(answered).toEqual(["cb70"]);
      expect(store.getToolApproval(id)?.state).toBe("approved");
      expect(sent.some((t) => t.includes("Approval approved"))).toBe(true);
      expect(sent.some((t) => t.includes("/approve"))).toBe(true); // the card itself, flushed in the same cycle
      const resolvedBefore = store.getLedgerEvents().filter((e) => e.event_type === "approval_resolved").length;
      store.setOffset("telegram", 0);
      await runTelegramPollOnce({ store, projectRoot: r, omp, allowlist: ALLOWLIST, telegramClient });
      expect(store.getLedgerEvents().filter((e) => e.event_type === "approval_resolved").length).toBe(resolvedBefore);
    } finally { store.close(); }
  });

  it("poll runner: the decision lands BEFORE the spinner is answered, and a rejecting answer never blocks it", async () => {
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    const stateAtAnswer: Array<string | undefined> = [];
    try {
      const id = pendingToolApproval(store);
      const r = root();
      useFakeOmp({ "*": { rpcText: "x" } }, r);
      const telegramClient = {
        ...client(store, () => [tap(71, `approval:approve:${id}`), { update_id: 72, message: { message_id: 72, text: "/approvals", from: { id: 111 }, chat: { id: 222 } } }], sent, []),
        answerCallbackQuery: async () => { stateAtAnswer.push(store.getToolApproval(id)?.state); throw new Error("HTTP 400 query is too old"); }
      };
      const result = await runTelegramPollOnce({ store, projectRoot: r, omp: { dataDir: r, distDir: tmpOmpDist(r) }, allowlist: ALLOWLIST, telegramClient });
      expect(stateAtAnswer).toEqual(["approved"]); // intake first, then the best-effort answer
      expect(store.getToolApproval(id)?.state).toBe("approved");
      expect(result.processed_updates).toBe(2); // the loop went on to the next update
    } finally { store.close(); }
  });

  it("a hanging answer is bounded: answerApprovalTap gives up after its timeout", async () => {
    const event = { metadata: { telegram_callback_id: "cb1" } } as unknown as TypedTaskEvent;
    const t0 = Date.now();
    await answerApprovalTap(event, { answerCallbackQuery: () => new Promise<void>(() => undefined) }, 50);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(APPROVAL_TAP_ANSWER_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("daemon: Deny denies the approval through the same path", async () => {
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    const answered: string[] = [];
    const controller = new AbortController();
    try {
      const id = pendingToolApproval(store);
      const r = root();
      useFakeOmp({ "*": { rpcText: "x" } }, r);
      let calls = 0;
      await runTelegramDaemon({ store, projectRoot: r, omp: { dataDir: r, distDir: tmpOmpDist(r) }, allowlist: ALLOWLIST,
        stopSignal: controller.signal, longPollTimeoutSeconds: 0,
        telegramClient: client(store, async () => {
          calls += 1;
          if (calls === 1) return [tap(80, `approval:deny:${id}`)];
          await until(() => sent.some((t) => t.includes("Approval denied")), 3_000).catch(() => undefined);
          controller.abort();
          return [];
        }, sent, answered) });
      expect(answered).toEqual(["cb80"]);
      expect(store.getToolApproval(id)?.state).toBe("denied");
      expect(sent.some((t) => t.includes("Approval denied"))).toBe(true);
    } finally { store.close(); }
  });
});
