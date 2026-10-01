import type { RiskLevel, SideEffectLevel } from "../domain/types.js";
import { KILLED_TEXT, PLANNER_EXIT_TEXT, TIMEOUT_TEXT } from "../omp/planner-supervisor.js";
import type { PlannerFailure } from "../run/run-store.js";

export interface OmpToolMeta { side_effect_level: SideEffectLevel; risk_level: RiskLevel; output_limit_bytes: number }

/**
 * The fifteen Houge loop-tool entries (fourteen tools; memory_correct is two entries) the planner reaches over the bridge, with the registration metadata
 * the deleted src/core/tool-manifest.ts gave them (copied here before Task 14 deleted it). The
 * timeout per tool stays `loopToolTimeoutMs` in core-worker.ts.
 */
export const OMP_LOOP_TOOL_META: Readonly<Record<string, OmpToolMeta>> = Object.freeze({
  web_search: { side_effect_level: "external_read", risk_level: "low", output_limit_bytes: 200_000 },
  http_fetch: { side_effect_level: "external_read", risk_level: "low", output_limit_bytes: 200_000 },
  to_local_time: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 100_000 },
  lesson_write: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 100_000 },
  schedule_task: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 100_000 },
  wiki_build: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 100_000 },
  wiki_refine: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 100_000 },
  self_diagnose: { side_effect_level: "external_read", risk_level: "medium", output_limit_bytes: 200_000 },
  self_write_propose: { side_effect_level: "external_read", risk_level: "medium", output_limit_bytes: 200_000 },
  skill_author: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 100_000 },
  gmail_read: { side_effect_level: "external_read", risk_level: "medium", output_limit_bytes: 200_000 },
  google_api: { side_effect_level: "external_read", risk_level: "medium", output_limit_bytes: 200_000 },
  // Read-only, Houge's own state only (never external content): not quarantined, never gated.
  houge_status: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 8_000 },
  // memory_correct search (2026-10-02): reads Houge's own memory, never gated.
  memory_correct: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 8_000 },
  // memory_correct retire/correct: reversible (Undo), but an edit to durable memory that a steered session could
  // make, so it rides the destructive class the turn contract gates: every write waits for Paco's tap.
  memory_correct_write: { side_effect_level: "destructive", risk_level: "high", output_limit_bytes: 8_000 }
});

/** bash, split by the command matcher: plain runs yolo (D5), the other two are approval-gated by the turn contract. */
export const OMP_SHELL_META: Readonly<Record<"shell" | "shell_external" | "shell_destructive", OmpToolMeta>> = Object.freeze({
  shell: { side_effect_level: "local_write", risk_level: "low", output_limit_bytes: 64_000 },
  shell_external: { side_effect_level: "external_write", risk_level: "medium", output_limit_bytes: 64_000 },
  shell_destructive: { side_effect_level: "destructive", risk_level: "high", output_limit_bytes: 64_000 }
});

/** The omp built-ins: gated by the bridge `gate` path, never executed through the registry. */
export const OMP_BUILTIN_META: Readonly<Record<"fs_read" | "fs_write", OmpToolMeta>> = Object.freeze({
  fs_read: { side_effect_level: "none", risk_level: "low", output_limit_bytes: 0 },
  fs_write: { side_effect_level: "local_write", risk_level: "low", output_limit_bytes: 0 }
});

/** Code-owned replies. Exported so tests assert against them, never literals. */
export const EMPTY_REPLY_TEXT = "(I finished that turn without any reply text.)";
/** A turn that reached executeRun instead of a planner supervisor (the inner loop is gone): the run fails with this. */
export const TURN_OUTSIDE_PLANNER_ERROR = "turns run only on the planner runtime; this path no longer executes them";
export const TURN_UNAVAILABLE_TEXT = "⚠ I can't run turns right now: my runtime failed its startup check. Paco has been alerted.";
/** The chat's planner crashed repeatedly and is latched (spec §7): it stays down until the next sweep or /rearm. */
export const PLANNER_CRASH_LOOP_TEXT = "⚠ My runtime keeps crashing, so I stopped restarting it. Send /rearm to try again (the next sweep also re-arms it).";
/** abortAll("guard"): the telegram --once runner's bound ran out (there is no /guard command); not Paco's /kill. */
export const GUARD_STOPPED_TEXT = "⏹ Stopped: this one-shot poll ran out of time before the turn finished.";
/** Supervisor preflight refs: a startup check failed, the runtime did not crash. */
const STARTUP_CHECK_REF = /^(omp_version_mismatch|omp_unavailable|wrapper_mismatch|sandbox_unavailable)\b/;

/** The terminal failure notice for a failed run (the same text the old turn path sent). */
export function failureNotifyText(detail: string): string {
  return `I hit an error on that one: ${detail}`;
}

/** What Paco reads when a planner turn fails; null = send nothing (a merged run: the parent replies). */
export function plannerFailureText(type: PlannerFailure, ref: string, partial?: string): string | null {
  switch (type) {
    case "merged_parent_failed":
      return null;
    case "killed":
      return ref === "guard" ? GUARD_STOPPED_TEXT : KILLED_TEXT;
    case "turn_timeout":
    case "frame_idle":
      return partial ? `${TIMEOUT_TEXT}\n\n${partial}` : TIMEOUT_TEXT;
    case "lease_expired": // the owner stopped renewing: a crash or a hung daemon (B1)
      return PLANNER_EXIT_TEXT;
    case "planner_exit":
      if (ref === "crash_loop") return PLANNER_CRASH_LOOP_TEXT;
      return STARTUP_CHECK_REF.test(ref) ? TURN_UNAVAILABLE_TEXT : PLANNER_EXIT_TEXT;
    default:
      return failureNotifyText(ref);
  }
}
