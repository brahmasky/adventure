import { describe, expect, it } from "vitest";
import { buildIntentQuestion } from "../../src/capabilities/intent.js";
import { buildJevIntentRequest, JEV_INTENT_QUESTION, JEV_INTENTS, langOf, MAX_LATEST_MESSAGE_CHARS } from "../../src/jev/intent-question.js";
import type { ChatTurnRow } from "../../src/run/run-store.js";

const turn = (role: "user" | "assistant", text: string, i: number): ChatTurnRow => ({
  turn_id: `t${i}`, chat_id: "c", run_id: `r${i}`, role, text, intent: role === "assistant" ? "answer" : null, created_at: `2026-09-01T00:00:0${i}.000Z`, quoted_turn_id: null
});

describe("buildJevIntentRequest", () => {
  const thread = [turn("user", "x".repeat(900), 1), turn("assistant", "short reply", 2)];

  it("feeds Jev the SAME thread the LLM classifier sees — else disagreement measures input drift", () => {
    const r = buildJevIntentRequest("and now?", thread, 500, 0);
    if (!r.ok) throw new Error("expected ok");
    const state = r.request.state as { recent_turns: { role: string; text: string }[] };
    const llmQuestion = buildIntentQuestion("and now?", thread, 500, 0);
    for (const t of state.recent_turns) {
      expect(llmQuestion).toContain(`${t.role === "user" ? "User" : "Houge"}: ${t.text}`);
    }
    expect(state.recent_turns[0]!.text).toHaveLength(501); // 500 + "…" — same cap as feedTurnText
  });

  it("offers exactly the six intents — a missing option reads as disagreement on every turn", () => {
    expect(Object.keys(JEV_INTENT_QUESTION.criteria)).toEqual([...JEV_INTENTS]);
    expect([...JEV_INTENTS]).toEqual(["answer", "research", "feedback", "clarify", "selfcode", "skill"]);
  });

  it("carries modality and the clarify flag (multimodal-ready; soft clarify nudge parity)", () => {
    const r = buildJevIntentRequest("the second one", thread, 500, 1);
    if (!r.ok) throw new Error("expected ok");
    expect(r.request.state).toMatchObject({ modality: "text", latest_message: "the second one", already_asked_clarification: true });
  });

  it("carries the resolved modality when given one (voice/photo turns, spec 2026-09-29)", () => {
    const voice = buildJevIntentRequest("what's the ASX close?", [], 500, 0, "voice");
    expect(voice.ok && (voice.request.state as { modality: string }).modality).toBe("voice");
    const photo = buildJevIntentRequest("what is this chart?", [], 500, 0, "photo");
    expect(photo.ok && (photo.request.state as { modality: string }).modality).toBe("photo");
  });

  it("skips an over-cap message instead of truncating it (a truncated message yields a silently worse label)", () => {
    expect(buildJevIntentRequest("y".repeat(MAX_LATEST_MESSAGE_CHARS + 1), [], 500, 0)).toEqual({ ok: false, skip: "state_too_large" });
  });

  it("skips when the WHOLE request exceeds 24k chars — env-raised thread caps must not widen egress", () => {
    const fat = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? "assistant" : "user", "z".repeat(1000), i));
    expect(buildJevIntentRequest("hi", fat, 1000, 0)).toEqual({ ok: false, skip: "state_too_large" });
  });
});

describe("langOf", () => {
  it.each([
    ["帮我研究一下澳洲的利率走势", "zh"],
    ["what's the latest on the RBA?", "en"],
    ["帮我看看 your intent classifier 为什么 always picks research", "mixed"],
    ["", "en"]
  ])("%s → %s", (text, lang) => {
    expect(langOf(text)).toBe(lang);
  });
});
