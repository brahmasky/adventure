// Policy: single-shot, tools-disabled, env-allowlisted, killable `pi` inference
// is classified `external_read` (ungated). Full agentic `coding_agent_cli`
// delegation (tools enabled) stays denied until V2 containment. See the
// "LLM providers > Policy amendment" section in README.md.
import os from "node:os";
import type { LlmProvider, LlmRequest, LlmResult } from "../types.js";
import type { LlmUsage } from "../../run/llm-usage.js";
import {
  buildChildEnv,
  defaultSpawnImpl,
  type SpawnImpl,
  type SpawnOpts,
  type SpawnResult
} from "./cli-spawn.js";

// Re-exported for back-compat — pi's spawn seam types now live in the shared cli-spawn module.
export type { SpawnImpl, SpawnOpts, SpawnResult };

export interface PiProviderConfig {
  model?: string;
  timeoutMs?: number;
  /** Raw stdout STREAM cap (memory bound passed to spawn). See PI_DEFAULT_MAX_BYTES. */
  maxBytes?: number;
  /** Cap on the EXTRACTED ANSWER text. See PI_DEFAULT_MAX_ANSWER_BYTES. */
  maxAnswerBytes?: number;
  spawnImpl?: SpawnImpl;
  /**
   * Phase 3.1 telemetry seam (spec §"Real telemetry"). Fired once per SUCCESSFUL answer IF pi
   * reported token usage on the assistant `message_end`, with the call's normalized usage and the
   * actual model id — the W3 caller wires this to `recordLlmCall`. Optional: existing callers are
   * unaffected, and the provider's `LlmResult` shape is unchanged (usage rides this side channel).
   * NON-NEGOTIABLE: carries ONLY counts/metadata — never prompt or response bodies.
   */
  onUsage?: (usage: LlmUsage, model: string) => void;
}

export const PI_DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Raw stdout STREAM cap — the memory bound handed to spawn (which kills the child past it).
 * This bounds the JSONL stream, NOT the answer: in `--mode json` pi emits one `message_update`
 * line PER TOKEN, each carrying a full zeroed usage+cost struct (~249 bytes of line per ~4.6
 * bytes of answer text). Measured live: an 812-word answer was 5,661 answer bytes inside
 * 331,528 stdout bytes — a ~60x ratio. 8 MB therefore leaves ~140 KB of answer headroom.
 *
 * Which bound fires first, at defaults: the 60 s timeout (8 MB ≈ 34K tokens needs ~560 tok/s),
 * then this stream cap (~140 KB of answer), and only then the 256 KB answer cap below — which
 * is therefore a FORWARD guard for a leaner pi JSONL format, not the bound an operator will see
 * today. All three are plain errors that fall through identically; the point of the split is
 * that an ordinary long answer (5–50 KB) no longer trips a cap meant for 256 KB.
 */
export const PI_DEFAULT_MAX_BYTES = 8_388_608; // 8 MB (stream)
/**
 * Cap on the EXTRACTED ANSWER text (the last assistant `message_end`, or the accumulated
 * deltas as fallback). This is the original 256 KB intent — an over-cap answer is an error,
 * never a truncated success.
 */
export const PI_DEFAULT_MAX_ANSWER_BYTES = 262_144; // 256 KB (answer)
export const PI_BINARY = "pi";

/** Auth markers pi prints as PLAIN TEXT while exiting 0 — treat as unavailable. */
const AUTH_MARKERS = ["no api key", "/login", "not logged in", "please log in"];

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\[[0-9;]*m/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

function byteLength(input: string): number {
  return Buffer.byteLength(input, "utf8");
}

interface ParsedAnswer {
  /** Text from the LAST assistant `message_end` (preferred). */
  messageEndText: string | undefined;
  /** Accumulated `text_delta` deltas (fallback). */
  deltaText: string;
  /** Actual model id pi reported on the assistant message, for an accurate audit trail. */
  model: string | undefined;
  /** Normalized token usage from the LAST assistant `message_end`, if pi reported one (Phase 3.1). */
  usage: LlmUsage | undefined;
}

/**
 * Normalize a pi `message_end` message's `usage` object into {@link LlmUsage}, tolerant of two
 * schemas: the OpenAI-ish names (`input_tokens`/`prompt_tokens`, `output_tokens`/
 * `completion_tokens`, `cached_input_tokens`/`cache_read_input_tokens`) AND pi's own native
 * block (verified on pi 0.81.1: `input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`).
 * `input` is the TOTAL prompt count (OpenAI semantics: it includes the cached subset, which
 * `cacheRead` reports separately). Returns `undefined` only when no usable usage block is
 * present — pi versions that emit no usage simply produce no telemetry.
 */
function extractPiUsage(usage: unknown): LlmUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const toNum = (...keys: string[]): number => {
    for (const k of keys) {
      const n = typeof u[k] === "number" ? (u[k] as number) : Number(u[k]);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
    return 0;
  };
  const hasAny = ["input_tokens", "prompt_tokens", "input", "output_tokens", "completion_tokens", "output"].some(
    (k) => u[k] !== undefined
  );
  if (!hasAny) return undefined;
  return {
    input_tokens: toNum("input_tokens", "prompt_tokens", "input"),
    output_tokens: toNum("output_tokens", "completion_tokens", "output"),
    cached_input_tokens: toNum("cached_input_tokens", "cache_read_input_tokens", "cacheRead")
  };
}

/** Parse pi's JSONL (`--mode json`) stdout line-by-line, defensively. */
function parsePiJsonl(stdout: string): ParsedAnswer {
  let messageEndText: string | undefined;
  let deltaText = "";
  let model: string | undefined;
  let usage: LlmUsage | undefined;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // ignore non-JSON lines defensively
    }
    if (typeof event !== "object" || event === null) continue;
    const obj = event as Record<string, unknown>;

    if (obj.type === "message_end") {
      const message = obj.message;
      if (typeof message === "object" && message !== null) {
        const msg = message as Record<string, unknown>;
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const text = (msg.content as Array<Record<string, unknown>>)
            .filter((block) => block && block.type === "text" && typeof block.text === "string")
            .map((block) => block.text as string)
            .join("");
          if (text.length > 0) messageEndText = text; // keep the LAST one
          if (typeof msg.model === "string") model = msg.model; // actual model pi used
          const u = extractPiUsage(msg.usage); // token usage, if pi reported one (keep the LAST)
          if (u) usage = u;
        }
      }
    } else if (obj.type === "message_update") {
      const evt = obj.assistantMessageEvent;
      if (typeof evt === "object" && evt !== null) {
        const e = evt as Record<string, unknown>;
        if (e.type === "text_delta" && typeof e.delta === "string") {
          deltaText += e.delta;
        }
      }
    }
  }

  return { messageEndText, deltaText, model, usage };
}

function extractAnswer(parsed: ParsedAnswer): string | undefined {
  if (parsed.messageEndText && parsed.messageEndText.length > 0) {
    return parsed.messageEndText;
  }
  if (parsed.deltaText.length > 0) return parsed.deltaText;
  return undefined;
}

export function createPiProvider(config: PiProviderConfig = {}): LlmProvider {
  const spawnImpl = config.spawnImpl ?? defaultSpawnImpl;

  return {
    name: "pi",
    async answer(req: LlmRequest): Promise<LlmResult> {
      // pi has NO Houge-side default model: when unset, --model is omitted and
      // pi uses its OWN configured provider/model. We deliberately do NOT read
      // the cross-provider global — pi's model namespace differs from the APIs'.
      const model = req.model ?? config.model ?? process.env.HOUGE_LLM_MODEL_PI;

      const timeoutMs =
        config.timeoutMs ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS_PI) ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS) ??
        PI_DEFAULT_TIMEOUT_MS;

      const maxBytes = config.maxBytes ?? PI_DEFAULT_MAX_BYTES;
      const maxAnswerBytes = config.maxAnswerBytes ?? PI_DEFAULT_MAX_ANSWER_BYTES;

      // The question is delivered on stdin (see SpawnOpts.input), NEVER as an
      // argv token — pi reads its prompt from stdin in -p mode and has no `--`
      // separator, so this is the only injection-safe form.
      //
      // `--no-tools` is the real safety lever (disables read/bash/edit/write,
      // built-in AND extension tools). We do NOT pass `--no-extensions` because
      // some providers (e.g. kimi-coder) are registered via a pi extension; with
      // tools already disabled, loading the extension only makes the model
      // reachable, not capable of side effects.
      // `--system-prompt` REPLACES pi's default coding-assistant persona. The
      // value is Houge-controlled (never the attacker's question), so passing
      // it as an argv flag is safe — unlike the question, which stays on stdin.
      const args = [
        "-p",
        "--no-tools",
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--mode",
        "json",
        ...(req.system ? ["--system-prompt", req.system] : []),
        ...(model ? ["--model", model] : [])
      ];

      const env = buildChildEnv(process.env.HOUGE_PI_ENV_PASSTHROUGH);

      let result: SpawnResult;
      try {
        result = await spawnImpl(PI_BINARY, args, {
          timeoutMs,
          cwd: os.tmpdir(),
          env,
          maxBytes,
          input: req.question
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, provider: "pi", error: `pi spawn failed: ${message}` };
      }

      // Binary missing / spawn failure → unavailable (lets the chain fall through).
      if (result.spawnError?.code === "ENOENT") {
        return {
          ok: false,
          provider: "pi",
          error: "pi binary not found (ENOENT)",
          unavailable: true
        };
      }
      if (result.spawnError) {
        return {
          ok: false,
          provider: "pi",
          error: `pi spawn error: ${result.spawnError.code ?? "unknown"}`,
          unavailable: true
        };
      }

      // Our timeout is authoritative → normal failure (NOT unavailable).
      if (result.timedOut) {
        return { ok: false, provider: "pi", error: `pi timed out after ${timeoutMs}ms` };
      }

      // Stream bound (memory guard, mirrors what spawn enforces): over-cap is an error, never a
      // (possibly truncated) success. With the 8 MB default this essentially never fires — the
      // answer cap below is the one that bites on genuinely oversized answers.
      if (byteLength(result.stdout) > maxBytes) {
        return {
          ok: false,
          provider: "pi",
          error: `pi output stream exceeded ${maxBytes} byte cap`
        };
      }

      const parsed = parsePiJsonl(result.stdout);
      const answer = extractAnswer(parsed);

      // Answer bound: applied to the EXTRACTED text, not the ~60x-inflated JSONL stream.
      if (answer !== undefined && byteLength(answer) > maxAnswerBytes) {
        return {
          ok: false,
          provider: "pi",
          error: `pi answer exceeded ${maxAnswerBytes} byte cap`
        };
      }

      // Auth markers (printed as plain text, exit 0) → unavailable.
      const combined = stripAnsi(`${result.stdout}\n${result.stderr}`).toLowerCase();
      const hasAuthMarker = AUTH_MARKERS.some((marker) => combined.includes(marker));

      if (answer === undefined) {
        // No answer text extracted → NEVER success.
        const unavailable = hasAuthMarker || result.code !== 0 || result.code === null;
        return {
          ok: false,
          provider: "pi",
          error: hasAuthMarker
            ? "pi is not authenticated (run /login)"
            : `pi produced no answer (exit ${result.code ?? "null"})`,
          ...(unavailable ? { unavailable: true } : {})
        };
      }

      // Real answer text — only now is success allowed. Even so, an auth marker
      // present alongside a non-zero exit is suspect, but a clean extraction with
      // exit 0 is a legitimate answer.
      const reportedModel = parsed.model ?? model ?? "pi-default";

      // Telemetry side channel (Phase 3.1): surface normalized usage without altering the result
      // shape. Best-effort — absent usage or a throwing hook never fails the answer.
      if (config.onUsage && parsed.usage) {
        try {
          config.onUsage(parsed.usage, reportedModel);
        } catch {
          // a failing telemetry hook must never break a good answer
        }
      }

      return {
        ok: true,
        provider: "pi",
        // Prefer the model pi actually reported, then the configured one.
        model: reportedModel,
        answer,
        ...(parsed.usage ? { usage: parsed.usage } : {})
      };
    }
  };
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
