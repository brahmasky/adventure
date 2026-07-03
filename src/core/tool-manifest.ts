import { resolveCodexEnabled } from "../capabilities/coding-agent.js";
import { resolveSelfWriteEnabled } from "../capabilities/intent.js";
import { resolveSkillsEnabled } from "../skills/skill-store.js";
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
 *
 * ARMING (step ⓪·2): an evolution tool additionally carries its env arming check —
 * disarmed ⇒ unlisted ⇒ undescribed ⇒ unreachable (the loop registry only registers
 * manifest entries, so an unlisted name is denied as an unknown capability).
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

/** A descriptor plus its optional env arming check (never rendered to the model). */
type ToolDescriptor = ToolManifestEntry & { armed?: (env: NodeJS.ProcessEnv) => boolean };

const DESCRIPTORS: Record<string, ToolDescriptor> = {
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
  },
  // The evolution layers as loop tools (ADR 0013, step ⓪·2). Each is a THIN boundary
  // around the unchanged legacy pipeline: inside, the machinery runs under its own
  // stricter sub-contract and gates exactly as before. The model's input is advisory —
  // the REAL user message stays the primary instruction (the lesson_write philosophy).
  self_diagnose: {
    name: "self_diagnose",
    description:
      "Diagnose Houge's OWN source code READ-ONLY: a coding agent reads the committed code and reports the root cause of the user's symptom.",
    inputSketch: '{"focus": "one line: what to investigate"}',
    category: "tool",
    side_effect_level: "external_read",
    risk_level: "medium",
    output_limit_bytes: 200_000,
    armed: resolveCodexEnabled
  },
  self_write_propose: {
    name: "self_write_propose",
    description:
      "Propose a FIX to Houge's OWN source code: an isolated writer produces a diff, gates check it (protected paths, tests, independent review), and a branch is published for the user to merge. Terminal — after this, wrap up with \"final\".",
    inputSketch: '{"focus": "one line: what to fix"}',
    category: "tool",
    side_effect_level: "external_read",
    risk_level: "medium",
    output_limit_bytes: 200_000,
    armed: resolveSelfWriteEnabled
  },
  skill_author: {
    name: "skill_author",
    description:
      "Author or refine a reusable SKILL (a verified procedure) from the user's request; may down-route to a lesson. Terminal — after this, wrap up with \"final\".",
    inputSketch: "{}",
    category: "tool",
    side_effect_level: "none",
    risk_level: "low",
    output_limit_bytes: 100_000,
    armed: resolveSkillsEnabled
  }
};

/** Derive the loop manifest: allowed_actions ∩ armed descriptors, in allowed_actions order. */
export function manifestFor(allowed_actions: string[], env: NodeJS.ProcessEnv = process.env): ToolManifestEntry[] {
  return allowed_actions.flatMap((name) => {
    const entry = DESCRIPTORS[name];
    if (!entry || (entry.armed && !entry.armed(env))) return [];
    const { armed, ...manifest } = entry;
    void armed;
    return [manifest];
  });
}

/** Render the manifest's tool lines for the loop prompt (protocol lines are the loop's). */
export function renderManifestLines(entries: ToolManifestEntry[]): string[] {
  return entries.map((e) => `- ${e.name}: ${e.description} Input: ${e.inputSketch}`);
}
