export interface LlmRequest {
  question: string;
  model?: string;
}

export type LlmResult =
  | { ok: true; provider: string; model: string; answer: string }
  | { ok: false; provider: string; error: string; unavailable?: boolean };

export interface LlmProvider {
  name: string;
  answer(req: LlmRequest): Promise<LlmResult>;
}
