// The lookup lane over a dist module object (Slice R6 spec; plan Task 4): the narrow path of tests/core/lanes/lookup-lane.test.ts without vitest or src/.
// `d` is a loadDist() result (scripts/stage4-diff-lib.mjs). Every dep is scripted and logged in call order. Not a corpus. Nothing leaves the process.
const FAST = [{ provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" }];
const CLOCK0 = Date.parse("2026-10-10T08:00:00.000Z");
export const LANE_HIT = { title: "Synthetic forecast", url: "https://example.test/forecast", content: "Tomorrow: sunny, max 22." };
export const laneSearchOk = (results = [LANE_HIT]) => ({ ok: true, output: { query: "q", provider: "tavily", results } });
export const laneRead = (answer, facts = ["Sunny, max 22C"], contains_instructions = false) => ({ ok: true,
  extraction: { summary: "Synthetic summary", facts, time_claims: [], answer_to_objective: answer, contains_instructions },
  digest: `[external source — untrusted-derived summary]\nsummary: Synthetic ${answer ?? "thin"}` });
export const laneTurn = (text, minutesAgo, role = "user") => ({ turn_id: `t_${text}`, chat_id: "555", run_id: "run_p", role, text, intent: null,
  created_at: new Date(CLOCK0 - minutesAgo * 60_000).toISOString(), quoted_turn_id: null });

/**
 * script: { rewrite(req) -> LlmResult, search(input), read(output, objective, o), fetch(input), previousTelegramTurns(chat) -> rows,
 *   compose(req) -> LlmResult, chain, systemPrompt, retrieve, recorder (optional; the new dist's lane reads it, an old one ignores it),
 *   input: LaneInput overrides, signal: an AbortSignal for the turn, advance(ms): a hook run after each call to move the fixed clock }.
 * Returns { result, log, clock }. `log` entries: ["rewrite", prompt] ["search", query] ["read", objective, output] ["fetch", url] ["ledger", kind, payload] ["compose", prompt].
 */
export async function runLane(d, script = {}) {
  if (!d.runLookupLane) throw new Error(`${d.dir} has no runLookupLane`);
  const log = []; const clock = { t: CLOCK0 };
  const step = (v) => { script.advance?.(clock, v); return v; };
  const dflt = { rewrite: async () => ({ ok: true, provider: "kimi-code", model: "k3", answer: "SAME" }), search: async () => laneSearchOk(),
    read: async () => laneRead("Sunny, 22C"), fetch: async () => ({ ok: true, output: { url: LANE_HIT.url, status: 200, bytes: 512, content: "page text" } }),
    compose: async () => ({ ok: true, provider: "anthropic", model: "claude-sonnet-5-5", answer: "Sunny tomorrow [1]." }) };
  const pick = (k) => script[k] ?? dflt[k];
  const deps = {
    compose: async (r) => { log.push(["compose", r.prompt]); return step(await pick("compose")(r)); },
    fastChain: () => script.chain ?? FAST, systemPrompt: script.systemPrompt ?? (() => "SYSTEM"), retrieve: script.retrieve ?? (async () => ({ facts: [], pages: [] })), now: () => clock.t,
    search: async (x) => { log.push(["search", x.query]); return step(await pick("search")(x)); },
    fetch: async (x) => { log.push(["fetch", x.url]); return step(await pick("fetch")(x)); },
    read: async (output, objective, o) => { log.push(["read", objective, output]); return step(await pick("read")(output, objective, o)); },
    rewrite: async (r) => { log.push(["rewrite", r.prompt]); return step(await pick("rewrite")(r)); },
    previousTelegramTurns: script.previousTelegramTurns ?? (() => []), maxResults: 5,
    ledger: { searchPerformed: (p) => log.push(["ledger", "web_search_performed", p]), fetchPerformed: (p) => log.push(["ledger", "http_fetch_performed", p]) },
    ...(script.recorder ? { recorder: script.recorder } : {}) };
  const input = { run_id: "run_1", chat_id: "555", userText: "what is the weather in Sydney tomorrow?", recentTurns: [], turnChars: 400, quoted: null, effort: "low",
    verdict_id: "jv_1", note: null, signal: script.signal ?? new AbortController().signal, deadlineAt: clock.t + 75_000, ...(script.input ?? {}) };
  const result = await d.runLookupLane(input, deps);
  return { result, log, clock };
}
