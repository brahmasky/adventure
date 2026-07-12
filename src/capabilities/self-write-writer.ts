import { createSelfWriteCodexAdapter, resolveCodexModel } from "./coding-agent.js";

/**
 * `SelfWriter` abstraction (Phase 3.1 — per-role writer flag; spec
 * docs/superpowers/specs/2026-06-25-phase3-code-self-write.md "Phase 3.1").
 *
 * Codex is the runtime's only writer backend (Claude was removed from the runtime — it is the
 * build-orchestrator seat, never a runtime dependency). The writer edits files in a caller-owned
 * throwaway worktree (the diff outlives this call for the checker stack); it never creates/tears
 * it down. The deterministic guard checks the DIFF, not who wrote it.
 *
 *   - **Codex** (`--sandbox workspace-write`): reuses `createSelfWriteCodexAdapter`, with
 *     `--json` so the JSONL token-count stream is captured as `usageRaw`.
 *
 * The writer returns its RAW provider usage output (`usageRaw`); the integrator (W3) normalizes
 * it via the telemetry helpers — this module does NOT normalize.
 */

export type WriterKind = "codex";

/**
 * Resolve which engine plays the self-write WRITER (`HOUGE_SELFWRITE_WRITER`). Codex is the only
 * backend — any other value (including a stale `claude` left in an old .env) falls back to codex,
 * the long-standing unknown-value behavior (graceful degradation, never a crash).
 */
export function resolveSelfWriteWriter(_env: NodeJS.ProcessEnv): WriterKind {
  return "codex";
}

export interface RunSelfWriterInput {
  /** Which engine writes (`codex`). Caller resolves via {@link resolveSelfWriteWriter}. */
  writer: WriterKind;
  /** The throwaway worktree the diff is written into. Created/torn-down by the orchestrator. */
  worktree: string;
  /** The framed write task (the DATA channel). */
  task: string;
  /** Injectable env for config resolution + spawn env (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Result of a self-write run. On success, `usageRaw` is the writer's RAW provider usage output
 * (codex: the `--json` JSONL stdout). W3 normalizes it via the telemetry helpers — this module
 * does NOT.
 */
export type RunSelfWriterResult =
  | { ok: true; provider: WriterKind; model: string; usageRaw: string }
  | { ok: false; error: string };

/**
 * Run the self-write WRITER. Never throws — a spawn error / timeout / writer-side error maps to
 * `{ ok:false, error }`. The artifact is the edited files in `worktree`; the return carries
 * `usageRaw` for telemetry.
 */
export async function runSelfWriter(input: RunSelfWriterInput): Promise<RunSelfWriterResult> {
  const env = input.env ?? process.env;
  if (typeof input.task !== "string" || input.task.trim().length === 0) {
    return { ok: false, error: "task must be a non-empty string" };
  }
  return writeViaCodex(input.worktree, input.task, env);
}

/** Codex writer: reuse the workspace-write adapter; surface its `usageRaw`. */
async function writeViaCodex(worktree: string, task: string, env: NodeJS.ProcessEnv): Promise<RunSelfWriterResult> {
  const adapter = createSelfWriteCodexAdapter({ worktree, env });
  const result = await adapter({ task });
  if (!result.ok) return { ok: false, error: result.error };
  const out = result.output as { model?: unknown; usageRaw?: unknown };
  const model = resolveCodexModel(env) ?? (typeof out.model === "string" ? out.model : "default");
  const usageRaw = typeof out.usageRaw === "string" ? out.usageRaw : "";
  return { ok: true, provider: "codex", model, usageRaw };
}
