import { describe, expect, it } from "vitest";
import {
  buildIntentQuestion,
  buildIntentSystemPrompt,
  chatContextSince,
  countTrailingClarifyTurns,
  feedTurnText,
  INTENT_DISCIPLINE,
  parseIntent,
  resolveChatContextTurnChars,
  resolveChatContextTurns,
  resolveChatContextWindowMinutes,
  resolveMaxConsecutiveClarify
} from "../../src/capabilities/intent.js";
import type { ChatTurnRow } from "../../src/run/run-store.js";

function turn(role: "user" | "assistant", text: string, intent?: string): ChatTurnRow {
  return {
    turn_id: `t_${text}`,
    chat_id: "222",
    run_id: "run_1",
    role,
    text,
    intent: role === "assistant" ? intent ?? "answer" : null,
    created_at: "2026-06-19T00:00:00.000Z"
  };
}

describe("parseIntent", () => {
  it("classifies answer / research / feedback / clarify from strict JSON", () => {
    expect(parseIntent('{"intent":"answer"}')).toEqual({ intent: "answer" });
    expect(parseIntent('{"intent":"research","query":"latest SpaceX launch"}')).toEqual({
      intent: "research",
      query: "latest SpaceX launch"
    });
    expect(parseIntent('{"intent":"feedback"}')).toEqual({ intent: "feedback" });
    expect(parseIntent('{"intent":"clarify","clarifying_question":"Which project?"}')).toEqual({
      intent: "clarify",
      clarifying_question: "Which project?"
    });
  });

  it("extracts the first JSON object embedded in surrounding prose or code fences", () => {
    expect(
      parseIntent('Sure! Here is my verdict:\n```json\n{"intent":"research","query":"q"}\n```')
    ).toEqual({ intent: "research", query: "q" });
  });

  it("defaults to answer on junk, missing JSON, or unknown intent (tolerant)", () => {
    expect(parseIntent("no json here at all")).toEqual({ intent: "answer" });
    expect(parseIntent("{not valid json}")).toEqual({ intent: "answer" });
    expect(parseIntent('{"intent":"nonsense"}')).toEqual({ intent: "answer" });
    expect(parseIntent("")).toEqual({ intent: "answer" });
    expect(parseIntent('{"foo":"bar"}')).toEqual({ intent: "answer" });
  });

  it("ignores blank query / clarifying_question fields", () => {
    expect(parseIntent('{"intent":"research","query":"   "}')).toEqual({ intent: "research" });
  });
});

describe("buildIntentQuestion", () => {
  it("puts the message and recent thread on the data channel", () => {
    const q = buildIntentQuestion("too long", [turn("user", "what's new with X"), turn("assistant", "A long answer")]);
    expect(q).toContain("too long");
    expect(q).toContain("User: what's new with X");
    expect(q).toContain("Houge: A long answer");
    expect(q).toContain("untrusted data");
  });

  it("handles an empty thread", () => {
    const q = buildIntentQuestion("hello", []);
    expect(q).toContain("(no prior conversation)");
    expect(q).toContain("hello");
  });

  it("truncates a long turn to the per-turn char cap when feeding", () => {
    const long = "x".repeat(1000);
    const q = buildIntentQuestion("now", [turn("assistant", long)], 50);
    expect(q).toContain("…");
    expect(q).not.toContain("x".repeat(60));
  });
});

describe("buildIntentSystemPrompt (temporal grounding)", () => {
  it("prepends the injected date so the generated research query knows the year", () => {
    const prompt = buildIntentSystemPrompt(new Date("2026-06-19T00:00:00.000Z"));
    expect(prompt).toContain("Today's date is 2026-06-19 (UTC).");
    expect(prompt).toContain(INTENT_DISCIPLINE);
    expect(prompt.startsWith("Today's date is 2026-06-19 (UTC).")).toBe(true);
  });
});

describe("clarify-loop cap (ADR 0010 fix)", () => {
  it("buildIntentQuestion adds a do-not-clarify-again nudge once a clarify preceded", () => {
    const withNudge = buildIntentQuestion("ok the blue one", [], 500, 1);
    expect(withNudge).toContain("do NOT clarify again");
    const noNudge = buildIntentQuestion("ok the blue one", [], 500, 0);
    expect(noNudge).not.toContain("do NOT clarify again");
  });

  it("countTrailingClarifyTurns counts trailing clarify assistant turns (ignores user replies)", () => {
    expect(countTrailingClarifyTurns([])).toBe(0);
    expect(countTrailingClarifyTurns([turn("assistant", "a", "answer")])).toBe(0);
    expect(
      countTrailingClarifyTurns([
        turn("assistant", "q1", "clarify"),
        turn("user", "reply")
      ])
    ).toBe(1);
    // A non-clarify assistant turn breaks the streak.
    expect(
      countTrailingClarifyTurns([
        turn("assistant", "q1", "clarify"),
        turn("assistant", "ans", "answer"),
        turn("assistant", "q2", "clarify")
      ])
    ).toBe(1);
  });

  it("resolveMaxConsecutiveClarify defaults to 1, honors env, ignores junk", () => {
    expect(resolveMaxConsecutiveClarify({})).toBe(1);
    expect(resolveMaxConsecutiveClarify({ HOUGE_MAX_CONSECUTIVE_CLARIFY: "3" })).toBe(3);
    expect(resolveMaxConsecutiveClarify({ HOUGE_MAX_CONSECUTIVE_CLARIFY: "0" })).toBe(0);
    expect(resolveMaxConsecutiveClarify({ HOUGE_MAX_CONSECUTIVE_CLARIFY: "nope" })).toBe(1);
  });
});

describe("chat-context caps (env-configurable, code defaults)", () => {
  it("resolves defaults when env is unset", () => {
    expect(resolveChatContextWindowMinutes({})).toBe(60);
    expect(resolveChatContextTurns({})).toBe(8);
    expect(resolveChatContextTurnChars({})).toBe(500);
  });

  it("honors env overrides and ignores invalid values", () => {
    expect(resolveChatContextWindowMinutes({ HOUGE_CHAT_CONTEXT_WINDOW_MINUTES: "30" })).toBe(30);
    expect(resolveChatContextTurns({ HOUGE_CHAT_CONTEXT_TURNS: "4" })).toBe(4);
    expect(resolveChatContextTurnChars({ HOUGE_CHAT_CONTEXT_TURN_CHARS: "0" })).toBe(500);
    expect(resolveChatContextTurns({ HOUGE_CHAT_CONTEXT_TURNS: "nope" })).toBe(8);
  });

  it("computes the session-window cutoff from now minus the window", () => {
    const now = new Date("2026-06-19T12:00:00.000Z");
    expect(chatContextSince({ HOUGE_CHAT_CONTEXT_WINDOW_MINUTES: "60" }, now)).toBe(
      "2026-06-19T11:00:00.000Z"
    );
  });

  it("feedTurnText truncates above the cap, leaves short text intact", () => {
    expect(feedTurnText("short", 100)).toBe("short");
    expect(feedTurnText("abcdef", 3)).toBe("abc…");
  });
});
