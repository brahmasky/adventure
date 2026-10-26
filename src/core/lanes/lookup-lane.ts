import { WEB_RESULT_CONTENT_CAP } from "../../capabilities/web-search.js";
import { safeReason } from "../../domain/error-code.js";
import type { ModelString } from "../../omp/model-string.js";
import { composeReply } from "./answer-lane.js";
import { catchUpLine, finalQuery, needsRewrite, renderLanePrompt, renderSourcesBlock, rewritePrompt, sourceUrl, validateQuery, withSourceLine } from "./lane-compose.js";
import { LATE, within } from "./lane-time.js";
import { fall, type LaneFall, type LaneInput, type LaneResult, type LookupLaneDeps } from "./lane-types.js";
import { decideSync } from "../../decisions/decide.js";
import { TOOL_WALL } from "../../decisions/entries/tool-wall.js";
import { READER_FAMILY } from "../../decisions/entries/reader-family.js";

/** Stage B §5: the lane's budget and the reserve the compose keeps; every other step is bounded inside them. */
export const LOOKUP_BUDGET_MS = 75_000;
export const COMPOSE_RESERVE_MS = 15_000;
export const REWRITE_MS = 12_000;
export const SEARCH_MS = 25_000;
export const READER_ATTEMPT_MS = 20_000;
export const FETCH_MS = 15_000;

type WebHit = { title: string; url: string; content: string };
type Found = { kind: "found"; provider: string; results: WebHit[] };
type Read = { kind: "read"; urls: string[]; digests: string[]; facts: string[]; flagged: boolean };

/** The lookup lane (stage B §5). Never throws: an unexpected exception is `lane_threw`, logged with the run id. */
export async function runLookupLane(i: LaneInput, d: LookupLaneDeps): Promise<LaneResult> {
  try {
    return await lookupSteps(i, d);
  } catch (e) {
    console.error(`lookup lane: threw on ${i.run_id}: ${safeReason(e)}`);
    return fall("lane_threw");
  }
}

async function lookupSteps(i: LaneInput, d: LookupLaneDeps): Promise<LaneResult> {
  const chain = d.fastChain(i.effort);
  if (chain.length === 0) return fall("no_fast_leg");
  const query = await lookupQuery(i, d);
  if (i.signal.aborted) return fall("aborted");
  const found = await searchStep(i, d, query);
  if (found.kind === "fallthrough") return found;
  const read = await readStep(i, d, found, query);
  if (read.kind === "fallthrough") return read;
  return composeLookup(i, d, chain, read);
}

/** Time a step may still use before the compose reserve; a step starts only while this is positive (spec §5). */
const beforeReserve = (i: LaneInput, d: { now(): number }): number => i.deadlineAt - d.now() - COMPOSE_RESERVE_MS;

/** Step 2: the pre-filter, then one bounded Tiny rewrite whose answer code validates; any doubt → the bare message. */
async function lookupQuery(i: LaneInput, d: LookupLaneDeps): Promise<string> {
  const prev = d.previousTelegramTurns(i.chat_id);
  const lastPaco = [...prev].reverse().find((t) => t.role === "user");
  const age = lastPaco ? d.now() - Date.parse(lastPaco.created_at) : null;
  if (!needsRewrite(i.userText, i.quoted !== null, age)) return finalQuery(i.userText);
  const bound = Math.min(REWRITE_MS, beforeReserve(i, d));
  if (bound <= 0) return finalQuery(i.userText);
  const r = await within(bound, d.rewrite({ prompt: rewritePrompt(prev, i.quoted, i.userText), deadlineMs: bound, signal: i.signal }).catch((): null => null), i.signal);
  return finalQuery(validateQuery(r !== LATE && r !== null && r.ok ? r.answer : "SAME", i.userText));
}

/** Step 3: one search raced against min(25 s, remaining − 15 s); the provenance row exactly as the planner's wrapper writes it. */
async function searchStep(i: LaneInput, d: LookupLaneDeps, query: string): Promise<Found | LaneFall> {
  const bound = Math.min(SEARCH_MS, beforeReserve(i, d));
  if (bound <= 0) return fall("lane_timeout");
  const r = await within(bound, d.search({ query, max_results: d.maxResults }), i.signal);
  if (i.signal.aborted) return fall("aborted");
  if (r === LATE) return fall("search_timeout");
  if (!r.ok) return fall("search_failed");
  const results = webHits(r.output.results);
  const provider = typeof r.output.provider === "string" ? r.output.provider : "unknown";
  d.ledger.searchPerformed({ query, provider, source_urls: results.map((x) => x.url).filter((u) => u.length > 0), result_count: results.length });
  return results.length === 0 ? fall("no_results") : { kind: "found", provider, results };
}

function webHits(raw: unknown): WebHit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): WebHit[] => {
    const r = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
    return typeof r.url === "string" && typeof r.content === "string" ? [{ title: typeof r.title === "string" ? r.title : "", url: r.url, content: r.content }] : [];
  });
}

const readerBounds = (i: LaneInput, d: LookupLaneDeps) => ({ attemptMs: () => Math.min(READER_ATTEMPT_MS, beforeReserve(i, d)), signal: i.signal });

/** Step 4 (+5): the strict read of the capped result set; thin (`answer_to_objective === null`) → one fetch, read again. */
async function readStep(i: LaneInput, d: LookupLaneDeps, found: Found, objective: string): Promise<Read | LaneFall> {
  const output = { query: objective, provider: found.provider, results: found.results.map((r) => ({ ...r, content: r.content.slice(0, WEB_RESULT_CONTENT_CAP) })) };
  const first = await d.read(output, objective, readerBounds(i, d));
  if (i.signal.aborted) return fall("aborted");
  if (!first.ok) return fall(first.why === "reserve" ? "lane_timeout" : first.why === "aborted" ? "aborted" : "reader_failed");
  const urls = [...new Set(found.results.map((r) => sourceUrl(r.url)).filter((u): u is string => u !== null))];
  const recorder = d.recorder ?? { record: () => null };
  decideSync(TOOL_WALL, { crosses: true }, { run_id: i.run_id, tool_call_id: null, recorder });
  decideSync(READER_FAMILY, { primary: !first.reader_collapse }, { run_id: i.run_id, tool_call_id: null, recorder });
  const read: Read = { kind: "read", urls, digests: [first.digest], facts: [...first.extraction.facts], flagged: first.extraction.contains_instructions };
  if (first.extraction.answer_to_objective === null && urls[0] !== undefined) await thinFetch(i, d, urls[0], objective, read);
  return i.signal.aborted ? fall("aborted") : read;
}

/** Step 5: one fetch of the top listed result and a second strict read; any failure here composes from the first digest. */
async function thinFetch(i: LaneInput, d: LookupLaneDeps, url: string, objective: string, read: Read): Promise<void> {
  const bound = Math.min(FETCH_MS, beforeReserve(i, d));
  if (bound <= 0) return;
  const r = await within(bound, d.fetch({ url }).catch((): null => null), i.signal);
  if (r === LATE || r === null || !r.ok || i.signal.aborted) return;
  d.ledger.fetchPerformed({ url: typeof r.output.url === "string" ? r.output.url : url, status: typeof r.output.status === "number" ? r.output.status : 0,
    bytes: typeof r.output.bytes === "number" ? r.output.bytes : 0 });
  const second = await d.read(r.output, objective, readerBounds(i, d)).catch((): null => null);
  if (!second?.ok) return;
  const rec2 = d.recorder ?? { record: () => null };
  decideSync(TOOL_WALL, { crosses: true }, { run_id: i.run_id, tool_call_id: null, recorder: rec2 });
  decideSync(READER_FAMILY, { primary: !second.reader_collapse }, { run_id: i.run_id, tool_call_id: null, recorder: rec2 });
  read.digests.push(second.digest);
  read.facts.push(...second.extraction.facts);
  read.flagged ||= second.extraction.contains_instructions;
}

/** Steps 6–7: compose on the Fast chain from the code-built sources, then the source line; the catch-up keeps hosts + facts. */
async function composeLookup(i: LaneInput, d: LookupLaneDeps, chain: readonly ModelString[], read: Read): Promise<LaneResult> {
  const retrieval = await d.retrieve(i.chat_id, i.userText);
  if (i.signal.aborted) return fall("aborted");
  const prompt = renderLanePrompt({ system: d.systemPrompt(i.chat_id), retrieval, recentTurns: i.recentTurns, turnChars: i.turnChars, quoted: i.quoted,
    message: i.userText, note: i.note, sources: renderSourcesBlock(read.urls, read.digests, read.flagged) });
  const r = await composeReply(i, d, chain, prompt);
  if (r.kind === "fallthrough") return r;
  return { kind: "reply", text: withSourceLine(r.text, read.urls), model: r.model, sources: read.urls,
    catch_up: catchUpLine({ lane: "lookup", urls: read.urls, facts: read.facts, flagged: read.flagged }) };
}
