import { describe, expect, it } from "vitest";
import { MAX_LATEST_MESSAGE_CHARS, MAX_REQUEST_CHARS } from "../../src/jev/intent-question.js";
import {
  buildTreeState, CATEGORIES, isProposal, lastHougeTurnOf, quotedTurnFromRow, TREE_ACTIONS, TREE_BREADTH, TREE_CATEGORY, TREE_QUESTIONS, TREE_REASONING,
  TREE_RULE_SCOPE, TREE_SETS_RULE, type QuotedTurn, type TreeStateInput
} from "../../src/jev/questions/tree.js";
import { optionsOf, toJevQuestion } from "../../src/jev/questions/types.js";
import { ACK_NUDGE_TEXT } from "../../src/omp/bare-ack.js";
import type { ChatTurnRow } from "../../src/run/run-store.js";

/** The one ChatTurnRow builder in this file: a column added to the row type is added here once. */
const turn = (role: "user" | "assistant", text: string, created_at = "2026-10-07T00:00:00.000Z", intent: string | null = null): ChatTurnRow =>
  ({ turn_id: "t", chat_id: "c", run_id: "r", role, text, intent, created_at, quoted_turn_id: null });
const NOW = Date.parse("2026-10-07T01:00:00.000Z");

// Spec §2.3: the six questions ride one request, and the policy (tree-policy.ts) reads them by id and option name. A
// renamed id or option silently routes every turn to the fallback; a reordered category list moves Jev's first-option
// bias onto a different option. Both are calibration events, so the frozen shape is asserted literally.
describe("the six tree questions (frozen)", () => {
  it("are the six ids in order, with their wire types", () => {
    expect(TREE_QUESTIONS.map((q) => [q.id, q.type])).toEqual([
      ["category", "choice"], ["sets_rule", "noul"], ["rule_scope", "choice"], ["breadth", "score"], ["reasoning", "score"], ["actions", "score"]
    ]);
    expect(TREE_QUESTIONS).toEqual([TREE_CATEGORY, TREE_SETS_RULE, TREE_RULE_SCOPE, TREE_BREADTH, TREE_REASONING, TREE_ACTIONS]);
  });
  it("category offers exactly the eleven categories: the fall-through `other` first, the no-planner lanes last", () => {
    expect(optionsOf(TREE_CATEGORY)).toEqual(["other", "self_change", "machine_task", "schedule", "mail_calendar", "wiki", "research",
      "lookup", "answer", "status", "memory"]);
    expect([...optionsOf(TREE_CATEGORY)].sort()).toEqual([...CATEGORIES].sort());
  });
  it("rule_scope is ask | research (the lesson scopes); score levels are the spec's, in order", () => {
    expect(optionsOf(TREE_RULE_SCOPE)).toEqual(["ask", "research"]);
    expect(TREE_BREADTH.levels).toEqual(["one known thing", "one topic", "several topics", "open-ended"]);
    expect(TREE_REASONING.levels).toEqual(["recall", "straightforward", "non-obvious analysis", "deep multi-factor"]);
    expect(TREE_ACTIONS.levels).toEqual(["none", "one or two reads", "several including changes", "many with checks"]);
  });
  // mu's wording rules (spec §2.3): every question names its state field in backticks; no "and/or"; every criterion says
  // something (an empty criterion is an option Jev cannot read).
  it("follow mu's wording rules", () => {
    for (const q of TREE_QUESTIONS) {
      expect(q.instructions).toContain("`latest_message`");
      expect(JSON.stringify(toJevQuestion(q))).not.toMatch(/and\/or/i);
    }
    for (const [, text] of TREE_CATEGORY.criteria) expect(text.trim().length).toBeGreaterThan(10);
    // The offered-work clause reads the quote first (spec §2.2.1), on the category and on each score question.
    for (const q of [TREE_CATEGORY, TREE_BREADTH, TREE_REASONING, TREE_ACTIONS]) expect(q.instructions).toContain("`quoted_turn` or `recent_turns`");
  });
});

// Spec §2.2: `last_houge_turn.kind` is computed at read time. The ack rule (§2.1) fires only after a plain `answer`, so a
// proposal misread as an answer lets a bare "好" that accepts an offer be settled as small talk on the Fast role.
describe("isProposal / lastHougeTurnOf (read-time kind)", () => {
  it("isProposal matches the offer markers (zh and en) and nothing else", () => {
    for (const t of ["要不要我帮你查一下明天的天气？", "我可以把它写成一个脚本。", "需要我继续吗", "Tap Approve on the card.",
      "Want me to dig into the second source?", "Shall I write it up?", "Should I keep going?", "Would you like me to schedule it?"]) expect(isProposal(t)).toBe(true);
    for (const t of ["明天多云，最高 22 度。", "The change was approved yesterday.", "did you restart?"]) expect(isProposal(t)).toBe(false);
  });
  it("a stored clarify is clarify; an offer wins over the clarify mark", () => {
    expect(lastHougeTurnOf([turn("assistant", "你指的是哪个项目？", "2026-10-07T00:59:30.000Z", "clarify")], NOW)).toEqual({ kind: "clarify", age_s: 30 });
    expect(lastHougeTurnOf([turn("assistant", "要不要我直接查？", "2026-10-07T00:59:30.000Z", "clarify")], NOW)).toEqual({ kind: "proposal", age_s: 30 });
  });
  it("a trailing question after a tool run (`loop`) is a proposal; a `loop` reply without one is an answer", () => {
    expect(lastHougeTurnOf([turn("assistant", "找到三篇相关文章，先看第一篇？", undefined, "loop")], NOW)?.kind).toBe("proposal");
    expect(lastHougeTurnOf([turn("assistant", "Found three articles. Read the first one?\"", undefined, "loop")], NOW)?.kind).toBe("proposal");
    expect(lastHougeTurnOf([turn("assistant", "明天多云，最高 22 度。", undefined, "loop")], NOW)?.kind).toBe("answer");
  });
  it("a trailing question on a row that is not `loop` (no intent, an evolution report) is not a tool-run proposal", () => {
    expect(lastHougeTurnOf([turn("assistant", "today's report is ready?", undefined, null)], NOW)?.kind).toBe("answer");
    expect(lastHougeTurnOf([turn("assistant", "evolution summary — anything else?", undefined, "evolution_report")], NOW)?.kind).toBe("answer");
  });
  it("the approval-card nudge (stored as `loop`) reads as a proposal, so an ack after it is never the plain-answer ack", () => {
    expect(lastHougeTurnOf([turn("assistant", ACK_NUDGE_TEXT, undefined, "loop")], NOW)?.kind).toBe("proposal");
  });
  // One builder for live and replay (spec §2.2.1, §7): a quoted Houge offer must read as a proposal exactly as
  // last_houge_turn does, or "好" quoting an hour-old offer is classified as small talk.
  it("quotedTurnFromRow: a Houge row takes the read-time kind, a user row is neutral, age from created_at", () => {
    expect(quotedTurnFromRow(turn("assistant", "找到三篇，先看第一篇？", "2026-10-07T00:00:00.000Z", "loop"), NOW))
      .toEqual({ role: "houge", kind: "proposal", age_s: 3600, text: "找到三篇，先看第一篇？" });
    expect(quotedTurnFromRow(turn("user", "以后回复短一点", "2026-10-07T00:59:00.000Z"), NOW))
      .toEqual({ role: "user", kind: "answer", age_s: 60, text: "以后回复短一点" });
  });
  it("takes the LAST assistant turn; null with none; age 0 on an unparseable instant", () => {
    const recent = [turn("assistant", "要不要我查？", "2026-10-07T00:00:00.000Z", "clarify"), turn("user", "x"), turn("assistant", "好的。", "2026-10-07T00:59:00.000Z", "loop")];
    expect(lastHougeTurnOf(recent, NOW)).toEqual({ kind: "answer", age_s: 60 });
    expect(lastHougeTurnOf([turn("user", "x")], NOW)).toBeNull();
    expect(lastHougeTurnOf([turn("assistant", "a", "not-a-date", "loop")], NOW)).toEqual({ kind: "answer", age_s: 0 });
  });
});

// Spec §2.2 / §2.2.1: the state is lane 1's approved egress envelope plus `quoted_turn`. Every text field is sanitised and
// broker-redacted (a quote is as much Paco's or Houge's text as the thread), and the quote counts toward the 24K cap: a
// quote that pushes the request over must skip the call, never be truncated or dropped silently.
describe("buildTreeState", () => {
  const QUOTE: QuotedTurn = { role: "houge", kind: "proposal", age_s: 3600, text: "要不要我查一下明天的天气？ ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 VALUE123" };
  const base: TreeStateInput = { userText: "好", recentTurns: [turn("assistant", "long answer with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")], turnChars: 4000,
    modality: "text", lastHougeTurn: { kind: "answer", age_s: 12 }, quotedTurn: null };

  it("carries exactly the five fields; quoted_turn is null when the message quotes nothing", () => {
    const r = buildTreeState(base);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.state).toEqual({ modality: "text", latest_message: "好", recent_turns: [{ role: "houge", text: "long answer with <token>" }],
      last_houge_turn: { kind: "answer", age_s: 12 }, quoted_turn: null });
  });
  it("sanitises and broker-redacts the quote like the thread, and cuts it at turnChars like the thread", () => {
    const redact = (t: string) => t.replace("VALUE123", "<redacted>");
    const r = buildTreeState({ ...base, quotedTurn: QUOTE }, redact);
    expect(r.ok && r.state.quoted_turn).toEqual({ role: "houge", kind: "proposal", age_s: 3600, text: "要不要我查一下明天的天气？ <token> <redacted>" });
    const cut = buildTreeState({ ...base, turnChars: 5, quotedTurn: { ...QUOTE, text: "以后回复短一点，谢谢" } });
    expect(cut.ok && (cut.state.quoted_turn as { text: string }).text).toBe("以后回复短…");
  });
  it("the quote counts toward the request cap: a state that fits without it skips with it", () => {
    const recent: ChatTurnRow[] = [];
    let fit = buildTreeState({ ...base, recentTurns: recent });
    while (fit.ok && fit.chars < MAX_REQUEST_CHARS - 3000) { recent.push(turn("user", "y".repeat(1000))); fit = buildTreeState({ ...base, recentTurns: recent }); }
    expect(fit.ok).toBe(true);
    expect(buildTreeState({ ...base, recentTurns: recent, quotedTurn: { ...QUOTE, text: "z".repeat(3500) } })).toEqual({ ok: false, skip: "state_too_large" });
  });
  it("chars measures the whole request, the six questions included", () => {
    const r = buildTreeState(base);
    expect(r.ok && r.chars).toBe(JSON.stringify({ state: r.ok ? r.state : null, questions: TREE_QUESTIONS.map(toJevQuestion) }).length);
  });
  it("skips a latest message over its own cap, never truncating it", () => {
    expect(buildTreeState({ ...base, userText: "x".repeat(MAX_LATEST_MESSAGE_CHARS + 1) })).toEqual({ ok: false, skip: "state_too_large" });
  });
});
