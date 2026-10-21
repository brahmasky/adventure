import { describe, expect, it } from "vitest";
import { skillButtons } from "../../src/core/skill-job.js";
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
});

// 2b-ii §6.3: three callback families, ids pr_/job_/lm_ + uuid, closed action words; anything else is null (never a command).
describe("parseImprovementCallback", () => {
  const u = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  it("dec:pr:<id>:acc|dis|rev, dec:sk:<job>:accept|dismiss|replace|keep, dec:lm:<move>:revoke", () => {
    expect(parseImprovementCallback(`dec:pr:pr_${u}:acc`)).toEqual({ kind: "pr", id: `pr_${u}`, action: "acc" });
    expect(parseImprovementCallback(`dec:sk:job_${u}:keep`)).toEqual({ kind: "sk", id: `job_${u}`, action: "keep" });
    expect(parseImprovementCallback(`dec:lm:lm_${u}:revoke`)).toEqual({ kind: "lm", id: `lm_${u}`, action: "revoke" });
    for (const bad of [`dec:pr:pr_${u}:accept`, `dec:sk:pr_${u}:accept`, `dec:lm:lm_${u}:acc`, "dec:pr:x:acc", 42, null]) expect(parseImprovementCallback(bad)).toBeNull();
    expect(Buffer.byteLength(`dec:sk:job_${u}:dismiss`)).toBeLessThanOrEqual(64);
  });
  it("every button skillButtons builds parses back (the literal prefix is pinned here)", () => {
    for (const kind of ["review", "collision"] as const) {
      for (const b of skillButtons(`job_${u}`, kind)) expect(parseImprovementCallback(b.data)).toMatchObject({ kind: "sk", id: `job_${u}` });
    }
  });
  it("the adapter turns an improvement tap into an improvement_tap event and refuses a stranger", () => {
    const r = tap(111, `dec:pr:pr_${u}:acc`);
    expect(r).toMatchObject({ ok: true, event: { type: "improvement_tap", notify: { chat_id: "222" }, metadata: { telegram_callback_id: "cbq_9", kind: "pr", id: `pr_${u}`, action: "acc" } } });
    expect(tap(999, `dec:pr:pr_${u}:acc`)).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });
});
