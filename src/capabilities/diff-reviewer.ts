import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileAsync } from "../run/exec-file-async.js";
import { resolveCodexBin, resolveCodexEnabled, resolveCodexTimeoutMs } from "./coding-agent.js";
import { normalizeCodexUsage, type LlmUsage } from "../run/llm-usage.js";
import { classifyLlmError, type LlmAttemptOutcome, type LlmAuditSink, type LlmErrorKind } from "../llm/audit.js";

/**
 * Independent diff reviewer (Phase 3, checker 3 — ADR 0011 §7 / spec
 * docs/superpowers/specs/2026-06-25-phase3-code-self-write.md).
 *
 * The semantic / adversarial check tests can't give: "passes the test gate but wrong / hacky
 * / scope-creep / doesn't actually fix it." Writer ≠ checker by construction — the reviewer is
 * a DIFFERENT agent (kimi by default, model diversity) from the writer (Codex). The kimi CLI
 * runs in headless print mode by ABSOLUTE bin under the daemon's restricted PATH. The
 * Codex-session path is the fallback (independent fresh session + the same adversarial prompt
 * → same verdict shape). Claude is NOT a runtime backend — it is the build-orchestrator seat
 * (one narrow exception, ADR 0027: the contained, tool-less, single-turn idea-panel CHAIR seat
 * — panel-local inference only, never a reviewer/writer/chain backend).
 */

/** The daemon's launchd PATH (com.houge.daemon.plist). Reviewer CLIs are NOT on it → absolute bin. */
const DAEMON_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const REVIEW_MAX_BUFFER = 8 * 1024 * 1024;

const DEFAULT_KIMI_CLI_TIMEOUT_MS = 180_000; // per-attempt ceiling; a normal kimi review returns in ~7s
const KIMI_REVIEW_ATTEMPTS = 2; // retry once on a transient timeout/unparseable (CLI throttle/cold-start)
/** Sentinel for an unset `HOUGE_KIMI_CLI_BIN` — the caller treats this as "reviewer disabled".
 *  We do NOT guess a bare `kimi-cli`; the daemon PATH lacks it. */
export const KIMI_CLI_BIN_UNSET = "";

export type ReviewerKind = "codex" | "kimi";

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
 *  model-diverse from the Codex writer; the free test-gate + Paco's merge are the real safety net).
 *  Any unknown value — including a stale `claude` left in an old .env — falls back to the default. */
export function resolveSelfWriteReviewer(env: NodeJS.ProcessEnv): ReviewerKind {
  const raw = env.HOUGE_SELFWRITE_REVIEWER?.trim().toLowerCase();
  if (raw === "codex") return "codex";
  return "kimi";
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
  /**
   * Required audit chokepoint (slice 2 / codex review, Task 12 fix 2): `reviewDiff` runs its OWN
   * retry/fallback chain (kimi retries, then a codex fallback) — a single aggregate record at the
   * call site would show only the winning leg and silently drop every failed attempt underneath
   * it (the exact silent-fallthrough class this slice exists to end). ONE `llm_attempt` per leg
   * actually tried, recorded here at the point of attempt, in order.
   */
  audit: LlmAuditSink;
}

interface NodeError extends Error {
  code?: string;
  signal?: string | null;
  stdout?: Buffer | string | null;
}

/** Fixed fallback order (H1): the configured reviewer first, then the rest of this list. */
const REVIEWER_FALLBACK_ORDER: ReviewerKind[] = ["kimi", "codex"];

/**
 * Run checker 3 (H1: fallback chain). The configured reviewer (`HOUGE_SELFWRITE_REVIEWER`) runs
 * first; if it is UNAVAILABLE (timeout / spawn failure / unparseable transport — never a delivered
 * verdict), the remaining backends are tried in [kimi, codex] order. A DELIVERED verdict
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
    const result = await runReviewer(backend, input.task, input.diff, env, input.audit);
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
    case "codex":
      return resolveCodexEnabled(env);
  }
}

function runReviewer(
  kind: ReviewerKind,
  task: string,
  diff: string,
  env: NodeJS.ProcessEnv,
  audit: LlmAuditSink
): Promise<ReviewResult> {
  switch (kind) {
    case "codex":
      return reviewViaCodex(task, diff, env, audit);
    case "kimi":
      return reviewViaKimiCli(task, diff, env, audit);
  }
}

/**
 * One `llm_attempt` per reviewer leg actually tried (codex review, Task 12 fix 2) — the provider
 * name identifies the backend binary (`kimi-cli` / `codex`), never the reviewer role (the scoped
 * store sink fills `role`). Best-effort by contract: a throwing sink must never fail a review.
 */
function recordReviewLeg(
  audit: LlmAuditSink,
  provider: string,
  info: {
    outcome: LlmAttemptOutcome;
    latency_ms: number;
    error_kind?: LlmErrorKind;
    model?: string;
    usage?: LlmUsage;
  }
): void {
  try {
    audit.record({
      provider,
      role: "", // the scoped store sink fills the role
      outcome: info.outcome,
      latency_ms: info.latency_ms,
      ...(info.model !== undefined ? { model: info.model } : {}),
      ...(info.error_kind !== undefined ? { error_kind: info.error_kind } : {}),
      ...(info.usage !== undefined ? { usage: info.usage } : {})
    });
  } catch (error) {
    console.warn(
      `[diff-reviewer] audit sink failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Path NO-GO fallback (spike S0): an INDEPENDENT Codex session as checker 3 — fresh `codex exec
 * --sandbox read-only` consult with the same adversarial prompt (writer≠checker preserved; no
 * new infra). Read-only: the reviewer only judges the diff, it never writes. Reuses the shared
 * Codex resolvers; runs in `cwd` (no `-C`/worktree needed — the diff is in the prompt).
 */
async function reviewViaCodex(
  task: string,
  diff: string,
  env: NodeJS.ProcessEnv,
  audit: LlmAuditSink
): Promise<ReviewResult> {
  const bin = resolveCodexBin(env);
  const timeout = resolveCodexTimeoutMs(env);
  const prompt = buildReviewPrompt(task, diff);
  const t0 = Date.now();

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
    const latency_ms = Date.now() - t0;
    const err = error as NodeError;
    if (err.code === "ENOENT") {
      const message = `Codex reviewer binary not found: ${bin} (set HOUGE_CODEX_BIN)`;
      recordReviewLeg(audit, "codex", { outcome: "unavailable", latency_ms, error_kind: "spawn" });
      return { ok: false, error: message };
    }
    if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
      recordReviewLeg(audit, "codex", { outcome: "error", latency_ms, error_kind: "timeout" });
      return { ok: false, error: `Codex reviewer timed out after ${timeout}ms` };
    }
    const message = `Codex reviewer failed: ${errorMessage(error)}`;
    recordReviewLeg(audit, "codex", { outcome: "error", latency_ms, error_kind: classifyLlmError(message) });
    return { ok: false, error: message };
  }

  // The verdict text is the agent's message inside the JSONL stream (escaped). Reconstruct that
  // text, then parse the verdict from it; also normalize the `token_count` usage for telemetry.
  const latency_ms = Date.now() - t0;
  const usage = normalizeCodexUsage(raw) ?? undefined;
  const verdict = parseVerdict(extractCodexAgentText(raw));
  if (!verdict) {
    const message = "Codex reviewer returned an unparseable verdict";
    recordReviewLeg(audit, "codex", { outcome: "error", latency_ms, error_kind: classifyLlmError(message) });
    return { ok: false, error: message };
  }
  recordReviewLeg(audit, "codex", { outcome: "ok", latency_ms, model: "default", ...(usage ? { usage } : {}) });
  return usage ? { ok: true, verdict, usage } : { ok: true, verdict };
}

/**
 * The default reviewer backend — the local `kimi-cli` agent in headless print mode (model
 * diversity from the Codex writer): absolute bin under the daemon's
 * restricted PATH, prompt on STDIN, retry on transient failures. kimi-cli's wrapper carries an
 * absolute-path Python shebang, so it self-contains its interpreter and runs fine under DAEMON_PATH
 * (validated: `--help` and a real review both start with NO `~/.local/bin` on PATH) — no dirname
 * injection needed. `--final-message-only` prints ONLY the clean final assistant message (the verdict
 * JSON) to stdout; the "To resume this session: kimi -r <id>" notice goes to stderr (piped away), so
 * stdout is plain text — we parse it directly with parseVerdict (NO JSON envelope). No
 * usage telemetry is emitted in this mode → no `usage` on the result.
 */
async function reviewViaKimiCli(
  task: string,
  diff: string,
  env: NodeJS.ProcessEnv,
  audit: LlmAuditSink
): Promise<ReviewResult> {
  const bin = resolveKimiCliBin(env);
  if (bin === KIMI_CLI_BIN_UNSET) {
    const message = "kimi reviewer disabled: set HOUGE_KIMI_CLI_BIN to the absolute kimi-cli path";
    recordReviewLeg(audit, "kimi-cli", { outcome: "unavailable", latency_ms: 0, error_kind: "auth" });
    return { ok: false, error: message };
  }
  const timeout = resolveKimiCliTimeoutMs(env);
  const model = resolveKimiCliModel(env);
  const prompt = buildReviewPrompt(task, diff);

  // SECURITY (writer≠checker isolation): kimi-cli's DEFAULT agent ships Shell/ReadFile/Grep/etc. and
  // `--print` auto-approves tool calls, so an unconfined reviewer can read/write ANY absolute path on
  // the host (proven: it read a seeded secret AND wrote into the live repo). The diff is INLINE in the
  // prompt — the reviewer needs no filesystem/shell at all. Confine it to a NO-TOOLS custom agent
  // (`tools: []`, verified to reply NO-ACCESS to a file read) AND run it in a neutral temp cwd, never
  // the repo. This is kimi's analogue of Codex's `--sandbox read-only`.
  const agent = writeKimiReviewerAgent();
  try {
    // Fail-safe: retry a couple of times on a transient timeout/unparseable (a clean
    // `reject` verdict is a real answer and is NOT retried). Exhausting retries → not-published.
    let lastError = "kimi reviewer unavailable";
    for (let attempt = 1; attempt <= KIMI_REVIEW_ATTEMPTS; attempt++) {
      const t0 = Date.now();
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
        const latency_ms = Date.now() - t0;
        const err = error as NodeError;
        if (err.code === "ENOENT") {
          // A missing binary won't fix itself on retry — fail immediately.
          const message = `kimi reviewer binary not found: ${bin} (set HOUGE_KIMI_CLI_BIN)`;
          recordReviewLeg(audit, "kimi-cli", { outcome: "unavailable", latency_ms, error_kind: "spawn" });
          return { ok: false, error: message };
        }
        const timedOut = err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
        lastError = timedOut
          ? `kimi reviewer timed out after ${timeout}ms`
          : `kimi reviewer failed: ${errorMessage(error)}`;
        recordReviewLeg(audit, "kimi-cli", {
          outcome: "error",
          latency_ms,
          error_kind: timedOut ? "timeout" : classifyLlmError(lastError)
        });
        continue; // transient — retry
      }

      // kimi prints plain text (NOT a JSON envelope), so parse the verdict straight from stdout.
      const latency_ms = Date.now() - t0;
      const verdict = parseVerdict(raw);
      if (verdict) {
        recordReviewLeg(audit, "kimi-cli", { outcome: "ok", latency_ms, model: model || "kimi-for-coding" });
        return { ok: true, verdict };
      }
      lastError = "kimi reviewer returned an unparseable verdict";
      recordReviewLeg(audit, "kimi-cli", { outcome: "error", latency_ms, error_kind: classifyLlmError(lastError) });
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
