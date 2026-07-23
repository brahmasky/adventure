import { describe, expect, it } from "vitest";
import { createTelegramLongPollingAdapter } from "../../src/triggers/telegram-trigger-adapter.js";
import type { TelegramAllowlist } from "../../src/domain/types.js";

const allowlist: TelegramAllowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};

function update(update_id: number) {
  return {
    update_id,
    message: {
      message_id: 10,
      text: "/ask summarize rules",
      from: { id: 111 },
      chat: { id: 222 }
    }
  };
}

describe("createTelegramLongPollingAdapter", () => {
  it("requests allowed_updates including callback_query (Phase 3.3)", async () => {
    const requests: { allowed_updates?: string[] }[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: {
        getUpdates: async (input) => {
          requests.push(input);
          return [];
        }
      },
      offsetStore: { getOffset: () => 0, setOffset: () => undefined }
    });

    await adapter.pollOnce(async () => undefined);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.allowed_updates).toContain("message");
    expect(requests[0]?.allowed_updates).toContain("callback_query");
  });

  it("routes an allowlisted callback_query as a selfwrite_action event", async () => {
    const events: { type?: string }[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: {
        getUpdates: async () => [
          {
            update_id: 70,
            callback_query: {
              id: "cbq_9",
              from: { id: 111 },
              message: { message_id: 5, chat: { id: 222 } },
              data: "selfwrite:discard:run_z"
            }
          }
        ]
      },
      offsetStore: { getOffset: () => 0, setOffset: () => undefined }
    });

    await adapter.pollOnce(async (event) => {
      events.push(event as { type?: string });
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "selfwrite_action", action: "discard", runId: "run_z" });
  });

  it("AUTH FLOOR: a non-allowlisted `from` tapping [Merge] never emits an action (no merge, no handler)", async () => {
    // Mandate 1 — the callback auth floor at the POLL-LOOP level: a non-allowlisted user's
    // [Merge] tap must be skipped (recorded as an auth denial), the offset must still advance,
    // and `emit` (the seam that calls handleSelfWriteAction) must NEVER run for it.
    const offsets: number[] = [];
    const skipped: { update_id: number; reason_code: string }[] = [];
    const emitted: unknown[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: {
        getUpdates: async () => [
          {
            update_id: 80,
            callback_query: {
              id: "cbq_evil",
              from: { id: 999 }, // NOT on the allowlist
              message: { message_id: 7, chat: { id: 222 } },
              data: "selfwrite:merge:run_pwn"
            }
          }
        ]
      },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      },
      skippedUpdateStore: {
        recordSkippedTelegramUpdate: (input) => skipped.push(input)
      }
    });

    const result = await adapter.pollOnce(async (event) => {
      emitted.push(event); // must NOT run for the denied tap
    });

    expect(emitted).toEqual([]); // handler seam never reached → no merge
    expect(result).toEqual({ processed_updates: 0, skipped_updates: 1 });
    expect(skipped).toEqual([
      expect.objectContaining({ update_id: 80, reason_code: "TELEGRAM_AUTH_DENIED" })
    ]);
    expect(offsets).toEqual([81]); // offset still advances past the rejected tap
  });

  it("persists offset only after emit succeeds", async () => {
    const offsets: number[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [update(41)] },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      }
    });

    await expect(adapter.pollOnce(async () => undefined)).resolves.toEqual({ processed_updates: 1, skipped_updates: 0 });

    expect(offsets).toEqual([42]);
  });

  it("does not persist offset when emit throws so Telegram can retry the update", async () => {
    const offsets: number[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [update(41)] },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      }
    });

    await expect(adapter.pollOnce(async () => {
      throw new Error("gateway intake failed");
    })).rejects.toThrow("gateway intake failed");

    expect(offsets).toEqual([]);
  });

  it("advances offset for deterministic auth denial", async () => {
    const offsets: number[] = [];
    const skipped: unknown[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [
        { update_id: 50, message: { message_id: 1, text: "/ask blocked", from: { id: 999 }, chat: { id: 222 } } },
        { update_id: 51, message: { message_id: 2, text: "just chatting", from: { id: 888 }, chat: { id: 222 } } }
      ] },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      },
      skippedUpdateStore: {
        recordSkippedTelegramUpdate: (input) => skipped.push(input)
      }
    });

    await expect(adapter.pollOnce(async () => {
      throw new Error("emit must not run for skipped updates");
    })).resolves.toEqual({ processed_updates: 0, skipped_updates: 2 });

    expect(offsets).toEqual([51, 52]);
    expect(skipped).toHaveLength(2);
  });

  it("acknowledges a truly text-less update via the sink, advances offset exactly once, never emits", async () => {
    const offsets: number[] = [];
    const skipped: { update_id: number; reason_code: string }[] = [];
    const acks: { chat_id: string; text: string; idempotency_key: string }[] = [];
    const emitted: unknown[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: {
        getUpdates: async () => [
          {
            update_id: 90,
            message: {
              message_id: 3,
              photo: [{ file_id: "f", file_unique_id: "u", width: 90, height: 90 }],
              from: { id: 111 },
              chat: { id: 222 }
            }
          }
        ]
      },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      },
      skippedUpdateStore: {
        recordSkippedTelegramUpdate: (input) => skipped.push(input)
      },
      acknowledgeSink: (ack) => acks.push(ack)
    });

    const result = await adapter.pollOnce(async (event) => {
      emitted.push(event); // must NOT run — this is a skip
    });

    expect(emitted).toEqual([]);
    expect(result).toEqual({ processed_updates: 0, skipped_updates: 1 });
    expect(offsets).toEqual([91]); // advanced exactly once
    expect(skipped).toEqual([
      expect.objectContaining({ update_id: 90, reason_code: "TELEGRAM_UNSUPPORTED_MEDIA" })
    ]);
    expect(acks).toHaveLength(1);
    expect(acks[0]?.chat_id).toBe("222");
    expect(acks[0]?.text).toContain("非文字消息");
    expect(acks[0]?.idempotency_key).toBe("telegram:90:unsupported_media");
  });

  it("a throwing acknowledgeSink never breaks the poll loop (offset still advances)", async () => {
    const offsets: number[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: {
        getUpdates: async () => [
          {
            update_id: 92,
            message: {
              message_id: 4,
              photo: [{ file_id: "f", file_unique_id: "u", width: 90, height: 90 }],
              from: { id: 111 },
              chat: { id: 222 }
            }
          }
        ]
      },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      },
      acknowledgeSink: () => {
        throw new Error("outbox exploded");
      }
    });

    await expect(adapter.pollOnce(async () => undefined)).resolves.toEqual({
      processed_updates: 0,
      skipped_updates: 1
    });
    expect(offsets).toEqual([93]);
  });

  it("stops a multi-update batch without advancing past a transient intake failure", async () => {
    const offsets: number[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [update(60), update(61)] },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      }
    });

    await expect(adapter.pollOnce(async (event) => {
      if (event.source_reference.includes("update:61")) throw new Error("gateway intake failed");
    })).rejects.toThrow("gateway intake failed");

    expect(offsets).toEqual([61]);
  });
});
