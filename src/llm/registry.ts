import {
  createKimiProvider,
  KIMI_DEFAULT_TIMEOUT_MS,
  type KimiProviderConfig
} from "./providers/kimi.js";
import {
  createPiProvider,
  PI_DEFAULT_TIMEOUT_MS,
  type PiProviderConfig
} from "./providers/pi.js";
import {
  createGeminiProvider,
  GEMINI_DEFAULT_TIMEOUT_MS,
  type GeminiProviderConfig
} from "./providers/gemini.js";
import {
  createAgyCliProvider,
  AGY_DEFAULT_TIMEOUT_MS,
  type AgyCliProviderConfig
} from "./providers/agy-cli.js";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnOneShot, type OneShotDeps } from "./providers/omp.js";
import type { OmpConfig } from "../omp/omp-config.js";
import type { ModelFamily, ModelString } from "../omp/model-string.js";
import type { LlmAuditScope, LlmCallRole, RunStore } from "../run/run-store.js";
import type { LlmMediaAttachment, LlmProvider, LlmRequest, LlmResult } from "./types.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { isAllowedMediaFile } from "../media/media-config.js";
import { classifyLlmError, type LlmAuditSink } from "./audit.js";
import type { SecretBroker } from "../config/secret-broker.js";
import { METERED_PROVIDERS } from "./metered-pricing.js";

export interface BuildLlmChainDeps {
  piConfig?: PiProviderConfig;
  kimiConfig?: KimiProviderConfig;
  geminiConfig?: GeminiProviderConfig;
  agyConfig?: AgyCliProviderConfig;
  /**
   * Metered-$ ceiling (ADR 0019): when this returns true, the metered legs
   * (kimi-api/gemini-api) are dropped from the chain before construction — the
   * flat-rate legs keep working. Latch-driven and cheap (a single-row read); the
   * expensive spend sums run once per daemon tick, not here. Absent → no filtering.
   */
  meteredBreached?: () => boolean;
}

/**
 * Default chain when `HOUGE_LLM_PROVIDERS` is unset. CLI-only by construction: both legs are
 * flat-rate subscription CLIs, so no runtime path reaches a metered pay-per-token API unless an
 * operator names one explicitly. The metered providers below stay buildable for exactly that
 * escape hatch — re-enabling one is an env change, not a redeploy.
 */
export const DEFAULT_LLM_PROVIDERS = "pi,agy-cli";

/**
 * Fallback when the metered-ceiling filter would empty the chain (an all-metered
 * `HOUGE_LLM_PROVIDERS`): a zero-leg chain would silence Houge entirely, which is a
 * worse failure than one more flat-rate call — so fall back to the flat-rate default.
 */
export const METERED_FALLBACK_PROVIDERS: readonly string[] = ["pi"];

/**
 * Slack added on top of the chain budget for the CapabilityRunner's wall-clock
 * cap (`timeout_ms`). The runner cap MUST exceed the chain budget so a healthy
 * chain that is legitimately falling through every provider is never killed
 * mid-flight. See {@link resolveChainBudgetMs}.
 */
export const RUNNER_TIMEOUT_BUFFER_MS = 15_000;

/** Per-provider default timeouts — the single source of truth lives in each
 * provider module; this map only wires the chain-name to that constant. */
const PROVIDER_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  pi: PI_DEFAULT_TIMEOUT_MS,
  "kimi-api": KIMI_DEFAULT_TIMEOUT_MS,
  "agy-cli": AGY_DEFAULT_TIMEOUT_MS,
  "gemini-api": GEMINI_DEFAULT_TIMEOUT_MS
};

/** Per-provider override env var suffixes (`HOUGE_LLM_TIMEOUT_MS_<SUFFIX>`). */
const PROVIDER_TIMEOUT_ENV_SUFFIX: Record<string, string> = {
  pi: "PI",
  "kimi-api": "KIMI",
  "agy-cli": "AGY",
  "gemini-api": "GEMINI"
};

function parseProviderNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env.HOUGE_LLM_PROVIDERS ?? DEFAULT_LLM_PROVIDERS;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    throw new Error("HOUGE_LLM_PROVIDERS resolved to an empty provider chain");
  }
  return names;
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the ordered provider chain from the environment.
 *
 * Known providers: `pi` + `agy-cli` (hardened CLIs) and `kimi-api` + `gemini-api`
 * (OpenAI-compatible HTTP). `agy-cli`/`gemini-api` are general-model legs (Gemini Flash)
 * for the research/answer surface, so synthesis doesn't over-produce like the coding-tuned
 * pi/kimi legs (Phase 3.4). `HOUGE_LLM_PROVIDERS` (a comma-separated, ordered list) defaults to
 * {@link DEFAULT_LLM_PROVIDERS} — CLI-only, no metered leg. Naming a metered leg here is the
 * deliberate escape hatch for both flat-rate CLIs being down at once.
 * Unknown provider names throw a clear error so misconfiguration fails loud.
 */
export function buildLlmChain(
  env: NodeJS.ProcessEnv,
  deps: BuildLlmChainDeps = {},
  broker?: SecretBroker
): LlmProvider[] {
  let names = parseProviderNames(env);

  // Metered-$ ceiling (ADR 0019): with the fuse latched, drop the metered legs BEFORE
  // mapping. NEVER a zero-leg chain — an all-metered list falls back to the flat-rate
  // default instead of silencing Houge.
  if (deps.meteredBreached?.()) {
    const flatRate = names.filter((name) => !METERED_PROVIDERS.has(name));
    if (flatRate.length !== names.length) {
      // Loud, because this can UNDO the documented escape hatch: an operator who set
      // HOUGE_LLM_PROVIDERS to a metered leg because both CLIs were down gets that leg dropped
      // the moment the ceiling latches, and the fallback is the very leg that was failing.
      console.warn(
        `[llm-chain] metered ceiling latched — dropped ${names.filter((n) => METERED_PROVIDERS.has(n)).join(",")} from the chain; ` +
          (flatRate.length > 0
            ? `continuing on ${flatRate.join(",")}`
            : `no flat-rate leg remained, falling back to ${METERED_FALLBACK_PROVIDERS.join(",")}`)
      );
    }
    names = flatRate.length > 0 ? flatRate : [...METERED_FALLBACK_PROVIDERS];
  }

  // Single source of truth for the HTTP providers' key (ADR 0015): resolve it HERE — from the
  // broker when the firewall is armed, else from env — and populate each provider's `config.apiKey`.
  // The providers no longer read `process.env` themselves. When the firewall is OFF the resolved
  // value is exactly what the provider used to read from env, so behavior is byte-identical.
  const kimiKey = broker ? broker.kimiKey() : env.KIMI_API_KEY;
  const geminiKey = broker ? broker.geminiKey() : env.GEMINI_API_KEY;

  return names.map((name) => {
    switch (name) {
      case "pi":
        return createPiProvider(deps.piConfig);
      case "kimi-api":
        return createKimiProvider({ ...deps.kimiConfig, ...(kimiKey !== undefined ? { apiKey: kimiKey } : {}) });
      case "agy-cli":
        return createAgyCliProvider(deps.agyConfig);
      case "gemini-api":
        return createGeminiProvider({ ...deps.geminiConfig, ...(geminiKey !== undefined ? { apiKey: geminiKey } : {}) });
      default:
        throw new Error(`Unknown LLM provider: ${name}`);
    }
  });
}

/**
 * Sum each configured provider's per-provider timeout to get the chain's total
 * wall-clock budget. This MUST mirror what the providers themselves use so the
 * derived runner cap (`resolveChainBudgetMs + RUNNER_TIMEOUT_BUFFER_MS`) never
 * kills a healthy, falling-through chain. The per-provider defaults are imported
 * from each provider module (single source of truth — no drift).
 *
 * Resolution per provider mirrors the providers: `HOUGE_LLM_TIMEOUT_MS_<NAME>`,
 * then `HOUGE_LLM_TIMEOUT_MS`, then the provider's own default constant.
 */
export function resolveChainBudgetMs(env: NodeJS.ProcessEnv): number {
  const names = parseProviderNames(env);
  const fallback = numericEnv(env.HOUGE_LLM_TIMEOUT_MS);

  return names.reduce((sum, name) => {
    const suffix = PROVIDER_TIMEOUT_ENV_SUFFIX[name];
    const specific = suffix ? numericEnv(env[`HOUGE_LLM_TIMEOUT_MS_${suffix}`]) : undefined;
    const fallbackDefault = PROVIDER_DEFAULT_TIMEOUT_MS[name] ?? 0;
    return sum + (specific ?? fallback ?? fallbackDefault);
  }, 0);
}

/**
 * Try each provider in order. Returns the first `ok:true`; skips providers that report
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
  const audit = store.llmAuditSink(scope);
  const base = "run_id" in scope ? scope.run_id : scope.correlation_id;
  return {
    answer: async (req) => {
      const chain = req.media ? cfg.media : (opts.chain ?? seatChain(cfg, scope.role));
      const r = await spawnOneShot(
        {
          seat: scope.role, chain, prompt: req.system ? `${req.system}\n\n${req.question}` : req.question,
          files: req.media ? [req.media.path] : [], correlationId: `${base}:${scope.role}:${randomUUID()}`,
          ...(plannerFamily !== undefined ? { plannerFamily } : {})
        },
        { cfg, audit, ...(opts.versionCheck ? { versionCheck: opts.versionCheck } : {}) }
      );
      if (!r.ok && r.unavailable) reportVersionMismatch(store, cfg, r.error);
      return r;
    }
  };
}

/** One open incident per refused version string (the incident row is the throttle: an open one is never re-opened). */
function reportVersionMismatch(store: RunStore, cfg: OmpConfig, reason: string): void {
  const found = /omp (\d+\.\d+\.\d+) is not/.exec(reason)?.[1] ?? "unknown";
  const subject = `omp:${found}`;
  try {
    if (store.findOpenIncident(store.incidentFingerprint("omp_version_mismatch", subject))) return;
    store.openIncident({ kind: "omp_version_mismatch", subject, detail: { version: found, expected: cfg.version } });
  } catch (error) {
    console.warn(`[omp-seat] could not record omp_version_mismatch: ${error instanceof Error ? error.message : String(error)}`);
  }
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
 * The attachment is validated HERE, before any leg runs. `defaultSystem` applies when the caller
 * passes none.
 */
export function llmToolAdapter(
  seat: { answer(req: LlmRequest): Promise<LlmResult> },
  defaultSystem?: string
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input) => {
    const question = input.question;
    if (typeof question !== "string" || question.length === 0) return { ok: false, error: "question must be a non-empty string" };
    const media = parseMediaInput(input.media);
    if (media === "invalid") return { ok: false, error: "media rejected" };
    const system = typeof input.system === "string" && input.system.length > 0 ? input.system : defaultSystem;
    const r = await seat.answer({ question, ...(system ? { system } : {}), ...(media ? { media } : {}) });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, output: { question, answer: r.answer, model: r.model, provider: r.provider } };
  };
}
