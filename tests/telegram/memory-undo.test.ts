import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TypedTaskEvent } from "../../src/domain/types.js";
import { memoryUndoButton } from "../../src/capabilities/memory-correct.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { MEMORY_CHANGED_SINCE_TEXT, undoneText } from "../../src/gateway/memory-commands.js";
import { RunStore } from "../../src/run/run-store.js";
import { isHandledIntakeDenial, runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";
import { parseMemoryUndoCallback } from "../../src/triggers/telegram-command-parser.js";
import { normalizeTelegramUpdate, type TelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import { pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";
import { drainOutbox } from "../helpers/omp-worker.js";

pinOmpEnv();

// The Undo button on a memory change card (2026-10-02): a tap rides the approval buttons' path — the allowlist check
// in the trigger adapter, the ordinary gateway intake, the spinner answered after the decision — and puts the rows
// back. A second tap changes nothing and says so; a stranger's tap never becomes an event.
const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
const CHAT = "222";
let store: RunStore;
const dirs: string[] = [];
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tap(update_id: number, data: string, from = 111): TelegramUpdate {
  return { update_id, callback_query: { id: `cb${update_id}`, from: { id: from }, message: { message_id: 9, chat: { id: 222 } }, data } };
}
function tapEvent(update_id: number, data: string): TypedTaskEvent {
  const r = normalizeTelegramUpdate(tap(update_id, data), ALLOWLIST);
  if (!r.ok) throw new Error(`expected a tap event: ${r.error.code}`);
  return r.event as TypedTaskEvent;
}
const retired = (chat = CHAT) => {
  const id = store.addEpisodicFact({ chat_id: chat, fact: "Paco's daily brief needs ASML earnings" });
  return { id, change: store.retireMemoryRows({ kind: "fact", ids: [id], chat_id: chat, run_id: null })! };
};
const texts = () => [...drainOutbox(store).values()].map((p) => String(p.text));

describe("parseMemoryUndoCallback", () => {
  it("parses memory:undo:<change id> and rejects anything else", () => {
    const id = "mc_0b1c2d3e-0000-4000-8000-123456789abc";
    expect(parseMemoryUndoCallback(`memory:undo:${id}`)).toEqual({ change_id: id });
    for (const bad of ["memory:undo:", "memory:redo:" + id, `memory:undo:${id}:x`, "memory:undo:mc_../../x", "approval:approve:appr_x", 7, undefined]) {
      expect(parseMemoryUndoCallback(bad), String(bad)).toBeNull();
    }
  });

  it("the card's own button round-trips: what memoryUndoButton writes, the parser reads back", () => {
    const { change } = retired();
    expect(parseMemoryUndoCallback(memoryUndoButton(change.change_id).data)).toEqual({ change_id: change.change_id });
  });
});

describe("an Undo tap normalizes like an approval tap", () => {
  it("an allowlisted tap becomes a memory_undo event keyed on the callback update, carrying the callback id", () => {
    const { change } = retired();
    const e = tapEvent(5, `memory:undo:${change.change_id}`);
    expect(e).toMatchObject({ source: "telegram", type: "memory_undo", requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: CHAT } });
    expect(e.metadata).toMatchObject({ change_id: change.change_id, telegram_callback_id: "cb5" });
    expect(e.idempotency_key).toBe("telegram:5:callback:cb5");
  });

  it("a tap from someone off the allowlist never becomes an event", () => {
    const { id, change } = retired();
    expect(normalizeTelegramUpdate(tap(6, `memory:undo:${change.change_id}`, 999), ALLOWLIST).ok).toBe(false);
    expect(store.getEpisodicFact(id)?.status).toBe("pruned");
  });
});

describe("the gateway undoes the change", () => {
  it("restores the fact and replies; a second tap is 'already undone' and changes nothing", () => {
    const { id, change } = retired();
    const gateway = new Gateway(store);
    expect(gateway.intake(tapEvent(10, `memory:undo:${change.change_id}`))).toMatchObject({ ok: true, status: "memory_undone" });
    expect(store.getEpisodicFact(id)?.status).toBe("active");
    expect(texts()).toEqual([`↩️ Undone: #${id} is active again.`]);
    expect(gateway.intake(tapEvent(11, `memory:undo:${change.change_id}`))).toMatchObject({ ok: true, status: "memory_undone" });
    expect(texts()).toEqual(["↩️ Already undone."]);
    expect(store.getEpisodicFact(id)?.status).toBe("active");
  });

  it("undoing a correct names both rows", () => {
    const id = store.addEpisodicFact({ chat_id: CHAT, fact: "old" });
    const change = store.correctEpisodicFacts({ ids: [id], correction: "new", chat_id: CHAT, run_id: null })!;
    new Gateway(store).intake(tapEvent(12, `memory:undo:${change.change_id}`));
    expect(texts()).toEqual([`↩️ Undone: #${id} is active again; #${change.new_id} is retired.`]);
  });

  it("L1: a correct that consolidation moved on gets the code-owned 'changed since' reply and changes nothing", () => {
    const one = store.addEpisodicFact({ chat_id: CHAT, fact: "one" });
    const change = store.correctEpisodicFacts({ ids: [one], correction: "two", chat_id: CHAT, run_id: null })!;
    const three = store.addEpisodicFact({ chat_id: CHAT, fact: "three" });
    store.supersedeEpisodicFact(change.new_id!, three, new Date().toISOString());
    new Gateway(store).intake(tapEvent(14, `memory:undo:${change.change_id}`));
    expect(texts()).toEqual([MEMORY_CHANGED_SINCE_TEXT]);
    expect(MEMORY_CHANGED_SINCE_TEXT).toContain("this memory has changed since; use /memories");
    expect(store.getEpisodicFact(one)?.status).toBe("superseded");
  });

  it("the reply states only what was actually restored", () => {
    const change = { change_id: "mc_x", kind: "fact" as const, action: "correct" as const, old_ids: [1, 2], new_id: 9, run_id: null, chat_id: CHAT, created_at: "", undone_at: null };
    expect(undoneText(change, [1], 9)).toBe("↩️ Undone: #1 is active again; #9 is retired. #2 had changed since and was left as is.");
    expect(undoneText({ ...change, action: "retire", new_id: null }, [], null)).toBe(MEMORY_CHANGED_SINCE_TEXT);
  });

  it("an unknown change, or another chat's, gets a code-owned refusal reply and is a handled denial", () => {
    const { change } = retired("999");
    const r = new Gateway(store).intake(tapEvent(13, `memory:undo:${change.change_id}`));
    if (r.ok) throw new Error("expected a refusal");
    expect(r.error.code).toBe("MEMORY_CHANGE_NOT_FOUND");
    expect(isHandledIntakeDenial(r.error.code)).toBe(true);
    expect(texts()).toEqual(["That memory change does not exist here, so nothing was undone."]);
    expect(store.getMemoryChange(change.change_id)?.undone_at).toBeNull();
  });
});

describe("a tap end to end through the poll runner", () => {
  it("undoes, answers the spinner after the decision, and a redelivered tap is deduped", async () => {
    const { id, change } = retired();
    const r = mkdtempSync(join(tmpdir(), "houge-memundo-")); dirs.push(r);
    useFakeOmp({ "*": { rpcText: "x" } }, r);
    const sent: string[] = [];
    const statusAtAnswer: Array<string | undefined> = [];
    const telegramClient = {
      getUpdates: async () => [tap(70, `memory:undo:${change.change_id}`)],
      sendMessage: async ({ text }: { text: string }) => { sent.push(text); return { message_id: sent.length }; },
      answerCallbackQuery: async () => { statusAtAnswer.push(store.getEpisodicFact(id)?.status); }
    };
    const omp = { dataDir: r, distDir: tmpOmpDist(r) };
    await runTelegramPollOnce({ store, projectRoot: r, omp, allowlist: ALLOWLIST, telegramClient });
    expect(statusAtAnswer).toEqual(["active"]);
    expect(sent.some((t) => t.includes(`Undone: #${id}`))).toBe(true);
    store.setOffset("telegram", 0);
    await runTelegramPollOnce({ store, projectRoot: r, omp, allowlist: ALLOWLIST, telegramClient });
    expect(sent.filter((t) => t.includes("Undone")).length).toBe(1);
  });
});
