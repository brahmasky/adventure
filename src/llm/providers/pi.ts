// Policy: single-shot, tools-disabled, env-allowlisted, killable `pi` inference
// is classified `external_read` (ungated). Full agentic `coding_agent_cli`
// delegation (tools enabled) stays denied until V2 containment. See the
// "LLM providers > Policy amendment" section in README.md.
import { execFile } from "node:child_process";
import os from "node:os";
import type { LlmProvider, LlmRequest, LlmResult } from "../types.js";

/**
 * Result shape returned by a {@link SpawnImpl}. The impl must RESOLVE this shape
 * for every outcome (success, non-zero exit, timeout, spawn failure) and must
 * NEVER reject — the provider relies on a total function for deterministic
 * error handling.
 */
export interface SpawnResult {
  /** Process exit code; `null` when killed (e.g. timeout) or spawn failed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when OUR timeout fired and the child was killed. */
  timedOut: boolean;
  /** Set when the process could not be spawned (e.g. ENOENT: binary missing). */
  spawnError?: { code?: string };
}

export interface SpawnOpts {
  timeoutMs: number;
  cwd: string;
  env: Record<string, string>;
  maxBytes: number;
}

export type SpawnImpl = (
  file: string,
  args: string[],
  opts: SpawnOpts
) => Promise<SpawnResult>;

export interface PiProviderConfig {
  model?: string;
  timeoutMs?: number;
  maxBytes?: number;
  spawnImpl?: SpawnImpl;
}

export const PI_DEFAULT_TIMEOUT_MS = 60_000;
export const PI_DEFAULT_MAX_BYTES = 262_144; // 256 KB
export const PI_BINARY = "pi";

/**
 * Env var names the pi child is always allowed to inherit. Deliberately minimal:
 * the question is attacker-controlled, so the child must NOT see the Telegram
 * bot token or unrelated API keys. Extra var names may be opted in via
 * HOUGE_PI_ENV_PASSTHROUGH (comma-separated).
 */
const ENV_ALLOWLIST = ["PATH", "HOME", "TERM", "LANG", "USER"] as const;

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

function buildChildEnv(passthroughRaw: string | undefined): Record<string, string> {
  const allowed = new Set<string>(ENV_ALLOWLIST);
  if (passthroughRaw) {
    for (const name of passthroughRaw.split(",").map((n) => n.trim())) {
      if (name.length > 0) allowed.add(name);
    }
  }
  const env: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface ParsedAnswer {
  /** Text from the LAST assistant `message_end` (preferred). */
  messageEndText: string | undefined;
  /** Accumulated `text_delta` deltas (fallback). */
  deltaText: string;
}

/** Parse pi's JSONL (`--mode json`) stdout line-by-line, defensively. */
function parsePiJsonl(stdout: string): ParsedAnswer {
  let messageEndText: string | undefined;
  let deltaText = "";

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

  return { messageEndText, deltaText };
}

function extractAnswer(parsed: ParsedAnswer): string | undefined {
  if (parsed.messageEndText && parsed.messageEndText.length > 0) {
    return parsed.messageEndText;
  }
  if (parsed.deltaText.length > 0) return parsed.deltaText;
  return undefined;
}

/** Default spawn impl: wraps execFile, resolving (never rejecting) a SpawnResult. */
const defaultSpawnImpl: SpawnImpl = (file, args, opts) =>
  new Promise<SpawnResult>((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: opts.maxBytes,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          const timedOut = e.killed === true && e.signal === "SIGKILL";
          const base: SpawnResult = {
            code: typeof e.code === "number" ? e.code : null,
            stdout: out,
            stderr: err,
            timedOut
          };
          // A string `code` (e.g. "ENOENT") signals a spawn-level failure.
          if (typeof e.code === "string") base.spawnError = { code: e.code };
          resolve(base);
          return;
        }
        resolve({ code: 0, stdout: out, stderr: err, timedOut: false });
      }
    );
  });

export function createPiProvider(config: PiProviderConfig = {}): LlmProvider {
  const spawnImpl = config.spawnImpl ?? defaultSpawnImpl;

  return {
    name: "pi",
    async answer(req: LlmRequest): Promise<LlmResult> {
      const model =
        req.model ??
        config.model ??
        process.env.HOUGE_LLM_MODEL_PI ??
        process.env.HOUGE_LLM_MODEL;

      const timeoutMs =
        config.timeoutMs ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS_PI) ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS) ??
        PI_DEFAULT_TIMEOUT_MS;

      const maxBytes = config.maxBytes ?? PI_DEFAULT_MAX_BYTES;

      const args = [
        "-p",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--mode",
        "json",
        ...(model ? ["--model", model] : []),
        "--",
        req.question
      ];

      const env = buildChildEnv(process.env.HOUGE_PI_ENV_PASSTHROUGH);

      let result: SpawnResult;
      try {
        result = await spawnImpl(PI_BINARY, args, {
          timeoutMs,
          cwd: os.tmpdir(),
          env,
          maxBytes
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

      // Output bound: over-cap is an error, never a (possibly truncated) success.
      if (byteLength(result.stdout) > maxBytes) {
        return {
          ok: false,
          provider: "pi",
          error: `pi output exceeded ${maxBytes} byte cap`
        };
      }

      const parsed = parsePiJsonl(result.stdout);
      const answer = extractAnswer(parsed);

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
      return {
        ok: true,
        provider: "pi",
        model: model ?? "pi-default",
        answer
      };
    }
  };
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
