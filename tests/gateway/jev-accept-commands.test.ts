import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { handleJevAcceptTap, JEV_ACCEPTED_TEXT } from "../../src/gateway/jev-accept-commands.js";
import { TAP_HANDLED_TEXT } from "../../src/gateway/improvement-commands.js";
import { RunStore } from "../../src/run/run-store.js";
import { parseJevAcceptCallback } from "../../src/triggers/telegram-command-parser.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Jev version check spec §2.6: the Accept button on a drift / insufficient card arms everything on that model. It is Paco's
// hand, so it acts only from the chat the card went to, only once, and only on a model still drifted or insufficient; a
// redelivered tap replays its stored answer and a second tap changes nothing.
const NOW = "2026-10-22T04:00:00.000Z";
const MODEL = "jev-new";
const CHAT = "222";
const sha8 = (m: string) => createHash("sha256").update(m).digest("hex").slice(0, 8);
let cb = 0;
const tap = (hash: string, chat = CHAT, callback = `cb${++cb}`, generation = 0) => buildTypedTaskEvent({ source: "telegram", type: "jev_accept_tap", requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id: chat }, idempotency_key: `telegram:1:callback:${callback}`, source_reference: `telegram:update:1:callback:${callback}`,
  metadata: { telegram_update_id: 1, telegram_callback_id: callback, model_hash: hash, generation } });
const replies = (s: RunStore) => [...drainOutbox(s).values()].map((p) => String(p.text));

function drifted(s: RunStore, state: "drifted" | "insufficient" = "drifted", chat = CHAT): void {
  s.noteJevModel(MODEL, NOW);
  s.setJevModelState(MODEL, "checking", state, JSON.stringify({ failed_questions: ["category"], route_failed: true, lanes_disarmed: [], card_chat: chat }), NOW);
  s.openIncident({ kind: state === "drifted" ? "jev_model_drifted" : "jev_model_insufficient", subject: `jev:model:${MODEL}`, detail: {}, now: NOW });
}

describe("parseJevAcceptCallback", () => {
  it("parses dec:jv:<8 hex>:acc and refuses every other shape", () => {
    expect(parseJevAcceptCallback(`dec:jv:${sha8(MODEL)}:7:acc`)).toEqual({ model_hash: sha8(MODEL), generation: 7 });
    expect(`dec:jv:${sha8(MODEL)}:999999999:acc`.length).toBeLessThanOrEqual(64);
    for (const bad of ["dec:jv:abc:1:acc", `dec:jv:${sha8(MODEL)}:acc`, `dec:jv:${sha8(MODEL)}:1:dis`, `dec:jv:${sha8(MODEL)}:x:acc`, `dec:jv:${sha8(MODEL).toUpperCase()}:1:acc`, `dec:jv:${sha8(MODEL)}:1:acc:x`, `xdec:jv:${sha8(MODEL)}:1:acc`, 42, null]) {
      expect(parseJevAcceptCallback(bad)).toBeNull();
    }
  });
  it("the adapter turns an allowlisted tap into a jev_accept_tap event and refuses a stranger", () => {
    const allowlist = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
    const u = (from: number) => normalizeTelegramUpdate({ update_id: 3000, callback_query: { id: "cbq_9", from: { id: from }, message: { message_id: 5, chat: { id: 222 } }, data: `dec:jv:${sha8(MODEL)}:3:acc` } }, allowlist);
    expect(u(111)).toMatchObject({ ok: true, event: { type: "jev_accept_tap", notify: { chat_id: "222" }, metadata: { telegram_callback_id: "cbq_9", model_hash: sha8(MODEL), generation: 3 } } });
    expect(u(999)).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });
});

describe("handleJevAcceptTap", () => {
  it("from the card's chat: drifted → accepted, the model's incident resolves, one reply", () => {
    const s = RunStore.openInMemory(); drifted(s);
    expect(handleJevAcceptTap(s, tap(sha8(MODEL)), NOW)).toMatchObject({ ok: true, status: "jev_accept_tapped" });
    expect(s.getJevModel(MODEL)?.state).toBe("accepted");
    expect(s.listOpenIncidents()).toEqual([]);
    expect(replies(s)).toEqual([JEV_ACCEPTED_TEXT(MODEL)]);
  });

  it("insufficient → accepted too", () => {
    const s = RunStore.openInMemory(); drifted(s, "insufficient");
    handleJevAcceptTap(s, tap(sha8(MODEL)), NOW);
    expect(s.getJevModel(MODEL)?.state).toBe("accepted");
  });

  it("from another chat: nothing changes, the answer is Already handled", () => {
    const s = RunStore.openInMemory(); drifted(s);
    handleJevAcceptTap(s, tap(sha8(MODEL), "999"), NOW);
    expect(s.getJevModel(MODEL)?.state).toBe("drifted");
    expect(replies(s)).toEqual([TAP_HANDLED_TEXT]);
  });

  it("a redelivered callback replays (one reply); a second tap on an accepted model changes nothing", () => {
    const s = RunStore.openInMemory(); drifted(s);
    const e = tap(sha8(MODEL));
    handleJevAcceptTap(s, e, NOW);
    handleJevAcceptTap(s, e, NOW);
    expect(replies(s)).toEqual([JEV_ACCEPTED_TEXT(MODEL)]);
    expect(s.setJevModelState(MODEL, "accepted", "trusted", "{}", NOW)).toBe(true); // a later check moved it on
    handleJevAcceptTap(s, tap(sha8(MODEL)), NOW);
    expect(s.getJevModel(MODEL)?.state).toBe("trusted"); // the fence: only drifted | insufficient → accepted
    expect(replies(s)).toEqual([TAP_HANDLED_TEXT]);
  });

  it("an old card (an earlier generation) cannot accept a newer drift Paco has not seen", () => {
    const s = RunStore.openInMemory(); drifted(s);
    s.bumpJevModelGeneration(MODEL);
    handleJevAcceptTap(s, tap(sha8(MODEL), CHAT, undefined, 0), NOW);
    expect(s.getJevModel(MODEL)?.state).toBe("drifted");
    handleJevAcceptTap(s, tap(sha8(MODEL), CHAT, undefined, 1), NOW);
    expect(s.getJevModel(MODEL)?.state).toBe("accepted");
  });

  it("an unknown hash is handled, nothing written", () => {
    const s = RunStore.openInMemory(); drifted(s);
    handleJevAcceptTap(s, tap("00000000"), NOW);
    expect(s.getJevModel(MODEL)?.state).toBe("drifted");
  });

  it("the gateway dispatches the tap and never rate-limits it", () => {
    const s = RunStore.openInMemory(); drifted(s);
    const g = new Gateway(s, undefined, process.cwd());
    for (let k = 0; k < 8; k += 1) expect(g.intake(tap(sha8(MODEL)), NOW)).toMatchObject({ ok: true, status: "jev_accept_tapped" });
    expect(s.getJevModel(MODEL)?.state).toBe("accepted");
  });
});
