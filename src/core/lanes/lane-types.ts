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
