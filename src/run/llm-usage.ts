/**
 * Shared LLM usage normalizer + type (Phase 3.1, spec §"Real telemetry" — backlog #3).
 *
 * One canonical {@link LlmUsage} shape for token accounting across every engine. The CLI
 * writer/reviewer (Codex `--json`) and the kimi/pi cheap chain all feed this shape into
 * `recordLlmCall`, which emits the `llm_call` ledger event.
 *
 * NON-NEGOTIABLE: usage carries ONLY counts/metadata — never prompt, diff, or response bodies.
 *
 * The normalizer is TOLERANT: malformed/garbage input returns `null`, never throws.
 */

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd?: number;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Coerce a value to a finite non-negative integer, or 0 (tolerant of strings/garbage). */
function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Normalize Codex `--json` JSONL stdout into {@link LlmUsage}. Two real shapes are handled (the
 * `codex exec --json` STDOUT stream and the rollout-log shape differ):
 *   - stdout stream: `{"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}`
 *   - rollout/older: `{"type":"token_count","info":{"total_token_usage":{...same fields...}}}`
 * We take the LAST usage-bearing event of either shape. `output_tokens` includes
 * `reasoning_output_tokens` (reasoning is real output). Codex reports no per-call cost → no cost_usd.
 * Returns `null` if no usage event is found.
 */
export function normalizeCodexUsage(stdout: string): LlmUsage | null {
  let last: Record<string, unknown> | undefined;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // ignore non-JSON lines defensively
    }
    const obj = asObject(event);
    if (!obj) continue;
    // stdout stream shape: any event carrying a `usage` object with token counts (turn.completed).
    const direct = asObject(obj.usage);
    if (direct && (direct.input_tokens !== undefined || direct.output_tokens !== undefined)) {
      last = direct;
      continue;
    }
    // rollout-log shape: token_count → info.total_token_usage.
    if (obj.type === "token_count") {
      const info = asObject(obj.info);
      const total = info && asObject(info.total_token_usage);
      if (total) last = total;
    }
  }
  if (!last) return null;

  return {
    input_tokens: num(last.input_tokens),
    output_tokens: num(last.output_tokens) + num(last.reasoning_output_tokens),
    cached_input_tokens: num(last.cached_input_tokens)
  };
}
