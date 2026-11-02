import { describe, expect, it, vi } from "vitest";
import type { TelegramAllowlist } from "../../src/domain/types.js";
import { FRESH_REPLY } from "../../src/gateway/fresh-command.js";
import { Gateway, HELP_TEXT } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { onPlannerControl } from "../../src/telegram/telegram-daemon.js";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";
import { isSelfWriteActionEvent, normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2026-11-02 §6.2: /fresh is Paco's exit from a transcript that carries a level. The request is persisted for the chat
// (the reset happens at the next start), the reply says so honestly, and a redelivered update never re-stamps it.
const allowlist: TelegramAllowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
const freshEvent = (text = "/fresh") => {
  const n = normalizeTelegramUpdate({ update_id: 9, message: { message_id: 3, text, from: { id: 111 }, chat: { id: 222 } } }, allowlist);
  if (!n.ok || isSelfWriteActionEvent(n.event)) throw new Error("expected a task event");
  return n.event;
};

describe("/fresh command", () => {
  it("parses with no arguments only", () => {
    expect(parseTelegramCommand("/fresh")).toEqual({ ok: true, command: { type: "fresh" } });
    expect(parseTelegramCommand("/fresh@houge_bot")).toEqual({ ok: true, command: { type: "fresh" } });
    expect(parseTelegramCommand("/fresh extra").ok).toBe(false);
  });
  it("sets the chat's marker and queues exactly the fixed reply; a redelivery writes no second instant", () => {
    const store = RunStore.openInMemory();
    const gw = new Gateway(store);
    const event = freshEvent();
    expect(event.type).toBe("fresh");
    expect(gw.intake(event, "2026-11-02T01:00:00.000Z")).toEqual({ ok: true, status: "fresh_requested", run_id: "" });
    expect(store.freshRequestedAt("222")).toBe("2026-11-02T01:00:00.000Z");
    expect(gw.intake(event, "2026-11-02T02:00:00.000Z")).toMatchObject({ ok: true, status: "fresh_requested" });
    expect(store.freshRequestedAt("222")).toBe("2026-11-02T01:00:00.000Z");
    expect([...drainOutbox(store).values()].map((p) => p.text)).toEqual([FRESH_REPLY]);
    store.close();
  });
  it("is listed in /help", () => {
    expect(HELP_TEXT.split("\n").some((l) => l.startsWith("/fresh — "))).toBe(true);
  });
  it("the daemon asks every planner supervisor to stop an idle child", async () => {
    const sups = [{ onFreshRequested: vi.fn(async () => undefined) }, { onFreshRequested: vi.fn(async () => undefined) }];
    const worker = { plannerSupervisors: () => sups } as unknown as Parameters<typeof onPlannerControl>[1];
    const store = RunStore.openInMemory();
    onPlannerControl("fresh_requested", worker, store);
    expect(sups.map((s) => s.onFreshRequested.mock.calls.length)).toEqual([1, 1]);
    store.close();
  });
});
