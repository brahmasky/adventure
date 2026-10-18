import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretBroker } from "../../src/config/secret-broker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { pinEnabledFlags, pinOmpEnv } from "../helpers/omp-env.js";
import { drainOutbox } from "../helpers/omp-worker.js";
import { cat, HEAVY, LIGHT, scriptedLlm, treeSays, triageHarness, webOk, type Says } from "../helpers/triage-harness.js";

// Codex final review #2 (ADR 0015): an automatic lesson save is announced on a card whose text is the lesson, and the lesson
// may carry a secret value Paco pasted. The card goes out through enqueueNotification, which stores text as given, so the
// worker must mask it the way final reports are masked, or a key reaches Telegram and the outbox in the clear.
pinOmpEnv();
pinEnabledFlags();
const TAVILY = "tvly-seeded-secret-value-0123456789abcdef";
const OAUTH = "sk-ant-oat01-seeded-credential-token-0123456789";
const broker = createSecretBroker({ TAVILY_API_KEY: TAVILY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, TYPESAFE_API_KEY: "test-key" });
const LEAKY = `Use key ${TAVILY} and token ${OAUTH} for searches.`;
const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };
const distill = async () => ({ ok: true as const, output: { answer: JSON.stringify({ kind: "rule", lesson: LEAKY }) } });
const memcards = (store: Parameters<typeof drainOutbox>[0]) => [...drainOutbox(store).entries()].filter(([k]) => k.startsWith("memcard:")).map(([, p]) => p);
const expectMasked = (text: string) => { expect(text).not.toContain(TAVILY); expect(text).not.toContain(OAUTH); expect(text).toContain("«redacted»"); };

afterEach(async () => { await evolutionLaneSettled(); resetEvolutionLaneForTests(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("an automatic lesson save never puts a secret value on a card", () => {
  it("the Undo-only card (planner path) is masked", async () => {
    const h = triageHarness(treeSays({ ...RULE, actions: HEAVY }), { broker, llm: scriptedLlm({ distill }) });
    expect((await h.worker.triageTurn(h.turn("以后用这个key搜索。顺便帮我订明天的会议室").input)).kind).toBe("inform");
    const cards = memcards(h.store);
    expect(cards).toHaveLength(1);
    expectMasked(String(cards[0]?.text));
    h.store.close();
  });
  it("the memory lane's reply card is masked", async () => {
    const h = triageHarness(treeSays(RULE), { broker, llm: scriptedLlm({ distill }) });
    const out = await h.worker.triageTurn(h.turn("从现在起，搜索请用这个key。").input);
    expect(out.kind).toBe("lane_reply");
    expectMasked(out.kind === "lane_reply" ? out.text : "");
    h.store.close();
  });
  it("a lookup lane reply that echoes a secret is masked, and the lane's saved note card too", async () => {
    const compose = async () => ({ ok: true as const, output: { answer: `Done with ${TAVILY}.`, model: "claude-sonnet-5-5" } });
    const h = triageHarness(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, actions: LIGHT }), { broker, web: webOk(), llm: scriptedLlm({ distill, compose }) });
    const out = await h.worker.triageTurn(h.turn("以后搜索用这个key。明天悉尼天气怎么样？").input);
    expect(out.kind).toBe("lane_reply");
    expectMasked(out.kind === "lane_reply" ? out.text : "");
    h.store.close();
  });
});
