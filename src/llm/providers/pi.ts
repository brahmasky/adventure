// Policy: single-shot, tools-disabled, env-allowlisted, killable `pi` inference
// is classified `external_read` (ungated). Full agentic `coding_agent_cli`
// delegation (tools enabled) stays denied until V2 containment. See the
// "LLM providers > Policy amendment" section in README.md.
import { spawn } from "node:child_process";
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
  /**
   * Text written to the child's stdin. The attacker-controlled question is
   * delivered THIS way (not as an argv token), so a prompt that looks like a
   * flag (`--model evil`) can never be parsed as one. pi reads its prompt from
   * stdin in `-p` mode and does NOT support a `--` end-of-options separator.
   */
  input: string;
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
  /** Actual model id pi reported on the assistant message, for an accurate audit trail. */
  model: string | undefined;
}

/** Parse pi's JSONL (`--mode json`) stdout line-by-line, defensively. */
function parsePiJsonl(stdout: string): ParsedAnswer {
  let messageEndText: string | undefined;
  let deltaText = "";
  let model: string | undefined;

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

  return { messageEndText, deltaText, model };
}

function extractAnswer(parsed: ParsedAnswer): string | undefined {
  if (parsed.messageEndText && parsed.messageEndText.length > 0) {
    return parsed.messageEndText;
  }
  if (parsed.deltaText.length > 0) return parsed.deltaText;
  return undefined;
}

/**
 * Default spawn impl: uses `spawn` so the prompt is written to the child's
 * stdin (never argv), resolving (never rejecting) a SpawnResult. Enforces our
 * own timeout (SIGKILL) and a hard stdout byte cap (kills on overflow).
 */
const defaultSpawnImpl: SpawnImpl = (file, args, opts) =>
  new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env });

    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.on("error", (error: NodeJS.ErrnoException) => {
      // Spawn-level failure (e.g. ENOENT: binary missing).
      const spawnError: { code?: string } = {};
      if (error.code !== undefined) spawnError.code = error.code;
      finish({ code: null, stdout, stderr, timedOut, spawnError });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > opts.maxBytes) {
        // Keep just enough to exceed the cap so the provider detects overflow,
        // then kill to bound memory.
        if (!overflow) {
          overflow = true;
          stdout += chunk.toString("utf8");
          child.kill("SIGKILL");
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });

    // Deliver the prompt on stdin, then close it. Guard against EPIPE if the
    // child exited before consuming stdin.
    child.stdin?.on("error", () => {
      /* ignore broken-pipe; the close/error handler resolves the outcome */
    });
    child.stdin?.end(opts.input);
  });

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

      // The question is delivered on stdin (see SpawnOpts.input), NEVER as an
      // argv token — pi reads its prompt from stdin in -p mode and has no `--`
      // separator, so this is the only injection-safe form.
      //
      // `--no-tools` is the real safety lever (disables read/bash/edit/write,
      // built-in AND extension tools). We do NOT pass `--no-extensions` because
      // some providers (e.g. kimi-coder) are registered via a pi extension; with
      // tools already disabled, loading the extension only makes the model
      // reachable, not capable of side effects.
      const args = [
        "-p",
        "--no-tools",
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--mode",
        "json",
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
        // Prefer the model pi actually reported, then the configured one.
        model: parsed.model ?? model ?? "pi-default",
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
