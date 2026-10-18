import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway, HELP_TEXT } from "../../src/gateway/gateway.js";
import { handleMemoryUndo } from "../../src/gateway/memory-commands.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { isHandledIntakeDenial } from "../../src/telegram/telegram-poll-runner.js";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import { drainOutbox } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Paco's own memory commands (2026-10-02): /memories shows what Houge remembers about this chat, /forget-memory <id>
// retires one fact with the same Undo card the tool sends. His direct command: allowlist only, no turn or taint rules.
const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
const CHAT = "222";
let store: RunStore;
let n = 0;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

function command(text: string, from = 111): TypedTaskEvent {
  n += 1;
  const r = normalizeTelegramUpdate({ update_id: n, message: { message_id: n, text, from: { id: from }, chat: { id: 222 } } }, ALLOWLIST);
  if (!r.ok) throw new Error(`expected an event: ${r.error.code}`);
  return r.event as TypedTaskEvent;
}
const replies = () => [...drainOutbox(store).values()];
const fact = (text: string, o: { chat?: string; at?: string } = {}) =>
  store.addEpisodicFact({ chat_id: o.chat ?? CHAT, fact: text, created_at: o.at ?? "2026-09-30T00:00:00.000Z" });

describe("parsing", () => {
  it("/memories takes an optional query; /forget-memory exactly one positive id", () => {
    expect(parseTelegramCommand("/memories")).toEqual({ ok: true, command: { type: "memories" } });
    expect(parseTelegramCommand("/memories ASML brief")).toEqual({ ok: true, command: { type: "memories", query: "ASML brief" } });
    // L2: /forget_memory is the name (Telegram command names allow no hyphen); /forget-memory stays a typed alias.
    expect(parseTelegramCommand("/forget_memory 108")).toEqual({ ok: true, command: { type: "forget_memory", id: 108 } });
    expect(parseTelegramCommand("/forget-memory 108")).toEqual({ ok: true, command: { type: "forget_memory", id: 108 } });
    for (const bad of ["/forget_memory", "/forget_memory abc", "/forget-memory 1 2", "/forget-memory 0"]) {
      expect(parseTelegramCommand(bad).ok, bad).toBe(false);
    }
  });

  it("a malformed /forget-memory gets the code-owned invalid-command reply; a stranger's command never becomes an event", () => {
    const r = normalizeTelegramUpdate({ update_id: 900, message: { message_id: 1, text: "/forget-memory abc", from: { id: 111 }, chat: { id: 222 } } }, ALLOWLIST);
    if (r.ok) throw new Error("expected invalid");
    expect(r.acknowledgement?.text).toBe("That command was not accepted: /forget_memory requires exactly one fact id. Send /help for the list.");
    expect(normalizeTelegramUpdate({ update_id: 901, message: { message_id: 2, text: "/forget-memory 1", from: { id: 999 }, chat: { id: 222 } } }, ALLOWLIST).ok).toBe(false);
  });
});

describe("/memories", () => {
  it("lists this chat's ACTIVE facts matching the query: #id · text (<=120) · date, at most 10", () => {
    const hit = fact("Paco's daily brief needs ASML earnings");
    const gone = fact("ASML retired fact");
    store.retireMemoryRows({ kind: "fact", ids: [gone], chat_id: CHAT, run_id: null });
    fact("ASML other chat", { chat: "999" });
    expect(new Gateway(store).intake(command("/memories ASML"))).toMatchObject({ ok: true, status: "memories_returned" });
    const text = String(replies()[0]?.text);
    expect(text).toContain(`#${hit} · Paco's daily brief needs ASML earnings · 2026-09-30`);
    expect(text).not.toContain(`#${gone} `);
    expect(text).not.toContain("other chat");
    expect(text).toContain("/forget_memory <id>");
    for (let i = 0; i < 11; i++) fact(`ASML long ${i} ${"y".repeat(200)}`);
    new Gateway(store).intake(command("/memories ASML"));
    const lines = String(replies()[0]?.text).split("\n").filter((l) => l.startsWith("#"));
    expect(lines).toHaveLength(10);
    for (const l of lines) expect(l.split(" · ")[1]!.length).toBeLessThanOrEqual(120);
  });

  it("with no query lists the 10 most-applied active facts, most-applied first", () => {
    const ids = Array.from({ length: 12 }, (_, i) => fact(`fact ${i}`));
    for (const [i, id] of ids.entries()) for (let k = 0; k < i; k++) store.touchEpisodicApplied([id]);
    new Gateway(store).intake(command("/memories"));
    const lines = String(replies()[0]?.text).split("\n").filter((l) => l.startsWith("#"));
    expect(lines.map((l) => Number(l.slice(1, l.indexOf(" "))))).toEqual(ids.slice(2).reverse());
  });

  it("says so when nothing matches", () => {
    new Gateway(store).intake(command("/memories nothing-here"));
    expect(replies()[0]?.text).toBe("🧠 No active memories match.");
  });
});

describe("/forget-memory", () => {
  it("retires the fact and replies with the same Undo card the tool sends", () => {
    const id = fact("Paco's daily brief needs ASML earnings");
    expect(new Gateway(store).intake(command(`/forget_memory ${id}`))).toMatchObject({ ok: true, status: "memory_forgotten" });
    expect(store.getEpisodicFact(id)?.status).toBe("pruned");
    const card = replies()[0]!;
    expect(card.text).toBe(`🧠 Retired #${id}: "Paco's daily brief needs ASML earnings"`);
    const buttons = card.buttons as Array<{ data: string }>;
    expect(buttons[0]?.data).toMatch(/^memory:undo:mc_/);
    const change = store.getMemoryChange(buttons[0]!.data.slice("memory:undo:".length));
    expect(change).toMatchObject({ kind: "fact", action: "retire", old_ids: [id], run_id: null, chat_id: CHAT });
  });

  it("an unknown, already retired or other chat's id gets a code-owned refusal and is a handled denial", () => {
    const pruned = fact("gone");
    store.retireMemoryRows({ kind: "fact", ids: [pruned], chat_id: CHAT, run_id: null });
    const foreign = fact("not yours", { chat: "999" });
    for (const id of [424242, pruned, foreign]) {
      const r = new Gateway(store).intake(command(`/forget-memory ${id}`));
      if (r.ok) throw new Error(`expected a refusal for ${id}`);
      expect(r.error.code).toBe("MEMORY_NOT_FOUND");
      expect(isHandledIntakeDenial(r.error.code)).toBe(true);
      expect(replies().map((p) => p.text)).toEqual([`No active memory #${id} here. /memories lists them.`]);
    }
    expect(store.getEpisodicFact(foreign)?.status).toBe("active");
  });

  it("a redelivered command retires once and replies once", () => {
    const id = fact("once");
    const event = command(`/forget-memory ${id}`);
    new Gateway(store).intake(event);
    new Gateway(store).intake(event);
    expect(replies()).toHaveLength(1);
  });
});

describe("/help", () => {
  it("lists both commands", () => {
    expect(HELP_TEXT).toContain("/memories [query]");
    expect(HELP_TEXT).toContain("/forget_memory <id>");
    expect(HELP_TEXT).not.toContain("/forget-memory");
  });
});

// Spec §9: Undo on a saved fact is Paco's label that memory.kind (and the route) chose wrong — it must reach the
// calibration evidence like a lesson Undo does, or fact mistakes never show in the report.
const undoTap = (change_id: string, key: string) => buildTypedTaskEvent({ source: "telegram", type: "memory_undo", requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: key, source_reference: key, metadata: { telegram_update_id: 1, telegram_callback_id: key, change_id } });
const row = (run_id: string, entry_id: string, verdict: string): DecisionInsert => ({ entry_id, entry_version: 1, run_id, tool_call_id: null, stage: "pre_model",
  rung: "system_one", verdict, p: 0.95, reason_code: null, fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1 });

describe("fact Undo outcomes", () => {
  it("records lesson_undone on turn.handler (its lane) and on memory.kind, once; a retire Undo records nothing", () => {
    const run_id = createQueuedTurnRun(store, "记下来吧");
    const handler = store.insertDecision(row(run_id, "turn.handler", "memory"));
    const kind = store.insertDecision(row(run_id, "memory.kind", "fact"));
    const id = fact("Paco prefers the south side noodle shop");
    const change = store.inTransaction(() => store.insertFactAddChange({ new_id: id, superseded_id: null, pruned_ids: [], run_id, chat_id: CHAT, now: new Date().toISOString() }));
    handleMemoryUndo(store, undoTap(change.change_id, "u1"));
    handleMemoryUndo(store, undoTap(change.change_id, "u2")); // already undone: no second outcome
    expect(store.listDecisionOutcomes(handler).map((o) => [o.signal, o.value])).toEqual([["lesson_undone", "memory"]]);
    expect(store.listDecisionOutcomes(kind).map((o) => [o.signal, o.value])).toEqual([["lesson_undone", "memory"]]);
    const retire = store.retireMemoryRows({ kind: "fact", ids: [fact("an older fact")], chat_id: CHAT, run_id, now: new Date().toISOString() })!;
    handleMemoryUndo(store, undoTap(retire.change_id, "u3"));
    expect(store.listDecisionOutcomes(handler)).toHaveLength(1); // a memory_correct retire is not a memory.kind save
  });
  it("labels the memory.kind row that saved, not an earlier hand-off row of the same run (Rev 2 item 7)", () => {
    const run_id = createQueuedTurnRun(store, "那条不对，记成：我住在悉尼");
    const fixRow = store.insertDecision({ ...row(run_id, "memory.kind", "fix"), created_at: "2026-10-17T00:00:00.000Z" });
    const saveRow = store.insertDecision({ ...row(run_id, "memory.kind", "fact"), created_at: "2026-10-17T00:00:05.000Z" });
    const change = store.inTransaction(() => store.insertFactAddChange({ new_id: fact("Paco lives in Sydney"), superseded_id: null, pruned_ids: [], run_id, chat_id: CHAT, now: new Date().toISOString() }));
    handleMemoryUndo(store, undoTap(change.change_id, "u5"));
    expect(store.listDecisionOutcomes(fixRow)).toEqual([]);
    expect(store.listDecisionOutcomes(saveRow).map((o) => o.signal)).toEqual(["lesson_undone"]);
  });
  it("the planner's own save (no turn.handler row) labels memory.kind with `planner`", () => {
    const run_id = createQueuedTurnRun(store, "记下来吧");
    const kind = store.insertDecision(row(run_id, "memory.kind", "fact"));
    const change = store.inTransaction(() => store.insertFactAddChange({ new_id: fact("Paco is vegetarian"), superseded_id: null, pruned_ids: [], run_id, chat_id: CHAT, now: new Date().toISOString() }));
    handleMemoryUndo(store, undoTap(change.change_id, "u4"));
    expect(store.listDecisionOutcomes(kind).map((o) => [o.signal, o.value])).toEqual([["lesson_undone", "planner"]]);
  });
});
