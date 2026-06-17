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

  it("advances offset for deterministic auth denial and unsupported commands", async () => {
    const offsets: number[] = [];
    const skipped: unknown[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [
        { update_id: 50, message: { message_id: 1, text: "/ask blocked", from: { id: 999 }, chat: { id: 222 } } },
        { update_id: 51, message: { message_id: 2, text: "/teach remember", from: { id: 111 }, chat: { id: 222 } } }
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
