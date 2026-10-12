import { describe, expect, it } from "vitest";
import { parseDecisionReviewCallback } from "../../src/triggers/telegram-command-parser.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

// Spec §8.1: a digest tap is a label Paco gives; only exact shapes parse, and the tapping user passes the same allowlist as a
// message sender before anything is read, so a stranger's tap never writes a label.
const ID = "dec_0f8fad5b-d9cb-469f-a165-70867728950e";
const allowlist = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
const tap = (from: number, data: string) => normalizeTelegramUpdate({ update_id: 3000, callback_query: { id: "cbq_9", from: { id: from }, message: { message_id: 5, chat: { id: 222 } }, data } }, allowlist);

describe("parseDecisionReviewCallback", () => {
  it("parses ok and bad, and refuses every other shape", () => {
    expect(parseDecisionReviewCallback(`dec:rv:${ID}:ok`)).toEqual({ decision_id: ID, label: "ok" });
    expect(parseDecisionReviewCallback(`dec:rv:${ID}:bad`)).toEqual({ decision_id: ID, label: "bad" });
    for (const bad of [`dec:rv:${ID}:unsure`, `dec:rv:${ID}`, `dec:rv:dec_x:ok`, `dec:rv:${ID}:ok:x`, `xdec:rv:${ID}:ok`, 42, null]) {
      expect(parseDecisionReviewCallback(bad)).toBeNull();
    }
  });
});

describe("the review tap through the adapter", () => {
  it("an allowlisted tap becomes a decision_review event carrying the id and label", () => {
    const r = tap(111, `dec:rv:${ID}:bad`);
    expect(r).toMatchObject({ ok: true, event: { type: "decision_review", requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:3000:callback:cbq_9", metadata: { decision_id: ID, label: "bad", telegram_callback_id: "cbq_9" } } });
  });
  it("a tap from a user outside the allowlist is refused before parsing", () => {
    expect(tap(999, `dec:rv:${ID}:bad`)).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });
});
