import { describe, expect, it } from "vitest";
import { CODE_OWNED_HINT, CONVERSATIONAL_SRC_STRINGS, createMemoryWriteAdapter, extractLiteralPhrases, extractThreadPhrases, LESSON_ESCALATE_HINT, THREAD_TEXT_CHAR_CAP,
  THREAD_USER_TURN_CAP, type MemoryWriteAdapterConfig } from "../../src/capabilities/lesson-write.js";
import { memorySources } from "../../src/capabilities/memory-sources.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

// The adapter's own cases live in tests/capabilities/memory-write-adapter.test.ts (spec 2026-10-15). The code-owned layer
// routing cases stay here, ported onto createMemoryWriteAdapter: the phrase rules did not change with the adapter.
type Over = Partial<Omit<MemoryWriteAdapterConfig, "sources">> & { feedback: string; answer?: string };
function routed(o: Over): { adapter: (i: Record<string, unknown>) => Promise<ToolAdapterResult>; distilled: () => number; saved: string[] } {
  let n = 0;
  const saved: string[] = [];
  const { feedback, answer, ...rest } = o;
  const adapter = createMemoryWriteAdapter({
    sources: memorySources({ own: { run_id: "r", turn_id: null, text: feedback }, steered: [], quoted: null, recent: [], prior: "" }),
    allowedScopes: ["ask", "research"], defaultScope: "ask", recorder: { record: () => null }, run_id: "r", runSource: () => "telegram",
    llm: async () => { n += 1; return { ok: true, output: { answer: answer ?? '{"kind":"rule","lesson":"x"}' } }; },
    save: async (plan) => { saved.push(plan.lesson!.text); return { lesson: { verb: "add", id: 1, lesson: plan.lesson!.text, prunedIds: [] } }; },
    ...rest
  });
  return { adapter, distilled: () => n, saved };
}
const out = (r: ToolAdapterResult) => (r.ok ? r.output : {}) as Record<string, unknown>;

describe("code-owned layer routing (⓪·3 S1c)", () => {
  it("REFUSES (a digest, not an error) when quoted text exists verbatim in src/, before distilling", async () => {
    const h = routed({ feedback: '把"自我修改状态"这个标题改得更清楚一点', srcContains: (p) => p === "自我修改状态" });
    expect(out(await h.adapter({ scope: "ask" }))).toMatchObject({ saved: false, reason: "code-owned", phrase: "自我修改状态", hint: CODE_OWNED_HINT });
    expect([h.distilled(), h.saved]).toEqual([0, []]); // refused BEFORE the distill call
  });
  it("ordinary Chinese feedback (no phrase matching src/) proceeds to distill — no false refusal", async () => {
    const checked: string[] = [];
    const h = routed({ feedback: "回答的时候不要那么啰嗦，简洁一点比较好", answer: '{"kind":"rule","lesson":"回答更简洁"}', srcContains: (p) => { checked.push(p); return false; } });
    expect(out(await h.adapter({ scope: "ask" }))).toMatchObject({ saved: true, kinds: ["rule"] });
    expect(h.saved).toEqual(["回答更简洁"]);
    expect(checked.length).toBeGreaterThan(0); // the extractor DID offer phrases (CJK runs ≥6); the src check said no
  });
  it("no srcContains configured ⇒ the check is skipped entirely", async () => {
    const h = routed({ feedback: '把"自我修改状态"改一下', answer: '{"kind":"none"}' });
    expect(out(await h.adapter({}))).toMatchObject({ saved: false, reason: "nothing_to_save" });
  });
  it("echoing one of Houge's CONVERSATIONAL strings is NOT refused (⓪·3 S2 fix — no self-collision)", async () => {
    // "这个问题反复出现" is a substring of LESSON_ESCALATE_HINT (in src/): a user echoing it rides the normal path
    const h = routed({ feedback: "这个问题反复出现，你又用了UTC时间", answer: '{"kind":"rule","lesson":"用墨尔本时间"}', srcContains: () => true });
    expect(out(await h.adapter({ scope: "ask" }))).toMatchObject({ saved: true, kinds: ["rule"] });
    expect(CONVERSATIONAL_SRC_STRINGS).toContain(LESSON_ESCALATE_HINT);
  });
  it("F1: a phrase quoted in a RECENT USER TURN refuses even when the current message carries nothing", async () => {
    // The 2026-07-03 live miss: the title was quoted two turns earlier; the follow-up said only "换掉它"
    const h = routed({ feedback: "对，换掉它", threadUserTexts: ["好，先看看别的", "把「✨ 又偷学了新本事」这个标题换一下"], srcContains: (p) => p === "✨ 又偷学了新本事" });
    expect(out(await h.adapter({ scope: "ask" }))).toMatchObject({ saved: false, reason: "code-owned", phrase: "✨ 又偷学了新本事" });
    expect(h.distilled()).toBe(0);
  });
  it("F1: current-message phrases keep precedence — the digest names the current phrase, not the thread's", async () => {
    const h = routed({ feedback: '先改"当前标题短语"', threadUserTexts: ["之前说过「线程里的短语」也要改"], srcContains: () => true });
    expect(out(await h.adapter({ scope: "ask" }))).toMatchObject({ saved: false, reason: "code-owned", phrase: "当前标题短语" });
  });
  it("F1: no threadUserTexts configured ⇒ no refusal without a current-message match", async () => {
    const h = routed({ feedback: "对，换掉它", answer: '{"kind":"rule","lesson":"换个说法"}', srcContains: (p) => p === "✨ 又偷学了新本事" });
    expect(out(await h.adapter({ scope: "ask" }))).toMatchObject({ saved: true, kinds: ["rule"] });
  });
  it("quoting a RENDERED output constant (the evolution-notice header) IS still refused", async () => {
    const h = routed({ feedback: "你的标题「🐒 自我修改进展」太幼稚了", srcContains: (p) => p.includes("自我修改进展") });
    expect(out(await h.adapter({ scope: "ask" }))).toMatchObject({ saved: false, reason: "code-owned" });
    expect(CONVERSATIONAL_SRC_STRINGS.some((s) => s.includes("自我修改进展"))).toBe(false); // a rendered surface: not on the skip list
  });
});
describe("extractLiteralPhrases (the code-owned phrase extractor)", () => {
  it("extracts quoted phrases across quote styles", () => {
    expect(extractLiteralPhrases('change the "View diff" button')).toContain("View diff");
    expect(extractLiteralPhrases("把“自我修改状态”改一下")).toContain("自我修改状态");
    expect(extractLiteralPhrases("把「重启成功」那句话去掉")).toContain("重启成功");
    expect(extractLiteralPhrases("rename the `Merge & reload` label")).toContain("Merge & reload");
    expect(extractLiteralPhrases("the [View diff] link is broken")).toContain("View diff");
  });

  it("extracts unquoted CJK runs of ≥6 chars but not shorter ones", () => {
    const phrases = extractLiteralPhrases("不要显示自我修改状态标题了");
    expect(phrases.some((p) => p.includes("自我修改状态"))).toBe(true);
    expect(extractLiteralPhrases("改标题")).toEqual([]);
  });

  it("ignores short latin quotes and bare unquoted latin text (conservative)", () => {
    expect(extractLiteralPhrases('fix "bug" please')).toEqual([]);
    expect(extractLiteralPhrases("please stop emitting revision notes")).toEqual([]);
  });

  it("bounds the output (phrase length ≤ 80, at most 8 phrases)", () => {
    const long = `"${"x".repeat(120)}"`;
    expect(extractLiteralPhrases(long)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `"phrase-number-${i}"`).join(" ");
    expect(extractLiteralPhrases(many).length).toBeLessThanOrEqual(8);
  });
});

describe("extractThreadPhrases (the F1 thread-scoped union)", () => {
  it("puts current-message phrases first, then thread phrases most recent first, deduped", () => {
    expect(
      extractThreadPhrases('改掉"current-phrase"这段', ['我说过「最近的短语」', '还有「更早的短语」'])
    ).toEqual(["current-phrase", "最近的短语", "更早的短语"]);
    // Dedup: a thread phrase already extracted from the current message appears once.
    expect(extractThreadPhrases('把「重复的短语」换掉', ['把「重复的短语」换掉'])).toEqual(["重复的短语"]);
  });

  it("no thread texts ⇒ byte-identical to the single-message extractor", () => {
    const feedback = '把"自我修改状态"这个标题改得更清楚一点';
    expect(extractThreadPhrases(feedback, [])).toEqual(extractLiteralPhrases(feedback));
  });

  it("caps the union at 8 phrases, preferring the current message's", () => {
    const current = Array.from({ length: 6 }, (_, i) => `"current-phrase-${i}"`).join(" ");
    const thread = [Array.from({ length: 6 }, (_, i) => `"thread-phrase-${i}"`).join(" ")];
    const phrases = extractThreadPhrases(current, thread);
    expect(phrases).toHaveLength(8);
    expect(phrases.slice(0, 6)).toEqual(Array.from({ length: 6 }, (_, i) => `current-phrase-${i}`));
    expect(phrases.slice(6)).toEqual(["thread-phrase-0", "thread-phrase-1"]);
  });

  it("scans at most 6 turns and 1500 total chars of thread text", () => {
    // The 7th turn is never scanned…
    const sevenBack = [...Array.from({ length: 6 }, () => "填充文本"), '把「第七条的短语」换掉'];
    expect(extractThreadPhrases("换掉它", sevenBack)).toEqual([]);
    // …and a turn past the char budget is never scanned either.
    const pastBudget = ["x".repeat(THREAD_TEXT_CHAR_CAP), '把「预算外的短语」换掉'];
    expect(extractThreadPhrases("换掉它", pastBudget)).toEqual([]);
    expect(THREAD_USER_TURN_CAP).toBe(6);
    expect(THREAD_TEXT_CHAR_CAP).toBe(1500);
  });
});
