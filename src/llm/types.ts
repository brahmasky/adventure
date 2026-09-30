import type { LlmUsage } from "../run/llm-usage.js";
import type { OmpCheckFailure } from "../omp/omp-version.js";

/** Multimodal ingest (spec 2026-09-29): a file under the media temp dir, handed to a media-capable leg. */
export interface LlmMediaAttachment {
  path: string;
  mime: string;
}

export interface LlmRequest {
  question: string;
  model?: string;
  /**
   * Houge-controlled system prompt (persona/instructions). NEVER the user's
   * question text — it is delivered as an argv flag for `pi` and a system
   * message for the APIs, so it must stay trusted. `/ask` uses this to replace
   * pi's default *coding-assistant* persona with a neutral question-answerer.
   */
  system?: string;
  /** Present only for media calls. The answer adapter validates it; legs that cannot take it are never asked. */
  media?: LlmMediaAttachment;
}

export type LlmResult =
  | { ok: true; provider: string; model: string; answer: string; usage?: LlmUsage }
  | { ok: false; provider: string; error: string; unavailable?: boolean; omp_check?: OmpCheckFailure };

export interface LlmProvider {
  name: string;
  answer(req: LlmRequest): Promise<LlmResult>;
  /** Absent means "no media". The chain filters on this BEFORE attempting a leg. */
  supportsMedia?(mime: string): boolean;
}
