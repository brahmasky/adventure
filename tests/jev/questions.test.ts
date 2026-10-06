import { describe, expect, it } from "vitest";
import { criteriaHash, optionsOf, toJevQuestion, type Question } from "../../src/jev/questions/types.js";
import { TRIAGE_COMPLETE, TRIAGE_LANE, TRIAGE_QUESTIONS, TRIAGE_SCOPE, buildTriageState, lastHougeTurnOf } from "../../src/jev/questions/triage.js";
import { MAX_LATEST_MESSAGE_CHARS } from "../../src/jev/intent-question.js";

const q = (criteria: ReadonlyArray<readonly [string, string]>): Question => ({ id: "t", type: "choice", instructions: "pick", criteria });
const turn = (role: "user" | "assistant", text: string, created_at = "2026-10-04T00:00:00.000Z", intent: string | null = null) =>
  ({ turn_id: "t", chat_id: "c", run_id: "r", role, text, intent, created_at });

describe("criteriaHash (spec §3.1: option ORDER is a calibration variable; the model is a separate key)", () => {
  it("changes when options are reordered or a word changes; does not depend on the model", () => {
    const a = criteriaHash(q([["none", "n"], ["memory", "m"]]));
    expect(a).not.toBe(criteriaHash(q([["memory", "m"], ["none", "n"]])));
    expect(a).not.toBe(criteriaHash({ ...q([["none", "n"], ["memory", "m"]]), instructions: "pick one" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("renders the criteria object in listed order and freezes the triage order", () => {
    expect(Object.keys(toJevQuestion(q([["none", "n"], ["status", "s"], ["memory", "m"]])).criteria)).toEqual(["none", "status", "memory"]);
    expect(optionsOf(TRIAGE_LANE)).toEqual(["none", "status", "memory"]);
    expect(optionsOf(TRIAGE_COMPLETE)).toEqual(["mixed", "pure"]);
    expect(optionsOf(TRIAGE_SCOPE)).toEqual(["ask", "research"]);
    expect(TRIAGE_QUESTIONS.map((x) => x.id)).toEqual(["lane", "complete", "scope"]);
  });
});

describe("lastHougeTurnOf (one rule for live and replay)", () => {
  it("finds the last assistant turn, maps clarify intent, computes age in seconds; null when none", () => {
    const now = Date.parse("2026-10-04T00:01:00.000Z");
    expect(lastHougeTurnOf([turn("assistant", "q?", "2026-10-04T00:00:30.000Z", "clarify"), turn("user", "x")], now)).toEqual({ kind: "clarify", age_s: 30 });
    expect(lastHougeTurnOf([turn("assistant", "a", "2026-10-04T00:00:00.000Z", "loop")], now)).toEqual({ kind: "answer", age_s: 60 });
    expect(lastHougeTurnOf([turn("user", "x")], now)).toBeNull();
  });
});

describe("buildTriageState (2026-09-25 egress envelope + metadata; sanitised; skip never truncate)", () => {
  const base = { userText: "以后回复短一点", recentTurns: [turn("assistant", "long answer with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")], turnChars: 300, modality: "text" as const, lastHougeTurn: { kind: "answer" as const, age_s: 12 } };
  it("carries message, thread as user/houge, last_houge_turn and modality, all sanitised", () => {
    const r = buildTriageState(base);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.state).toEqual({ modality: "text", latest_message: "以后回复短一点", recent_turns: [{ role: "houge", text: "long answer with <token>" }], last_houge_turn: { kind: "answer", age_s: 12 } });
    expect(Object.keys(r.state).sort()).toEqual(["last_houge_turn", "latest_message", "modality", "recent_turns"]);
  });
  it("sanitises latest_message itself and applies the broker redactor passed in", () => {
    const r = buildTriageState({ ...base, userText: "记住 token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 与 VALUE123" }, (t) => t.replace("VALUE123", "<redacted>"));
    expect(r.ok && r.state.latest_message).toBe("记住 token <token> 与 <redacted>");
  });
  it("age_s is 0 when created_at is unparseable", () => {
    expect(lastHougeTurnOf([turn("assistant", "a", "not-a-date")], 1000)).toEqual({ kind: "answer", age_s: 0 });
  });
  it("skips when the message or the request exceeds the caps", () => {
    expect(buildTriageState({ ...base, userText: "x".repeat(MAX_LATEST_MESSAGE_CHARS + 1) })).toEqual({ ok: false, skip: "state_too_large" });
    expect(buildTriageState({ ...base, recentTurns: Array.from({ length: 200 }, () => turn("user", "y".repeat(300))) })).toEqual({ ok: false, skip: "state_too_large" });
  });
});
