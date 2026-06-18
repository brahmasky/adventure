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
}

export type LlmResult =
  | { ok: true; provider: string; model: string; answer: string }
  | { ok: false; provider: string; error: string; unavailable?: boolean };

export interface LlmProvider {
  name: string;
  answer(req: LlmRequest): Promise<LlmResult>;
}
