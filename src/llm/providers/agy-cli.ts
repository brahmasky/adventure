// Policy: single-shot, print-mode, env-allowlisted, killable `agy` (Antigravity CLI) inference is
// classified `external_read` (ungated), same as `pi`. agy is a GENERAL-model leg (Gemini Flash) for
// the research/answer surface, so it synthesizes prose without the coding-model over-production that
// blows pi's output cap. Unlike pi, agy takes the prompt as an ARGV value (`--print <prompt>`), not
// on stdin; this stays injection-safe because the prompt is a single, discrete argv element (Go's
// flag package consumes the token after `--print` as its literal value — it is never re-parsed as a
// flag). agy is agentic and has no `--no-tools`; blast radius is bounded by an empty temp cwd, a
// minimal env allowlist (no secrets), and NEVER passing `--dangerously-skip-permissions`.
import os from "node:os";
import type { LlmProvider, LlmRequest, LlmResult } from "../types.js";
import { buildChildEnv, defaultSpawnImpl, type SpawnImpl, type SpawnResult } from "./cli-spawn.js";

export const AGY_DEFAULT_TIMEOUT_MS = 60_000;
export const AGY_DEFAULT_MAX_BYTES = 262_144; // 256 KB — a general model won't over-produce; ample for prose.
export const AGY_DEFAULT_MODEL = "Gemini 3.5 Flash (Low)";
export const AGY_BINARY = "agy";

/** Auth markers agy may print while failing to reach a model — treat as unavailable (fall through). */
const AUTH_MARKERS = ["not logged in", "please log in", "/login", "no api key", "unauthenticated", "sign in"];

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

function byteLength(input: string): number {
  return Buffer.byteLength(input, "utf8");
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export interface AgyCliProviderConfig {
  model?: string;
  timeoutMs?: number;
  maxBytes?: number;
  spawnImpl?: SpawnImpl;
}

export function createAgyCliProvider(config: AgyCliProviderConfig = {}): LlmProvider {
  const spawnImpl = config.spawnImpl ?? defaultSpawnImpl;

  return {
    name: "agy-cli",
    async answer(req: LlmRequest): Promise<LlmResult> {
      const binary = process.env.HOUGE_AGY_BIN ?? AGY_BINARY;
      const model = req.model ?? config.model ?? process.env.HOUGE_AGY_MODEL ?? AGY_DEFAULT_MODEL;

      const timeoutMs =
        config.timeoutMs ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS_AGY) ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS) ??
        AGY_DEFAULT_TIMEOUT_MS;

      const maxBytes = config.maxBytes ?? AGY_DEFAULT_MAX_BYTES;

      // agy --print has no --system-prompt; the Houge-controlled persona is folded into the prompt
      // text (system first, then the question). The whole thing is ONE argv element — even if the
      // question looks like a flag, it is the literal value of `--print`, never re-parsed.
      const prompt = req.system ? `${req.system}\n\n${req.question}` : req.question;
      const args = ["--model", model, "--print", prompt];

      // Minimal env (no secrets); agy reads its own auth from $HOME. Opt extra vars in via
      // HOUGE_AGY_ENV_PASSTHROUGH if a deployment stores agy auth in an env var.
      const env = buildChildEnv(process.env.HOUGE_AGY_ENV_PASSTHROUGH);

      let result: SpawnResult;
      try {
        result = await spawnImpl(binary, args, {
          timeoutMs,
          cwd: os.tmpdir(),
          env,
          maxBytes,
          input: "" // prompt is on argv, not stdin
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, provider: "agy-cli", error: `agy spawn failed: ${message}` };
      }

      // Binary missing / spawn failure → unavailable (lets the chain fall through).
      if (result.spawnError?.code === "ENOENT") {
        return { ok: false, provider: "agy-cli", error: "agy binary not found (ENOENT)", unavailable: true };
      }
      if (result.spawnError) {
        return {
          ok: false,
          provider: "agy-cli",
          error: `agy spawn error: ${result.spawnError.code ?? "unknown"}`,
          unavailable: true
        };
      }

      // Our timeout is authoritative → normal failure (NOT unavailable).
      if (result.timedOut) {
        return { ok: false, provider: "agy-cli", error: `agy timed out after ${timeoutMs}ms` };
      }

      // Output bound: over-cap is an error, never a (possibly truncated) success.
      if (byteLength(result.stdout) > maxBytes) {
        return { ok: false, provider: "agy-cli", error: `agy output exceeded ${maxBytes} byte cap` };
      }

      const answer = stripAnsi(result.stdout).trim();
      const exitedClean = result.code === 0;

      // Auth markers only matter on a FAILED exit. agy runs a GENERAL prose model, so a real answer
      // can legitimately quote phrases like "sign in" or "/login" — a clean exit with real content is
      // never an auth wall. (An actual auth failure exits non-zero / null and has no usable answer.)
      const combined = stripAnsi(`${result.stdout}\n${result.stderr}`).toLowerCase();
      const hasAuthMarker = !exitedClean && AUTH_MARKERS.some((marker) => combined.includes(marker));

      if (answer.length === 0 || hasAuthMarker) {
        // No usable answer → NEVER success. Auth markers / non-zero exit → unavailable (fall through).
        const unavailable = hasAuthMarker || !exitedClean;
        return {
          ok: false,
          provider: "agy-cli",
          error: hasAuthMarker
            ? "agy is not authenticated"
            : `agy produced no answer (exit ${result.code ?? "null"})`,
          ...(unavailable ? { unavailable: true } : {})
        };
      }

      return { ok: true, provider: "agy-cli", model, answer };
    }
  };
}
