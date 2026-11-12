import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Priority queue P2 (2026-11-12): the 2026-12-12 review re-decides held builds against this number,
// so it must count what Paco did on Telegram and nothing else — not a denied command, not the
// schedule, not another allowed user, and not his own /status (reading the number must not raise it).
const NOW = "2026-11-13T10:00:00.000Z";
const daysAgo = (d: number): string => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
let n = 0;
const audit = (s: RunStore, command: string, at: string, o: { decision?: "accepted" | "denied"; actor?: string; ref?: string } = {}): void => {
  n += 1;
  s.recordTelegramCommandAudit({ actor_id: o.actor ?? "paco", chat_id: "222", command, source_reference: o.ref ?? `telegram:update:${n}`,
    decision: o.decision ?? "accepted", occurred_at: at });
};
const ev = (type: "status" | "turn", key: string, extra: Record<string, unknown> = {}) => buildTypedTaskEvent({ source: "telegram", type,
  requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "222" }, idempotency_key: `telegram:${key}`,
  source_reference: `telegram:update:${key}`, ...extra } as never);
const useLine = (s: RunStore, key: string): string => {
  new Gateway(s).intake(ev("status", key), NOW);
  const text = String([...drainOutbox(s).values()].at(-1)?.text);
  const lines = text.split("\n");
  return `${lines[lines.indexOf("👤 USE (4 weeks)") + 1]}`;
};

describe("/status use line (priority queue P2)", () => {
  it("counts accepted turns, commands and taps per rolling week, newest first, under its own heading", () => {
    const s = RunStore.openInMemory();
    audit(s, "turn", daysAgo(1)); audit(s, "approve", daysAgo(2)); audit(s, "mail_tap", daysAgo(6.9));
    audit(s, "turn", daysAgo(8)); audit(s, "models", daysAgo(13));
    audit(s, "turn", daysAgo(15));
    audit(s, "turn", daysAgo(27));
    audit(s, "turn", daysAgo(29)); // outside the four weeks
    audit(s, "turn", daysAgo(1), { decision: "denied" }); // rate-limited or fused: not use
    audit(s, "turn", daysAgo(1), { actor: "guest" }); // another allowed identity: not Paco's use
    expect(s.telegramUseByWeek("paco", NOW)).toEqual([3, 2, 1, 1]);
    expect(useLine(s, "u1")).toBe("A week, newest first: 3 · 2 · 1 · 1 — your turns, commands and taps");
    s.close();
  });

  it("a row exactly seven days old falls in the older week, and a row after now is not counted", () => {
    const s = RunStore.openInMemory();
    audit(s, "turn", daysAgo(7)); audit(s, "turn", daysAgo(-1));
    expect(s.telegramUseByWeek("paco", NOW)).toEqual([0, 1, 0, 0]);
    s.close();
  });

  it("a redelivered update counts once, in the week of its first row, even across a week boundary", () => {
    const s = RunStore.openInMemory();
    audit(s, "turn", daysAgo(7.01), { ref: "telegram:update:dup" });
    audit(s, "turn", daysAgo(6.99), { ref: "telegram:update:dup" });
    expect(s.telegramUseByWeek("paco", NOW)).toEqual([0, 1, 0, 0]);
    s.close();
  });

  it("a turn through gateway intake counts, and reading /status does not raise the number", () => {
    const s = RunStore.openInMemory();
    expect(new Gateway(s).intake(ev("turn", "t1", { program: "turn", goal: "hi" }), daysAgo(1)).ok).toBe(true);
    expect(useLine(s, "u2")).toContain(": 1 · 0 · 0 · 0 —");
    expect(useLine(s, "u3")).toContain(": 1 · 0 · 0 · 0 —");
    s.close();
  });

  it("a self-write button tap counts, and does not count toward the command rate limit", async () => {
    const s = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "houge-use-"));
    await runTelegramPollOnce({
      store: s, projectRoot: root,
      allowlist: { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }] },
      telegramClient: {
        getUpdates: async () => [{ update_id: 41, callback_query: { id: "cb1", from: { id: 111 }, data: "selfwrite:view:run_x",
          message: { message_id: 9, chat: { id: 222 } } } }],
        sendMessage: async () => ({ message_id: 1 }), answerCallbackQuery: async () => true
      }
    } as never).catch(() => undefined); // the view itself may fail on a non-git root; the tap was still Paco's
    expect(s.telegramUseByWeek("paco", new Date(Date.now() + 1000).toISOString())).toEqual([1, 0, 0, 0]);
    const limit = s.checkTelegramRateLimit({ actor_id: "paco", chat_id: "222", command: "turn", now: new Date().toISOString() });
    for (let i = 0; i < 6; i++) s.recordSelfWriteTap({ from: { id: "paco" }, chat_id: "222", source_reference: `sw${i}` }, new Date().toISOString());
    expect(limit.ok).toBe(true);
    expect(s.checkTelegramRateLimit({ actor_id: "paco", chat_id: "222", command: "turn", now: new Date().toISOString() }).ok).toBe(true);
    s.close();
  });
});
