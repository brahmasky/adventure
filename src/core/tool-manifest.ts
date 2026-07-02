import type { RiskLevel, SideEffectLevel } from "../domain/types.js";

/**
 * The per-tool descriptor registry for the inner loop (ADR 0013, step ⓪·1). Each entry
 * carries the one-line description + input-schema sketch rendered into the loop prompt,
 * plus the registration metadata the worker uses to bind the adapter (category /
 * side-effect / risk / output cap; the worker supplies `execute` and `timeout_ms`).
 *
 * The manifest is DERIVED from the compiled contract's `allowed_actions` (intersection
 * with the descriptors that exist), so the contract stays the envelope: a capability the
 * contract does not allow never reaches the model's menu, and a descriptor with no
 * contract entry is inert.
 */
export interface ToolManifestEntry {
  name: string;
  /** One line shown to the model in the loop prompt. */
  description: string;
  /** Input-schema sketch shown to the model (JSON shape, not a validator). */
  inputSketch: string;
  category: "tool";
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  output_limit_bytes: number;
}

const DESCRIPTORS: Record<string, ToolManifestEntry> = {
  llm_answer: {
    name: "llm_answer",
    description: "Answer from your own knowledge (one LLM call; no live data).",
    inputSketch: '{"question": "<the question, with any context it needs>"}',
    category: "tool",
    side_effect_level: "external_read",
    risk_level: "low",
    output_limit_bytes: 100_000
  },
  web_search: {
    name: "web_search",
    description: "Search the live web; returns titles, URLs and content snippets (untrusted data).",
    inputSketch: '{"query": "<focused search query>"}',
    category: "tool",
    side_effect_level: "external_read",
    risk_level: "low",
    output_limit_bytes: 200_000
  },
  // Lesson persistence is the same distill → deterministic-backstop → append flow as the
  // legacy feedback branch (never a raw write): the adapter decides durability itself, so
  // a non-generalizing "lesson" is silently a no-op. Internal memory, not a gated write.
  // TRUST-ANCHORED: the distilled text is always the turn's REAL user message + real
  // prior assistant turn — the model chooses only WHEN to invoke it and the scope.
  lesson_write: {
    name: "lesson_write",
    description:
      "Distill the user's CURRENT message into a durable lesson and save it (ignored when it does not generalize).",
    inputSketch: '{"scope": "ask"|"research"}',
    category: "tool",
    side_effect_level: "none",
    risk_level: "low",
    output_limit_bytes: 100_000
  }
};

/** Derive the loop manifest: allowed_actions ∩ descriptors, in allowed_actions order. */
export function manifestFor(allowed_actions: string[]): ToolManifestEntry[] {
  return allowed_actions.flatMap((name) => {
    const entry = DESCRIPTORS[name];
    return entry ? [entry] : [];
  });
}

/** Render the manifest's tool lines for the loop prompt (protocol lines are the loop's). */
export function renderManifestLines(entries: ToolManifestEntry[]): string[] {
  return entries.map((e) => `- ${e.name}: ${e.description} Input: ${e.inputSketch}`);
}
