import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileAsync } from "../run/exec-file-async.js";
import { resolveCodexBin, resolveCodexEnabled, resolveCodexTimeoutMs } from "./coding-agent.js";
import { normalizeClaudeUsage, normalizeCodexUsage, type LlmUsage } from "../run/llm-usage.js";

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
const DEFAULT_CLAUDE_TIMEOUT_MS = 180_000; // per-attempt ceiling; a normal sonnet review returns in ~20s
const DEFAULT_CLAUDE_MODEL = "sonnet"; // fast, strong reviewer; the default (Opus) over-thinks a large diff and times out
const CLAUDE_REVIEW_ATTEMPTS = 2; // retry once on a transient timeout/unparseable (CLI throttle/cold-start)
const REVIEW_MAX_BUFFER = 8 * 1024 * 1024;
/** Sentinel for an unset `HOUGE_CLAUDE_BIN` — the caller treats this as "reviewer disabled".
 *  We do NOT guess a bare `claude`; the daemon PATH lacks it (spike S0). */
export const CLAUDE_BIN_UNSET = "";

const DEFAULT_KIMI_CLI_TIMEOUT_MS = 180_000; // per-attempt ceiling; a normal kimi review returns in ~7s
const KIMI_REVIEW_ATTEMPTS = 2; // retry once on a transient timeout/unparseable (same fail-safe as Claude)
/** Sentinel for an unset `HOUGE_KIMI_CLI_BIN` — the caller treats this as "reviewer disabled".
 *  We do NOT guess a bare `kimi-cli`; the daemon PATH lacks it. */
export const KIMI_CLI_BIN_UNSET = "";

export type ReviewerKind = "claude" | "codex" | "kimi";

export interface ReviewVerdict {
  verdict: "pass" | "reject";
  fixes_task?: boolean;
  introduces_bugs?: boolean;
  scope_creep?: boolean;
  reasons?: string[];
}

export type ReviewResult =
  | { ok: true; verdict: ReviewVerdict; usage?: LlmUsage; reviewer?: ReviewerKind }
  | { ok: false; error: string };

/** Resolve which reviewer backs checker 3 (`HOUGE_SELFWRITE_REVIEWER`, default `kimi` — cheap +
 *  model-diverse from the Codex writer; the free test-gate + Paco's merge are the real safety net). */
export function resolveSelfWriteReviewer(env: NodeJS.ProcessEnv): ReviewerKind {
  const raw = env.HOUGE_SELFWRITE_REVIEWER?.trim().toLowerCase();
  if (raw === "claude") return "claude";
  if (raw === "codex") return "codex";
  return "kimi";
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

/** Resolve the Claude reviewer wall-clock timeout in ms (`HOUGE_CLAUDE_TIMEOUT_MS`, default 180000 per attempt). */
export function resolveClaudeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_CLAUDE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLAUDE_TIMEOUT_MS;
}

/** Resolve the Claude reviewer model (`HOUGE_CLAUDE_MODEL`, default "sonnet" — fast single-shot review). */
export function resolveClaudeModel(env: NodeJS.ProcessEnv): string {
  const m = env.HOUGE_CLAUDE_MODEL?.trim();
  return m && m.length > 0 ? m : DEFAULT_CLAUDE_MODEL;
}

/**
 * Resolve the kimi-cli binary (`HOUGE_KIMI_CLI_BIN`). NO default guess of a bare `kimi-cli` — the
 * daemon's PATH lacks it (it lives in `~/.local/bin`), so an absolute path is required. Unset →
 * {@link KIMI_CLI_BIN_UNSET} sentinel, which the caller treats as "kimi reviewer disabled."
 */
export function resolveKimiCliBin(env: NodeJS.ProcessEnv): string {
  const bin = env.HOUGE_KIMI_CLI_BIN?.trim();
  return bin && bin.length > 0 ? bin : KIMI_CLI_BIN_UNSET;
}

/**
 * Resolve the optional kimi-cli reviewer model (`HOUGE_KIMI_CLI_MODEL`). When set, it is passed as
 * `--model <m>`; when unset, returns "" and we OMIT `--model`, deferring to kimi-cli's own configured
 * default (`kimi-for-coding`).
 */
export function resolveKimiCliModel(env: NodeJS.ProcessEnv): string {
  const m = env.HOUGE_KIMI_CLI_MODEL?.trim();
  return m && m.length > 0 ? m : "";
}

/** Resolve the kimi-cli reviewer wall-clock timeout in ms (`HOUGE_KIMI_CLI_TIMEOUT_MS`, default 180000 per attempt). */
export function resolveKimiCliTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_KIMI_CLI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_KIMI_CLI_TIMEOUT_MS;
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

End your reply with ONLY the JSON object on its own, as the LAST thing in your response, exactly this shape:
{"verdict":"pass"|"reject","fixes_task":true|false,"introduces_bugs":true|false,"scope_creep":true|false,"reasons":["..."]}`;
}

/**
 * Tolerant verdict extraction. The reviewer may wrap the JSON in prose or markdown fences, and
 * its reasoning can contain stray `{`/`}` (e.g. quoted code) — so a greedy first-`{`-to-last-`}`
 * match is unsafe (it broke live on a real diff). Instead, scan for every balanced top-level
 * `{...}` object (string-aware, so braces inside JSON strings don't count) and take the LAST one
 * that parses AND carries a valid `verdict` (the prompt emits the verdict object last). Verdict is
 * matched case-insensitively. `null` = no valid verdict found (garbage / missing / unparseable).
 */
export function parseVerdict(text: string | null | undefined): ReviewVerdict | null {
  if (!text) return null;
  const candidates = extractBalancedObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(candidates[i]!) as { verdict?: unknown };
      const v = typeof o.verdict === "string" ? o.verdict.trim().toLowerCase() : "";
      if (v === "pass" || v === "reject") {
        return { ...(o as Record<string, unknown>), verdict: v } as unknown as ReviewVerdict;
      }
    } catch {
      // not valid JSON → try the next candidate
    }
  }
  return null;
}

/** Extract balanced top-level `{...}` substrings, ignoring braces inside JSON string literals. */
function extractBalancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}" && depth > 0 && --depth === 0 && start >= 0) {
      out.push(text.slice(start, i + 1));
      start = -1;
    }
  }
  return out;
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

/** Fixed fallback order (H1): the configured reviewer first, then the rest of this list. */
const REVIEWER_FALLBACK_ORDER: ReviewerKind[] = ["kimi", "claude", "codex"];

/**
 * Run checker 3 (H1: fallback chain). The configured reviewer (`HOUGE_SELFWRITE_REVIEWER`) runs
 * first; if it is UNAVAILABLE (timeout / spawn failure / unparseable transport — never a delivered
 * verdict), the remaining backends are tried in [kimi, claude, codex] order. A DELIVERED verdict
 * (pass OR reject) from any backend ends the chain — reject is a real answer, never fallen past.
 * Unconfigured fallback backends are skipped (never errored on); the whole chain unavailable maps
 * to `{ ok:false }` with every backend's detail, exactly the pre-chain failure semantics. The
 * winning backend rides out as `reviewer` so the ledger can attribute the verdict.
 * Never throws.
 */
export async function reviewDiff(input: ReviewDiffInput): Promise<ReviewResult> {
  const env = input.env ?? process.env;
  const configured = resolveSelfWriteReviewer(env);
  const chain = [configured, ...REVIEWER_FALLBACK_ORDER.filter((k) => k !== configured)];
  const details: string[] = [];
  for (const [i, backend] of chain.entries()) {
    // Fallbacks must be configured/enabled to be tried; the CONFIGURED reviewer always runs
    // (preserving its own "disabled: set HOUGE_..." error when it is misconfigured).
    if (i > 0 && !reviewerConfigured(backend, env)) {
      details.push(`${backend} reviewer skipped (not configured)`);
      continue;
    }
    const result = await runReviewer(backend, input.task, input.diff, env);
    if (result.ok) return { ...result, reviewer: backend };
    details.push(result.error);
  }
  return { ok: false, error: details.join("; ") };
}

/** Whether a FALLBACK backend is armed at all (bin set / codex enabled). */
function reviewerConfigured(kind: ReviewerKind, env: NodeJS.ProcessEnv): boolean {
  switch (kind) {
    case "kimi":
      return resolveKimiCliBin(env) !== KIMI_CLI_BIN_UNSET;
    case "claude":
      return resolveClaudeBin(env) !== CLAUDE_BIN_UNSET;
    case "codex":
      return resolveCodexEnabled(env);
  }
}

function runReviewer(kind: ReviewerKind, task: string, diff: string, env: NodeJS.ProcessEnv): Promise<ReviewResult> {
  switch (kind) {
    case "codex":
      return reviewViaCodex(task, diff, env);
    case "kimi":
      return reviewViaKimiCli(task, diff, env);
    default:
      return reviewViaClaude(task, diff, env);
  }
}

/** Path A (spike GO): Claude CLI in print mode, absolute bin, under the daemon's PATH. */
async function reviewViaClaude(task: string, diff: string, env: NodeJS.ProcessEnv): Promise<ReviewResult> {
  const bin = resolveClaudeBin(env);
  if (bin === CLAUDE_BIN_UNSET) {
    return { ok: false, error: "Claude reviewer disabled: set HOUGE_CLAUDE_BIN to the absolute claude path" };
  }
  const timeout = resolveClaudeTimeoutMs(env);
  const model = resolveClaudeModel(env);
  const prompt = buildReviewPrompt(task, diff);

  // The Claude CLI can transiently hang (subscription throttle / cold start) and run out the clock,
  // even though the same review normally returns in ~20s. Retry a couple of times — a transient
  // timeout/unparseable on attempt 1 must not kill an otherwise-good fix. (A clean `reject` verdict
  // is NOT retried — that's a real answer.) Fail-safe: exhausting retries → not-published, never a
  // bad branch.
  let lastError = "Claude reviewer unavailable";
  for (let attempt = 1; attempt <= CLAUDE_REVIEW_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      // Fast, deterministic single-shot review: pin a fast model and DENY all tools — the diff is in
      // the prompt, so the reviewer needs no filesystem/Bash access (also prevents it exploring the
      // live tree and keeps it from over-running the timeout, the live-gate failure mode).
      // `--output-format json` wraps the model's text in an envelope that also carries token usage,
      // so a single call yields BOTH the verdict (envelope.result) and telemetry (envelope.usage).
      ({ stdout: raw } = await execFileAsync(bin, ["-p", "--model", model, "--output-format", "json", "--disallowed-tools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch"], {
        input: prompt,
        timeout,
        maxBuffer: REVIEW_MAX_BUFFER,
        // Replicate the daemon's environment: restricted PATH (claude is NOT on it → absolute bin).
        env: { ...env, PATH: DAEMON_PATH }
      }));
    } catch (error) {
      const err = error as NodeError;
      if (err.code === "ENOENT") {
        // A missing binary won't fix itself on retry — fail immediately.
        return { ok: false, error: `Claude reviewer binary not found: ${bin} (set HOUGE_CLAUDE_BIN)` };
      }
      lastError = (err.signal === "SIGTERM" || err.code === "ETIMEDOUT")
        ? `Claude reviewer timed out after ${timeout}ms`
        : `Claude reviewer failed: ${errorMessage(error)}`;
      continue; // transient — retry
    }

    // The model's text is the envelope's `result` field; usage rides the same envelope. We parse the
    // verdict from `result` (falling back to the raw stdout if the envelope is unexpected), and surface
    // normalized token usage when present.
    const usage = normalizeClaudeUsage(raw) ?? undefined;
    const verdict = parseVerdict(extractClaudeResultText(raw));
    if (verdict) return usage ? { ok: true, verdict, usage } : { ok: true, verdict };
    lastError = "Claude reviewer returned an unparseable verdict";
    // unparseable → retry (the model may have rambled); fall through to next attempt
  }
  return { ok: false, error: `${lastError} (after ${CLAUDE_REVIEW_ATTEMPTS} attempts)` };
}

/**
 * Path NO-GO fallback (spike S0): an INDEPENDENT Codex session as checker 3 — fresh `codex exec
 * --sandbox read-only` consult with the same adversarial prompt (writer≠checker preserved; no
 * new infra). Read-only: the reviewer only judges the diff, it never writes. Reuses the shared
 * Codex resolvers; runs in `cwd` (no `-C`/worktree needed — the diff is in the prompt).
 */
async function reviewViaCodex(task: string, diff: string, env: NodeJS.ProcessEnv): Promise<ReviewResult> {
  const bin = resolveCodexBin(env);
  const timeout = resolveCodexTimeoutMs(env);
  const prompt = buildReviewPrompt(task, diff);

  let raw: string;
  try {
    // `--json` streams a JSONL event log to stdout that carries `token_count` usage events
    // alongside the agent's message text — one call yields both the verdict and telemetry.
    ({ stdout: raw } = await execFileAsync(bin, ["exec", "--json", "--sandbox", "read-only", "-"], {
      input: prompt,
      timeout,
      maxBuffer: REVIEW_MAX_BUFFER
    }));
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

  // The verdict text is the agent's message inside the JSONL stream (escaped). Reconstruct that
  // text, then parse the verdict from it; also normalize the `token_count` usage for telemetry.
  const usage = normalizeCodexUsage(raw) ?? undefined;
  const verdict = parseVerdict(extractCodexAgentText(raw));
  if (!verdict) {
    return { ok: false, error: "Codex reviewer returned an unparseable verdict" };
  }
  return usage ? { ok: true, verdict, usage } : { ok: true, verdict };
}

/**
 * Path C: a THIRD reviewer backend — the local `kimi-cli` agent in headless print mode (model
 * diversity beyond Claude/Codex). Mirrors {@link reviewViaClaude}: absolute bin under the daemon's
 * restricted PATH, prompt on STDIN, retry on transient failures. kimi-cli's wrapper carries an
 * absolute-path Python shebang, so it self-contains its interpreter and runs fine under DAEMON_PATH
 * (validated: `--help` and a real review both start with NO `~/.local/bin` on PATH) — no dirname
 * injection needed. `--final-message-only` prints ONLY the clean final assistant message (the verdict
 * JSON) to stdout; the "To resume this session: kimi -r <id>" notice goes to stderr (piped away), so
 * stdout is plain text — we parse it directly with parseVerdict (NO JSON envelope, unlike Claude). No
 * usage telemetry is emitted in this mode → no `usage` on the result.
 */
async function reviewViaKimiCli(task: string, diff: string, env: NodeJS.ProcessEnv): Promise<ReviewResult> {
  const bin = resolveKimiCliBin(env);
  if (bin === KIMI_CLI_BIN_UNSET) {
    return { ok: false, error: "kimi reviewer disabled: set HOUGE_KIMI_CLI_BIN to the absolute kimi-cli path" };
  }
  const timeout = resolveKimiCliTimeoutMs(env);
  const model = resolveKimiCliModel(env);
  const prompt = buildReviewPrompt(task, diff);

  // SECURITY (writer≠checker isolation): kimi-cli's DEFAULT agent ships Shell/ReadFile/Grep/etc. and
  // `--print` auto-approves tool calls, so an unconfined reviewer can read/write ANY absolute path on
  // the host (proven: it read a seeded secret AND wrote into the live repo). The diff is INLINE in the
  // prompt — the reviewer needs no filesystem/shell at all. Confine it to a NO-TOOLS custom agent
  // (`tools: []`, verified to reply NO-ACCESS to a file read) AND run it in a neutral temp cwd, never
  // the repo. This is kimi's analogue of Claude's tools-denied and Codex's `--sandbox read-only`.
  const agent = writeKimiReviewerAgent();
  try {
    // Same fail-safe as Claude: retry a couple of times on a transient timeout/unparseable (a clean
    // `reject` verdict is a real answer and is NOT retried). Exhausting retries → not-published.
    let lastError = "kimi reviewer unavailable";
    for (let attempt = 1; attempt <= KIMI_REVIEW_ATTEMPTS; attempt++) {
      let raw: string;
      try {
        // Headless review call, prompt on STDIN. `--agent-file` pins the no-tools reviewer agent;
        // `--final-message-only` emits ONLY the clean final assistant message (the verdict JSON) to
        // stdout. `--model` is omitted when unset, deferring to kimi-cli's own default (kimi-for-coding).
        // stderr is piped (not inherited) so the "To resume this session" notice doesn't leak to the log.
        ({ stdout: raw } = await execFileAsync(
          bin,
          [
            "--print",
            "--quiet",
            "--final-message-only",
            "--input-format",
            "text",
            "--agent-file",
            agent.agentFile,
            ...(model ? ["--model", model] : [])
          ],
          {
            input: prompt,
            timeout,
            maxBuffer: REVIEW_MAX_BUFFER,
            // Neutral cwd (NOT the repo) — defense in depth alongside the no-tools agent.
            cwd: agent.dir,
            // kimi-cli's wrapper has an absolute-path interpreter shebang, so the restricted daemon PATH
            // is sufficient — it starts without needing its own dir on PATH (validated).
            env: { ...env, PATH: DAEMON_PATH }
          }
        ));
      } catch (error) {
        const err = error as NodeError;
        if (err.code === "ENOENT") {
          // A missing binary won't fix itself on retry — fail immediately.
          return { ok: false, error: `kimi reviewer binary not found: ${bin} (set HOUGE_KIMI_CLI_BIN)` };
        }
        lastError = (err.signal === "SIGTERM" || err.code === "ETIMEDOUT")
          ? `kimi reviewer timed out after ${timeout}ms`
          : `kimi reviewer failed: ${errorMessage(error)}`;
        continue; // transient — retry
      }

      // kimi prints plain text (NOT a JSON envelope), so parse the verdict straight from stdout.
      const verdict = parseVerdict(raw);
      if (verdict) return { ok: true, verdict };
      lastError = "kimi reviewer returned an unparseable verdict";
      // unparseable → retry (the model may have rambled); fall through to next attempt
    }
    return { ok: false, error: `${lastError} (after ${KIMI_REVIEW_ATTEMPTS} attempts)` };
  } finally {
    // Best-effort cleanup of the throwaway agent dir.
    try {
      rmSync(agent.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * The NO-TOOLS kimi reviewer agent (`tools: []`). kimi-cli's default agent has full Shell/file tools
 * and auto-approves them in `--print` mode; stripping ALL tools makes the reviewer a pure text judge of
 * the inline diff (verified: it cannot read an absolute-path file — replies NO-ACCESS). Materialized to
 * a fresh temp dir per call (the agent file + its `system_prompt_path` sibling must co-locate).
 */
const KIMI_REVIEWER_AGENT_YAML = [
  "version: 1",
  "agent:",
  '  name: "houge-reviewer"',
  "  system_prompt_path: ./reviewer-system.md",
  "  tools: []",
  ""
].join("\n");

const KIMI_REVIEWER_SYSTEM_MD =
  "You are a careful, independent, adversarial code reviewer. Follow the user's instructions exactly " +
  "and reply with only what is asked. You have no tools.\n";

export function writeKimiReviewerAgent(): { dir: string; agentFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "houge-kimi-reviewer-"));
  writeFileSync(join(dir, "reviewer-system.md"), KIMI_REVIEWER_SYSTEM_MD, "utf8");
  const agentFile = join(dir, "reviewer.yaml");
  writeFileSync(agentFile, KIMI_REVIEWER_AGENT_YAML, "utf8");
  return { dir, agentFile };
}

/**
 * Reconstruct the agent's reply text from a codex `--json` JSONL stream. Codex emits agent message
 * events whose payload carries the model's text (the field name varies across codex versions —
 * `agent_message` / `item.completed` with a `text`/`message` string). We collect every plausible
 * text-bearing field and join them, so the verdict object inside survives the JSONL escaping. If the
 * stream is not the expected JSONL (older codex, plain text), fall back to the raw stdout — parseVerdict
 * is itself tolerant of prose/garbage.
 */
function extractCodexAgentText(raw: string): string {
  const messages: string[] = [];
  let sawJsonl = false;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    sawJsonl = true;
    // Codex `--json` stdout: the model's reply is the `agent_message` item's `text` — pull ONLY that
    // (collecting every string in the stream drags in the "skill descriptions shortened" notice and
    // reasoning, which muddy the verdict parse). Shape: {type:"item.completed",item:{type:"agent_message",text}}.
    const e = event as { item?: { type?: unknown; text?: unknown }; type?: unknown; text?: unknown };
    const item = e.item;
    if (item && item.type === "agent_message" && typeof item.text === "string") messages.push(item.text);
    else if (e.type === "agent_message" && typeof e.text === "string") messages.push(e.text); // older shape
  }
  // No JSONL / no agent_message found → fall back to the raw text (parseVerdict is tolerant).
  return sawJsonl && messages.length > 0 ? messages.join("\n") : raw;
}

/**
 * Pull the model's text out of a Claude `--output-format json` envelope's `result` field. Tolerant:
 * if stdout is not the expected envelope (older CLI, plain text), fall back to the raw stdout so the
 * verdict parser still gets a chance. (parseVerdict is itself tolerant of prose/garbage.)
 */
function extractClaudeResultText(raw: string): string {
  try {
    const envelope = JSON.parse(raw) as { result?: unknown };
    if (typeof envelope.result === "string") return envelope.result;
  } catch {
    // not an envelope — fall through to the raw text
  }
  return raw;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
