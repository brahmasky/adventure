/**
 * Shared LLM usage normalizer + type (Phase 3.1, spec §"Real telemetry" — backlog #3).
 *
 * One canonical {@link LlmUsage} shape for token accounting across every engine. The CLI
 * writer/reviewer (Codex `--json`), the panel seats and every chain leg feed this shape into the
 * audit chokepoint (`RunStore.llmAuditSink`), which emits the `llm_attempt` ledger event.
 *
 * NON-NEGOTIABLE: usage carries ONLY counts/metadata — never prompt, diff, or response bodies.
 *
 * The normalizer is TOLERANT: malformed/garbage input returns `null`, never throws.
 */

export interface LlmUsage {
  input_tokens: number;
  /**
   * The TOTAL billable output, whatever the engine's raw shape (review S3): Codex reports
   * `reasoning_output_tokens` disjointly and the normalizer folds it in; agy nests thinking
   * inside `output_tokens` and it is never re-added; the OpenAI-compat legs derive
   * `max(completion, total − prompt)`. Pricing reads this field alone.
   */
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd?: number;
  /**
   * Informational side channel. Reported by every engine that exposes reasoning separately (agy,
   * Codex); always already inside `output_tokens`. Never priced, never summed.
   */
  thinking_tokens?: number;
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
 * `reasoning_output_tokens` (reasoning is real output; Codex reports it DISJOINTLY, so it is folded
 * in here), and the same figure is surfaced as `thinking_tokens` for visibility, like agy's. Codex
 * reports no per-call cost → no cost_usd. Returns `null` if no usage event is found.
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
    cached_input_tokens: num(last.cached_input_tokens),
    thinking_tokens: num(last.reasoning_output_tokens)
  };
}

/**
 * Normalize the `usage` block of an `agy --output-format json` envelope into {@link LlmUsage}:
 * `{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`.
 *
 * `thinking_tokens` is deliberately NOT added to `output_tokens` — it is already INSIDE it.
 * Measured live 2026-09-06 across four probes, two with non-zero thinking:
 *
 * | model                  | input | output | thinking | total |
 * |------------------------|-------|--------|----------|-------|
 * | Gemini 3.8 Flash (Low) |  5281 |   1486 |        0 |  6767 |
 * | Gemini 3.1 Pro (High)  |  5590 |   1511 |      842 |  7101 |
 * | Gemini 3.8 Flash (High)|  5284 |   1353 |      905 |  6637 |
 *
 * `total_tokens == input_tokens + output_tokens` holds in every row, including the thinking ones —
 * so adding thinking would break agy's own identity and inflate output by 40–60% on any
 * thinking-enabled model. The design doc proposed the fold by analogy to `normalizeCodexUsage`,
 * but that analogy does not carry: Codex reports `reasoning_output_tokens` DISJOINTLY from
 * `output_tokens`, whereas agy (like OpenAI's `reasoning_tokens`) nests it. The default model
 * pins "Low", which reports zero thinking, so the fold was inert until someone pinned a
 * reasoning model — which `HOUGE_AGY_MODEL` openly invites.
 *
 * `cache_read_tokens` maps to `cached_input_tokens`. `total_tokens` is ignored: every consumer
 * wants the components, and the identity above makes it redundant.
 *
 * Returns `null` when no usable usage object is present. Never throws.
 */
export function normalizeAgyUsage(raw: unknown): LlmUsage | null {
  const usage = asObject(raw);
  if (!usage) return null;
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return null;
  return {
    input_tokens: num(usage.input_tokens),
    output_tokens: num(usage.output_tokens),
    cached_input_tokens: num(usage.cache_read_tokens),
    thinking_tokens: num(usage.thinking_tokens)
  };
}
