import type { ToolAdapterResult } from "../tools/tool-registry.js";

export const DEFAULT_LLM_MODEL = "claude-haiku-4-5";

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface LlmAnswerConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}

interface AnthropicTextBlock {
  type: string;
  text?: unknown;
}

function findTextBlock(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content as AnthropicTextBlock[]) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
}

export function createLlmAnswerAdapter(
  config: LlmAnswerConfig = {}
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const question = input.question;
    if (typeof question !== "string" || question.length === 0) {
      return { ok: false, error: "question must be a non-empty string" };
    }

    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "ANTHROPIC_API_KEY is not set" };
    }

    const model = config.model ?? process.env.HOUGE_LLM_MODEL ?? DEFAULT_LLM_MODEL;
    const baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1/messages";
    const body = {
      model,
      max_tokens: config.maxTokens ?? 1024,
      messages: [{ role: "user", content: question }]
    };

    const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);

    let response: Awaited<ReturnType<FetchImpl>>;
    try {
      response = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `LLM request failed: ${message}` };
    }

    if (!response.ok) {
      return { ok: false, error: `LLM request returned HTTP ${response.status}` };
    }

    const data = await response.json();
    const answer = findTextBlock(data);
    if (answer === undefined) {
      return { ok: false, error: "LLM response missing text content" };
    }

    return { ok: true, output: { question, answer, model } };
  };
}
