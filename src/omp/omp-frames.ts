import type { LlmErrorKind } from "../llm/audit.js";
import type { LlmUsage } from "../run/llm-usage.js";

export type OmpFrame = { type: string } & Record<string, unknown>;

export function parseFrameLine(line: string): OmpFrame | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string"
      ? (v as OmpFrame) : null;
  } catch {
    return null;
  }
}

export interface AssistantSummary {
  text: string; provider?: string; model?: string; usage?: LlmUsage; stopReason?: string;
  errorMessage?: string; credentialId?: number; ttftMs?: number; durationMs?: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function toUsage(raw: unknown): LlmUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const reasoning = n(u.reasoningTokens);
  return {
    input_tokens: n(u.input) + n(u.cacheWrite),
    output_tokens: n(u.output),
    cached_input_tokens: n(u.cacheRead),
    ...(reasoning > 0 ? { thinking_tokens: reasoning } : {})
  };
}

export function summarizeAssistantMessage(frame: OmpFrame): AssistantSummary | null {
  if (frame.type !== "message_end") return null;
  const m = frame.message as Record<string, unknown> | undefined;
  if (!m || m.role !== "assistant") return null;
  const content = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
  const text = content.filter((c) => c.type === "text").map((c) => str(c.text) ?? "").join("");
  const out: AssistantSummary = { text };
  const set = <K extends keyof AssistantSummary>(k: K, v: AssistantSummary[K] | undefined) => { if (v !== undefined) out[k] = v; };
  set("provider", str(m.provider));
  set("model", str(m.model));
  set("usage", toUsage(m.usage));
  set("stopReason", str(m.stopReason));
  set("errorMessage", str(m.errorMessage) ?? str(m.error));
  if (typeof m.credentialId === "number") out.credentialId = m.credentialId;
  if (typeof m.ttft === "number") out.ttftMs = Math.round(m.ttft);
  if (typeof m.duration === "number") out.durationMs = Math.round(m.duration);
  return out;
}

export function classifyOmpError(text: string): LlmErrorKind {
  const t = text.toLowerCase();
  if (/\b429\b|rate.?limit|quota|usage limit|limit reached|resets in/.test(t)) return "quota";
  if (/authoriz|re-?login|not logged in|unauthenticated|401|403|invalid.*grant/.test(t)) return "auth";
  if (/no models? matching|unknown model|model .*not found|invalid model/.test(t)) return "model_missing";
  if (/refusal/.test(t)) return "model_refusal";
  if (/aborted|cancelled/.test(t)) return "aborted";
  if (/timed? ?out|timeout/.test(t)) return "timeout";
  if (/econn|socket|network|fetch failed|hang up|enotfound/.test(t)) return "transport";
  if (/enoent|spawn/.test(t)) return "spawn";
  return "other";
}
