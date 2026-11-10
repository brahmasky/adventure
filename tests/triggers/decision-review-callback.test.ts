import { describe, expect, it } from "vitest";
import { parseDecisionReviewCallback, parseImprovementCallback } from "../../src/triggers/telegram-command-parser.js";
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
  it("an allowlisted Revoke tap becomes an improvement_tap event carrying the standing id", () => {
    const sa = "sa_0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(tap(111, `dec:sa:${sa}:revoke`)).toMatchObject({ ok: true, event: { type: "improvement_tap", notify: { kind: "telegram", chat_id: "222" }, metadata: { kind: "sa", id: sa, action: "revoke", telegram_callback_id: "cbq_9" } } });
    expect(tap(999, `dec:sa:${sa}:revoke`)).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });
});

// 2b-ii §6.3: the callback families, ids pr_/lm_/sa_ + uuid, closed action words; anything else is null (never a command).
// The skill-job family (`dec:sk:`) is gone with the job (ADR 0035): a stale button in an old message parses to nothing.
describe("parseImprovementCallback", () => {
  const u = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  it("dec:pr:<id>:acc|dis|rev, dec:lm:<move>:revoke", () => {
    expect(parseImprovementCallback(`dec:pr:pr_${u}:acc`)).toEqual({ kind: "pr", id: `pr_${u}`, action: "acc" });
    expect(parseImprovementCallback(`dec:lm:lm_${u}:revoke`)).toEqual({ kind: "lm", id: `lm_${u}`, action: "revoke" });
    for (const bad of [`dec:pr:pr_${u}:accept`, `dec:sk:pr_${u}:accept`, `dec:lm:lm_${u}:acc`, "dec:pr:x:acc", `dec:pr:pr_${u}:acc:x`, `dec:pr:pr_${u.toUpperCase()}:acc`, "dec:pr::acc", "dec:sk::keep", 42, null]) expect(parseImprovementCallback(bad)).toBeNull();
  });
  it("a stale skill-job button (dec:sk:, every action the old cards carried) parses to null and the adapter skips it as unrecognised: no event, no throw", () => {
    for (const action of ["accept", "dismiss", "replace", "keep"]) {
      expect(parseImprovementCallback(`dec:sk:job_${u}:${action}`)).toBeNull();
      expect(tap(111, `dec:sk:job_${u}:${action}`)).toMatchObject({ ok: false, error: { code: "TELEGRAM_COMMAND_INVALID" } });
    }
  });
  it("the adapter turns an improvement tap into an improvement_tap event and refuses a stranger", () => {
    const r = tap(111, `dec:pr:pr_${u}:acc`);
    expect(r).toMatchObject({ ok: true, event: { type: "improvement_tap", notify: { chat_id: "222" }, metadata: { telegram_update_id: 3000, telegram_callback_id: "cbq_9", kind: "pr", id: `pr_${u}`, action: "acc" } } });
    expect(tap(999, `dec:pr:pr_${u}:acc`)).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });
  it("dec:sa:<sa_uuid>:revoke is the standing family; any other action, id shape or a move id under it is null", () => {
    expect(parseImprovementCallback(`dec:sa:sa_${u}:revoke`)).toEqual({ kind: "sa", id: `sa_${u}`, action: "revoke" });
    expect(Buffer.byteLength(`dec:sa:sa_${u}:revoke`)).toBeLessThanOrEqual(64);
    for (const bad of [`dec:sa:sa_${u}:ok`, `dec:sa:sa_${u}:no`, `dec:sa:lm_${u}:revoke`, `dec:sa:sa_${u}:revoke:x`, `dec:sa:sa_${u.toUpperCase()}:revoke`, "dec:sa::revoke"]) expect(parseImprovementCallback(bad)).toBeNull();
  });
});
