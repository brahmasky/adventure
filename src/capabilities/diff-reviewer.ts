import { execFileSync } from "node:child_process";
import { resolveCodexBin, resolveCodexTimeoutMs } from "./coding-agent.js";

/**
 * Independent diff reviewer (Phase 3, checker 3 — ADR 0011 §7 / spec
 * docs/superpowers/specs/2026-06-25-phase3-code-self-write.md).
 *
 * The semantic / adversarial check tests can't give: "passes the test gate but wrong / hacky
 * / scope-creep / doesn't actually fix it." Writer ≠ checker by construction — the reviewer is
 * a DIFFERENT agent (Claude, model diversity) from the writer (Codex). Spike S0 result: GO on
 * the Claude CLI in print mode (`claude -p`), invoked by ABSOLUTE bin under the daemon's
 * restricted PATH (`claude` is NOT on that PATH). The Codex-session path is the no-Claude
 * fallback (independent fresh session + the same adversarial prompt → same verdict shape).
 *
 * Invocation pattern mirrors the validated spike (scripts/spike-claude-reviewer-p3.mjs).
 */

/** The daemon's launchd PATH (com.houge.daemon.plist). `claude` is NOT on it → absolute bin. */
const DAEMON_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_CLAUDE_TIMEOUT_MS = 120_000;
const REVIEW_MAX_BUFFER = 8 * 1024 * 1024;
/** Sentinel for an unset `HOUGE_CLAUDE_BIN` — the caller treats this as "reviewer disabled".
 *  We do NOT guess a bare `claude`; the daemon PATH lacks it (spike S0). */
export const CLAUDE_BIN_UNSET = "";

export type ReviewerKind = "claude" | "codex";

export interface ReviewVerdict {
  verdict: "pass" | "reject";
  fixes_task?: boolean;
  introduces_bugs?: boolean;
  scope_creep?: boolean;
  reasons?: string[];
}

export type ReviewResult = { ok: true; verdict: ReviewVerdict } | { ok: false; error: string };

/** Resolve which reviewer backs checker 3 (`HOUGE_SELFWRITE_REVIEWER`, default `claude`). */
export function resolveSelfWriteReviewer(env: NodeJS.ProcessEnv): ReviewerKind {
  const raw = env.HOUGE_SELFWRITE_REVIEWER?.trim().toLowerCase();
  return raw === "codex" ? "codex" : "claude";
}

/**
 * Resolve the Claude binary (`HOUGE_CLAUDE_BIN`). NO default guess of a bare `claude` — the
 * daemon's PATH lacks it (spike S0), so an absolute path is required. Unset → {@link
 * CLAUDE_BIN_UNSET} sentinel, which the caller treats as "Claude reviewer disabled."
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv): string {
  const bin = env.HOUGE_CLAUDE_BIN?.trim();
  return bin && bin.length > 0 ? bin : CLAUDE_BIN_UNSET;
}

/** Resolve the Claude reviewer wall-clock timeout in ms (`HOUGE_CLAUDE_TIMEOUT_MS`, default 120000). */
export function resolveClaudeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_CLAUDE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLAUDE_TIMEOUT_MS;
}

/**
 * The adversarial-review prompt (copied from the validated spike). An INDEPENDENT, skeptical
 * reviewer that must NOT rubber-stamp; output is ONLY the JSON verdict object.
 */
export function buildReviewPrompt(task: string, diff: string): string {
  return `You are an INDEPENDENT, adversarial code reviewer. Another agent wrote a diff to fix a task.
Your job is to find what is WRONG with it. Be skeptical. Do NOT rubber-stamp.

TASK THE DIFF CLAIMS TO FIX:
${task}

THE DIFF:
${diff}

Judge: does it actually fix the task? does it introduce bugs? is there scope creep or anything sneaky
(e.g. deleting/weakening a test to pass a gate)?

Respond with ONLY a JSON object, no prose, exactly this shape:
{"verdict":"pass"|"reject","fixes_task":true|false,"introduces_bugs":true|false,"scope_creep":true|false,"reasons":["..."]}`;
}

/**
 * Tolerant JSON extraction (copied from the spike). Takes the first `{...}` block; valid only
 * if `verdict` is `"pass"`|`"reject"`; otherwise `null` (garbage / missing-verdict / unparseable).
 */
export function parseVerdict(text: string | null | undefined): ReviewVerdict | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (o && (o.verdict === "pass" || o.verdict === "reject")) return o as ReviewVerdict;
  } catch {
    // unparseable → null
  }
  return null;
}

export interface ReviewDiffInput {
  task: string;
  diff: string;
  /** Injectable env for config resolution + spawn env (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

interface NodeError extends Error {
  code?: string;
  signal?: string | null;
  stdout?: Buffer | string | null;
}

/**
 * Run checker 3: dispatch to the configured reviewer (`HOUGE_SELFWRITE_REVIEWER`) and return
 * a parsed verdict. Never throws — a spawn error / unparseable output maps to `{ ok:false }`.
 */
export function reviewDiff(input: ReviewDiffInput): ReviewResult {
  const env = input.env ?? process.env;
  const reviewer = resolveSelfWriteReviewer(env);
  return reviewer === "codex"
    ? reviewViaCodex(input.task, input.diff, env)
    : reviewViaClaude(input.task, input.diff, env);
}

/** Path A (spike GO): Claude CLI in print mode, absolute bin, under the daemon's PATH. */
function reviewViaClaude(task: string, diff: string, env: NodeJS.ProcessEnv): ReviewResult {
  const bin = resolveClaudeBin(env);
  if (bin === CLAUDE_BIN_UNSET) {
    return { ok: false, error: "Claude reviewer disabled: set HOUGE_CLAUDE_BIN to the absolute claude path" };
  }
  const timeout = resolveClaudeTimeoutMs(env);
  const prompt = buildReviewPrompt(task, diff);

  let raw: string;
  try {
    raw = execFileSync(bin, ["-p"], {
      input: prompt,
      encoding: "utf8",
      timeout,
      maxBuffer: REVIEW_MAX_BUFFER,
      // Replicate the daemon's environment: restricted PATH (claude is NOT on it → absolute bin).
      env: { ...env, PATH: DAEMON_PATH }
    });
  } catch (error) {
    const err = error as NodeError;
    if (err.code === "ENOENT") {
      return { ok: false, error: `Claude reviewer binary not found: ${bin} (set HOUGE_CLAUDE_BIN)` };
    }
    if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
      return { ok: false, error: `Claude reviewer timed out after ${timeout}ms` };
    }
    return { ok: false, error: `Claude reviewer failed: ${errorMessage(error)}` };
  }

  const verdict = parseVerdict(raw);
  if (!verdict) {
    return { ok: false, error: "Claude reviewer returned an unparseable verdict" };
  }
  return { ok: true, verdict };
}

/**
 * Path NO-GO fallback (spike S0): an INDEPENDENT Codex session as checker 3 — fresh `codex exec
 * --sandbox read-only` consult with the same adversarial prompt (writer≠checker preserved; no
 * new infra). Read-only: the reviewer only judges the diff, it never writes. Reuses the shared
 * Codex resolvers; runs in `cwd` (no `-C`/worktree needed — the diff is in the prompt).
 */
function reviewViaCodex(task: string, diff: string, env: NodeJS.ProcessEnv): ReviewResult {
  const bin = resolveCodexBin(env);
  const timeout = resolveCodexTimeoutMs(env);
  const prompt = buildReviewPrompt(task, diff);

  let raw: string;
  try {
    raw = execFileSync(bin, ["exec", "--sandbox", "read-only", "-"], {
      input: prompt,
      encoding: "utf8",
      timeout,
      maxBuffer: REVIEW_MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    const err = error as NodeError;
    if (err.code === "ENOENT") {
      return { ok: false, error: `Codex reviewer binary not found: ${bin} (set HOUGE_CODEX_BIN)` };
    }
    if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
      return { ok: false, error: `Codex reviewer timed out after ${timeout}ms` };
    }
    return { ok: false, error: `Codex reviewer failed: ${errorMessage(error)}` };
  }

  const verdict = parseVerdict(raw);
  if (!verdict) {
    return { ok: false, error: "Codex reviewer returned an unparseable verdict" };
  }
  return { ok: true, verdict };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
