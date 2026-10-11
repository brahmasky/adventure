import type { ReaderExtraction } from "../quarantine.js";
import type { ToolAdapterResult } from "../../tools/tool-registry.js";
import type { Effort } from "../../jev/tree-policy.js";
import type { QuotedTurn } from "../../jev/questions/tree.js";
import type { LlmResult } from "../../llm/types.js";
import type { ModelString } from "../../omp/model-string.js";
import type { TurnRetrieval } from "../../omp/turn-context.js";
import type { ChatTurnRow } from "../../run/run-store.js";

/** Stage B §8: the closed list of reasons a lane falls through to the planner, spelled `fallthrough:<why>` on the verdict. */
export const LANE_WHYS = ["no_fast_leg", "compose_failed", "compose_timeout", "empty_reply", "render_failed", "lane_threw",
  "search_failed", "no_results", "search_timeout", "reader_failed", "lane_timeout", "aborted"] as const;
export type LaneWhy = (typeof LANE_WHYS)[number];

/** What a lane gets from core-worker (stage B §3). Hermetic: no store, no process env; everything else through deps. */
export interface LaneInput {
  run_id: string; chat_id: string; userText: string; recentTurns: readonly ChatTurnRow[]; turnChars: number; quoted: QuotedTurn | null;
  effort: Effort | null; verdict_id: string; note: string | null; signal: AbortSignal; deadlineAt: number;
}

/** One compose call: the Fast candidates at the route's effort, role `lane`, routed_by on every leg (stage B §4). */
export interface ComposeRequest { prompt: string; chain: readonly ModelString[]; deadlineMs: number; signal: AbortSignal; routed_by: string }

export interface AnswerLaneDeps {
  compose(req: ComposeRequest): Promise<LlmResult>;
  /** The Fast role's candidates at this effort; empty = `no_fast_leg`. */
  fastChain(effort: Effort | null): readonly ModelString[];
  /** The planner's own system prompt text (`buildSystemPrompt(...).text`): the same lessons the planner reads. */
  systemPrompt(chatId: string): string;
  retrieve(chatId: string, message: string): Promise<Pick<TurnRetrieval, "facts" | "pages">>;
  now(): number;
}

export type LaneResult =
  | { kind: "reply"; text: string; model: string; catch_up: string; sources?: string[] }
  | { kind: "fallthrough"; why: LaneWhy };
export type LaneFall = Extract<LaneResult, { kind: "fallthrough" }>;
export const fall = (why: LaneWhy): LaneFall => ({ kind: "fallthrough", why });

/** The strict reader's result (stage B §5 step 4): the schema-only extraction and its digest, or a named failure. */
export type StrictRead = { ok: true; extraction: ReaderExtraction; digest: string } | { ok: false; why: "unreadable" | "reserve" | "aborted" };
/** `web_search_performed` exactly as the planner's wrapper writes it. */
export interface SearchPerformed { query: string; provider: string; source_urls: string[]; result_count: number }
/** `http_fetch_performed` exactly as the planner's wrapper writes it. */
export interface FetchPerformed { url: string; status: number; bytes: number }

export interface LookupLaneDeps extends AnswerLaneDeps {
  /** `createWebSearchAdapter` (the configured chain); it takes no signal, so the lane races it. */
  search(input: { query: string; max_results: number }): Promise<ToolAdapterResult>;
  /** `createHttpFetchAdapter` (the SSRF floor, 15 s, 1 MB, 6 000-char cap); it takes no signal either. */
  fetch(input: { url: string }): Promise<ToolAdapterResult>;
  /** The strict reader on the Reader role; `attemptMs` is read as each attempt starts. */
  read(output: Record<string, unknown>, objective: string, o: { attemptMs: () => number; signal: AbortSignal }): Promise<StrictRead>;
  /** One Tiny-role one-shot, role `lane` (the query rewrite). */
  rewrite(req: { prompt: string; deadlineMs: number; signal: AbortSignal }): Promise<LlmResult>;
  /** The chat's last turns from Telegram runs (never schedule rows), oldest first. */
  previousTelegramTurns(chatId: string): readonly ChatTurnRow[];
  maxResults: number;
  ledger: { searchPerformed(p: SearchPerformed): void; fetchPerformed(p: FetchPerformed): void };
}
