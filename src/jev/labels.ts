import { parseIntent, type Intent } from "../capabilities/intent.js";

/** Label helpers shared by the replay and the live shadow (Jev spec 2026-09-25). */
export type ObservedAction = "selfcode" | "skill" | "research" | "answer" | "unknown";

const INTENT_IN_JSON = /"intent"\s*:\s*"\s*(answer|research|feedback|clarify|selfcode|skill)\s*"/i;

export function observedAction(capabilities: string[]): ObservedAction {
  const has = (...names: string[]) => names.some((n) => capabilities.includes(n));
  if (has("self_diagnose", "self_write_propose")) return "selfcode";
  if (has("skill_author")) return "skill";
  if (has("web_search", "http_fetch")) return "research";
  return capabilities.length === 0 ? "answer" : "unknown";
}

/**
 * parseIntent defaults to "answer" on garbage — including JSON that has a well-formed `"intent"`
 * field but is otherwise broken (e.g. a trailing `undefined` literal), where a naive regex probe
 * would still "see" the field. `parsed` is true only when the regex-captured intent agrees with
 * what parseIntent actually read, so a malformed reply can never enter the GO/STOP gate under a
 * label the model didn't really produce.
 */
export function llmLabel(raw: string): { intent: Intent; parsed: boolean } {
  const intent = parseIntent(raw).intent;
  const captured = raw.match(INTENT_IN_JSON)?.[1]?.trim().toLowerCase();
  return { intent, parsed: captured === intent };
}
