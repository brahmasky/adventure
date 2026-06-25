import { execFileSync } from "node:child_process";
import { createSelfWriteCodexAdapter, resolveCodexModel } from "./coding-agent.js";

/**
 * `SelfWriter` abstraction (Phase 3.1 — per-role writer flag; spec
 * docs/superpowers/specs/2026-06-25-phase3-code-self-write.md "Phase 3.1").
 *
 * The self-write WRITER was hardcoded to Codex. Paco wants the heavy writer load to sit on
 * whichever subscription is largest, so the writer becomes swappable (`HOUGE_SELFWRITE_WRITER`,
 * codex|claude) behind one clean abstraction. Both impls edit files in the SAME throwaway
 * worktree (the caller owns it so the diff outlives this call for the checker stack); neither
 * creates/tears it down. The deterministic guard checks the DIFF, not who wrote it, so swapping
 * the writer cannot widen what may land.
 *
 *   - **Codex** (`--sandbox workspace-write`, existing): reuses `createSelfWriteCodexAdapter`,
 *     now with `--json` so the JSONL token-count stream is captured as `usageRaw`.
 *   - **Claude** (validated spike, scripts/spike-claude-writer-p3.mjs):
 *     `claude -p --model <m> --permission-mode bypassPermissions --output-format json`,
 *     `cwd: <worktree>`, absolute `HOUGE_CLAUDE_BIN`, under the daemon's restricted PATH. The
 *     `--output-format json` envelope (carries `usage` + `total_cost_usd`) is returned as
 *     `usageRaw`.
 *
 * Each writer returns its RAW provider usage output (`usageRaw`); the integrator (W3) normalizes
 * it via the telemetry helpers — this module does NOT normalize.
 */

/** The daemon's launchd PATH (com.houge.daemon.plist). `claude` is NOT on it → absolute bin. */
const DAEMON_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
// A WRITE is a deep agentic task (explore the codebase, make a multi-file fix) — far slower than a
// review. The live gate showed a real multi-file fix exceeding 180s. The writer gets a generous ceiling
// via its OWN var (not the reviewer's HOUGE_CLAUDE_TIMEOUT_MS), matching the codex writer's magnitude.
const DEFAULT_CLAUDE_WRITER_TIMEOUT_MS = 600_000;
const DEFAULT_CLAUDE_WRITER_MODEL = "sonnet"; // fast, strong; the spike model
const WRITER_MAX_BUFFER = 32 * 1024 * 1024; // agentic edits can stream a large JSON envelope
/** Sentinel for an unset `HOUGE_CLAUDE_BIN` — the caller treats this as "claude writer disabled".
 *  We do NOT guess a bare `claude`; the daemon PATH lacks it (spike S0). */
const CLAUDE_BIN_UNSET = "";

export type WriterKind = "codex" | "claude";

/** Resolve which engine plays the self-write WRITER (`HOUGE_SELFWRITE_WRITER`, default `codex`). */
export function resolveSelfWriteWriter(env: NodeJS.ProcessEnv): WriterKind {
  const raw = env.HOUGE_SELFWRITE_WRITER?.trim().toLowerCase();
  return raw === "claude" ? "claude" : "codex";
}

/**
 * Resolve the Claude WRITER model: `HOUGE_CLAUDE_WRITER_MODEL`, falling back to the shared
 * `HOUGE_CLAUDE_MODEL`, then default `sonnet`. (The reviewer's model resolver lives in
 * diff-reviewer.ts — this is the writer's per-role override only.)
 */
export function resolveClaudeWriterModel(env: NodeJS.ProcessEnv): string {
  const writerModel = env.HOUGE_CLAUDE_WRITER_MODEL?.trim();
  if (writerModel && writerModel.length > 0) return writerModel;
  const shared = env.HOUGE_CLAUDE_MODEL?.trim();
  if (shared && shared.length > 0) return shared;
  return DEFAULT_CLAUDE_WRITER_MODEL;
}

/** Resolve the absolute Claude binary (`HOUGE_CLAUDE_BIN`). Unset → {@link CLAUDE_BIN_UNSET}
 *  sentinel ("claude writer disabled"); NO bare-`claude` guess (daemon PATH lacks it, spike S0). */
export function resolveClaudeWriterBin(env: NodeJS.ProcessEnv): string {
  const bin = env.HOUGE_CLAUDE_BIN?.trim();
  return bin && bin.length > 0 ? bin : CLAUDE_BIN_UNSET;
}

/** Resolve the Claude writer wall-clock timeout in ms (`HOUGE_CLAUDE_WRITER_TIMEOUT_MS`, default 600000 —
 *  agentic write is far slower than review; this is the writer's OWN ceiling, not the reviewer's). */
export function resolveClaudeWriterTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_CLAUDE_WRITER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLAUDE_WRITER_TIMEOUT_MS;
}

/**
 * Build the Claude writer argv (the validated spike pattern, mirrored EXACTLY):
 * `-p --model <m> --permission-mode bypassPermissions --output-format json`. The task is fed on
 * stdin and `cwd` is the worktree, so `bypassPermissions` is scoped to that throwaway tree.
 * Exported so a test can assert the exact argv.
 */
export function buildClaudeWriteArgs(model: string): string[] {
  return ["-p", "--model", model, "--permission-mode", "bypassPermissions", "--output-format", "json"];
}

export interface RunSelfWriterInput {
  /** Which engine writes (`codex` | `claude`). Caller resolves via {@link resolveSelfWriteWriter}. */
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
 * (codex: the `--json` JSONL stdout; claude: the `--output-format json` envelope string). W3
 * normalizes it via the telemetry helpers — this module does NOT.
 */
export type RunSelfWriterResult =
  | { ok: true; provider: WriterKind; model: string; usageRaw: string }
  | { ok: false; error: string };

interface NodeError extends Error {
  code?: string;
  signal?: string | null;
  stdout?: Buffer | string | null;
}

/**
 * Run the self-write WRITER, dispatching by `writer`. Never throws — a disabled writer / spawn
 * error / timeout / writer-side error maps to `{ ok:false, error }`. The artifact is the edited
 * files in `worktree`; the return carries `usageRaw` for telemetry.
 */
export function runSelfWriter(input: RunSelfWriterInput): RunSelfWriterResult {
  const env = input.env ?? process.env;
  if (typeof input.task !== "string" || input.task.trim().length === 0) {
    return { ok: false, error: "task must be a non-empty string" };
  }
  return input.writer === "claude"
    ? writeViaClaude(input.worktree, input.task, env)
    : writeViaCodex(input.worktree, input.task, env);
}

/** Codex writer (existing path): reuse the workspace-write adapter; surface its `usageRaw`. */
function writeViaCodex(worktree: string, task: string, env: NodeJS.ProcessEnv): RunSelfWriterResult {
  const adapter = createSelfWriteCodexAdapter({ worktree, env });
  const result = adapter({ task });
  if (!result.ok) return { ok: false, error: result.error };
  const out = result.output as { model?: unknown; usageRaw?: unknown };
  const model = resolveCodexModel(env) ?? (typeof out.model === "string" ? out.model : "default");
  const usageRaw = typeof out.usageRaw === "string" ? out.usageRaw : "";
  return { ok: true, provider: "codex", model, usageRaw };
}

/** Claude writer (validated spike): headless agentic edit, permission bypass scoped to the worktree. */
function writeViaClaude(worktree: string, task: string, env: NodeJS.ProcessEnv): RunSelfWriterResult {
  const bin = resolveClaudeWriterBin(env);
  if (bin === CLAUDE_BIN_UNSET) {
    return { ok: false, error: "claude writer disabled: set HOUGE_CLAUDE_BIN" };
  }
  const model = resolveClaudeWriterModel(env);
  const timeout = resolveClaudeWriterTimeoutMs(env);

  let usageRaw: string;
  try {
    usageRaw = execFileSync(bin, buildClaudeWriteArgs(model), {
      input: task,
      cwd: worktree,
      encoding: "utf8",
      timeout,
      maxBuffer: WRITER_MAX_BUFFER,
      // Replicate the daemon's environment: restricted PATH (claude is NOT on it → absolute bin).
      env: { ...env, PATH: DAEMON_PATH }
    });
  } catch (error) {
    const err = error as NodeError;
    if (err.code === "ENOENT") {
      return { ok: false, error: `claude writer binary not found: ${bin} (set HOUGE_CLAUDE_BIN)` };
    }
    if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
      return { ok: false, error: `claude writer timed out after ${timeout}ms` };
    }
    // Some claude versions still print the JSON envelope to stdout on a non-zero exit — keep it if so.
    const stdout = err.stdout?.toString() ?? "";
    if (stdout.trim().length > 0) {
      const verdict = inspectEnvelope(stdout);
      if (verdict.ok) return { ok: true, provider: "claude", model, usageRaw: stdout };
      return { ok: false, error: verdict.error };
    }
    return { ok: false, error: `claude writer failed: ${errorMessage(error)}` };
  }

  const verdict = inspectEnvelope(usageRaw);
  if (!verdict.ok) return { ok: false, error: verdict.error };
  return { ok: true, provider: "claude", model, usageRaw };
}

/** Inspect the `--output-format json` envelope. `is_error: true` → a writer-side failure. */
function inspectEnvelope(raw: string): { ok: true } | { ok: false; error: string } {
  let env: { is_error?: unknown };
  try {
    env = JSON.parse(raw) as { is_error?: unknown };
  } catch {
    return { ok: false, error: "claude writer returned an unparseable JSON envelope" };
  }
  if (env.is_error === true) {
    return { ok: false, error: "claude writer reported is_error in its envelope" };
  }
  return { ok: true };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
