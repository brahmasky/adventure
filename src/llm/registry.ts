import { randomBytes, randomUUID } from "node:crypto";
import { OMP_AUDIO_REFUSED, spawnOneShot, type OneShotDeps } from "./providers/omp.js";
import type { OmpCheckFailure } from "../omp/omp-version.js";
import type { OmpConfig } from "../omp/omp-config.js";
import type { ModelFamily, ModelString } from "../omp/model-string.js";
import type { LlmAuditScope, LlmCallRole, RunStore } from "../run/run-store.js";
import type { LlmMediaAttachment, LlmProvider, LlmRequest, LlmResult } from "./types.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { isAllowedMediaFile } from "../media/media-config.js";
import { ASK_DISCIPLINE, FALLBACK_IDENTITY, GUARDRAILS } from "../prompt/composer.js";
import { classifyLlmError, type LlmAuditSink } from "./audit.js";
import { openAlertedIncident } from "../run/incident-alert.js";

/**
 * The LLM seam after the omp cutover (spec §8, Task 14). Every non-planner call is an omp one-shot
 * seat ({@link oneShotAdapter} over {@link seatChain}); the planner is PlannerSession/Supervisor.
 * The one exception is the voice leg: omp cannot hear audio (ruling 2), so a voice note runs
 * {@link answerWithChain} over the agy-cli provider.
 */

/**
 * Slack added on top of a seat's wall-clock budget for the CapabilityRunner's cap (`timeout_ms`).
 * The runner cap MUST exceed the seat budget so a healthy chain that is legitimately falling
 * through every leg is never killed mid-flight. See {@link seatBudgetMs}.
 */
export const RUNNER_TIMEOUT_BUFFER_MS = 15_000;

/**
 * The voice leg's chain loop (agy-cli). Try each provider in order. Returns the first `ok:true`; skips providers that report
 * `unavailable`; treats other failures as fallthrough. If every provider fails, returns one
 * aggregated `ok:false` with per-provider reasons joined.
 *
 * THE AUDIT CHOKEPOINT (spec 2026-09-04 §"Slice 2"): every leg attempted is recorded through the
 * REQUIRED `audit` sink — success, error, or unavailable — with its latency, its position in the
 * invocation (`attempt_group` + `leg_index`, so "agy failed then pi served" is reconstructable),
 * and on success the usage the provider returned. Providers only parse; this loop is the one
 * place that reports, so coverage is structural. `error_kind` is classified HERE, per leg, never
 * from the joined aggregate. Recording is best-effort: a sink failure logs and never fails an
 * answer. The `role` is filled by the scoped sink — the chain does not know a call's purpose.
 * A provider that throws is recorded as an error and treated as fall-through — the chain's
 * contract is that a leg failure never escapes it.
 *
 * A leg that fails while a LATER leg succeeds is ALSO logged to the console — that line is the
 * D1 visibility signal that would have shown agy dead for three months. Counts and provider
 * names only, never prompt or response content.
 */
export async function answerWithChain(
  chain: LlmProvider[],
  req: LlmRequest,
  audit: LlmAuditSink
): Promise<LlmResult> {
  const reasons: string[] = [];
  const attempt_group = randomBytes(6).toString("hex");

  // Multimodal ingest: a leg that cannot take the attachment is never attempted (and so never
  // audited as a failure — Codex spec review R11). Text requests see the whole chain, as before.
  const legs = req.media ? chain.filter((p) => p.supportsMedia?.(req.media!.mime) === true) : chain;
  if (req.media && legs.length === 0) {
    return { ok: false, provider: "chain", error: "no media-capable leg" };
  }

  for (let leg_index = 0; leg_index < legs.length; leg_index++) {
    const provider = legs[leg_index]!;
    const t0 = Date.now();
    let result: LlmResult;
    try {
      result = await provider.answer(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { ok: false, provider: provider.name, error: `${provider.name} threw: ${message}` };
    }
    const latency_ms = Date.now() - t0;

    try {
      if (result.ok) {
        audit.record({
          provider: provider.name,
          role: "",
          outcome: "ok",
          model: result.model,
          latency_ms,
          attempt_group,
          leg_index,
          ...(result.usage ? { usage: result.usage } : {})
        });
      } else {
        audit.record({
          provider: provider.name,
          role: "",
          outcome: result.unavailable ? "unavailable" : "error",
          latency_ms,
          attempt_group,
          leg_index,
          error_kind: classifyLlmError(result.error)
        });
      }
    } catch (error) {
      console.warn(
        `[llm-chain] audit sink failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (result.ok) {
      if (reasons.length > 0) {
        console.warn(
          `[llm-chain] ${result.provider} served after ${reasons.length} leg(s) fell through: ${reasons.join("; ")}`
        );
      }
      return result;
    }
    const tag = result.unavailable ? "unavailable" : "error";
    // A media leg's error text can echo the prompt (a caption) or the temp path; keep the kind only.
    const detail = req.media ? classifyLlmError(result.error) : result.error;
    reasons.push(`${result.provider}: ${detail} (${tag})`);
  }

  return {
    ok: false,
    provider: "chain",
    error: reasons.length > 0 ? reasons.join("; ") : "no providers configured"
  };
}

/**
 * Which omp subscription chain serves a non-planner call (spec §8). Judges take ONE string per
 * seat index from the returned list ({@link judgeSeat}); `writer` is codex, never an omp seat.
 * `answer`/`compose` (the `/ask` and `/research` commands, the loop tools' internal calls) ride the
 * planner chain: they answer Paco directly, like a turn does.
 */
export function seatChain(cfg: OmpConfig, role: LlmCallRole): ModelString[] {
  switch (role) {
    case "reader": return cfg.reader;
    case "media_transcribe": return cfg.media;
    case "judge": return cfg.judges;
    case "chair": return cfg.chair;
    case "reviewer": return cfg.reviewer;
    case "answer":
    case "compose": return cfg.planner;
    case "writer": throw new Error("the writer seat is codex, not an omp chain");
    default: return cfg.ticks; // distill, consolidate, extract, attribution, frame, verify, classify*
  }
}

/** One judge seat: exactly one model string by index — a judge never falls back (panel quorum semantics). */
export function judgeSeat(cfg: OmpConfig, index: number): ModelString[] {
  const m = cfg.judges[index];
  return m ? [m] : [];
}

/** Wall-clock budget of a seat's whole chain (every leg may time out) — the runner cap adds {@link RUNNER_TIMEOUT_BUFFER_MS}. */
export function seatBudgetMs(cfg: OmpConfig, role: LlmCallRole): number {
  return (role === "writer" ? 1 : seatChain(cfg, role).length) * cfg.oneshotTimeoutMs;
}

export interface OneShotAdapterOptions {
  /** A seat-specific chain (a judge's single string); default {@link seatChain} for the scope's role. */
  chain?: ModelString[];
  /** Tests only: bypass the `omp --version` spawn. */
  versionCheck?: OneShotDeps["versionCheck"];
}

/**
 * The drop-in replacement for the old chain adapter: every non-planner call is ONE `spawnOneShot`
 * over the seat's subscription chain, audited per leg under `scope`. A media request (a photo) runs
 * on `cfg.media` with the file as an `@path` argument; voice never comes here (agy-cli, ruling 2).
 * A version mismatch leaves no audit row (no leg ran), so the caller opens `omp_version_mismatch`.
 */
export function oneShotAdapter(
  store: RunStore, cfg: OmpConfig, scope: LlmAuditScope, plannerFamily?: ModelFamily, opts: OneShotAdapterOptions = {}
): { answer(req: LlmRequest): Promise<LlmResult> } {
  const base = "run_id" in scope ? scope.run_id : scope.correlation_id;
  return {
    answer: async (req) => {
      if (req.media?.mime.startsWith("audio/")) return { ok: false, provider: "omp", error: OMP_AUDIO_REFUSED };
      const chain = req.media ? cfg.media : (opts.chain ?? seatChain(cfg, scope.role));
      const r = await spawnOneShot(
        {
          seat: scope.role, chain, prompt: req.system ? `${req.system}\n\n${req.question}` : req.question,
          files: req.media ? [req.media.path] : [], correlationId: `${base}:${scope.role}:${randomUUID()}`,
          ...(plannerFamily !== undefined ? { plannerFamily } : {})
        },
        { cfg, audit: store.llmAuditSink(scope), ...(opts.versionCheck ? { versionCheck: opts.versionCheck } : {}) }
      );
      if (!r.ok && r.omp_check) reportOmpCheck(store, cfg, r.omp_check);
      return r;
    }
  };
}

/**
 * The incident for a refused omp version check (ruling 6), alerted once. Only a version that was
 * READ and differs is `omp_version_mismatch` (one per version string); omp not runnable or silent
 * about its version is `omp_unavailable`. The open incident is the throttle.
 */
export function reportOmpCheck(store: RunStore, cfg: OmpConfig, check: OmpCheckFailure): void {
  const mismatch = check.kind === "version_mismatch";
  try {
    openAlertedIncident(store, {
      kind: mismatch ? "omp_version_mismatch" : "omp_unavailable",
      subject: mismatch ? `omp:${check.version ?? "unknown"}` : `omp:${check.kind}`,
      detail: { check: check.kind, version: check.version, expected: cfg.version },
      chat_id: null
    });
  } catch (error) {
    console.warn(`[omp-seat] could not record the omp check incident: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The thin identity fallback for a seat call that passes no system prompt (the live /ask composes its own). */
export const DEFAULT_ASK_SYSTEM_PROMPT = [FALLBACK_IDENTITY, ASK_DISCIPLINE, GUARDRAILS].join("\n\n");

/** `HOUGE_ASK_SYSTEM_PROMPT` when set, else {@link DEFAULT_ASK_SYSTEM_PROMPT}. */
export function askFallbackSystem(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HOUGE_ASK_SYSTEM_PROMPT;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : DEFAULT_ASK_SYSTEM_PROMPT;
}

/** `input.media` → a validated attachment, `undefined` when absent, or `"invalid"`. */
function parseMediaInput(raw: unknown): LlmMediaAttachment | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) return "invalid";
  const { path, mime } = raw as Record<string, unknown>;
  if (typeof path !== "string" || typeof mime !== "string") return "invalid";
  return isAllowedMediaFile({ path, mime }) ? { path, mime } : "invalid";
}

/**
 * The `(input) => ToolAdapterResult` shape the CapabilityRunner, the quarantine wall and the media
 * ingest step call: `{question, system?, media?}` in, `{question, answer, model, provider}` out.
 * The attachment is validated HERE, before any leg runs. System prompt precedence: `input.system`,
 * then `HOUGE_ASK_SYSTEM_PROMPT`, then {@link DEFAULT_ASK_SYSTEM_PROMPT}.
 */
export function llmToolAdapter(
  seat: { answer(req: LlmRequest): Promise<LlmResult> },
  defaultSystem: () => string = () => askFallbackSystem(process.env)
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input) => {
    const question = input.question;
    if (typeof question !== "string" || question.length === 0) return { ok: false, error: "question must be a non-empty string" };
    const media = parseMediaInput(input.media);
    if (media === "invalid") return { ok: false, error: "media rejected" };
    const system = typeof input.system === "string" && input.system.length > 0 ? input.system : defaultSystem();
    const r = await seat.answer({ question, system, ...(media ? { media } : {}) });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, output: { question, answer: r.answer, model: r.model, provider: r.provider } };
  };
}
