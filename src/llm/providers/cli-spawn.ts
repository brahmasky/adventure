// Shared spawn machinery for CLI-backed LLM providers (pi, agy). A single-shot child
// process with OUR timeout (SIGKILL), a hard stdout byte cap (kill on overflow), and a
// total-function result (resolve every outcome, never reject) so providers can do
// deterministic error handling. The prompt-delivery channel differs per CLI (pi reads
// stdin; agy takes an argv value) — that is the caller's concern, not this module's.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Result shape returned by a {@link SpawnImpl}. The impl must RESOLVE this shape for every
 * outcome (success, non-zero exit, timeout, spawn failure) and must NEVER reject — providers
 * rely on a total function for deterministic error handling.
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
   * Text written to the child's stdin. pi delivers the attacker-controlled question THIS way
   * (never as an argv token) so a prompt that looks like a flag can never be parsed as one.
   * CLIs that take the prompt on argv instead pass an empty string here.
   */
  input: string;
}

export type SpawnImpl = (
  file: string,
  args: string[],
  opts: SpawnOpts
) => Promise<SpawnResult>;

/**
 * Default spawn impl: uses `spawn` so the prompt can be written to the child's stdin (never argv
 * for pi), resolving (never rejecting) a SpawnResult. Enforces our own timeout (SIGKILL) and a hard
 * stdout byte cap (kills on overflow).
 */
export const defaultSpawnImpl: SpawnImpl = (file, args, opts) =>
  new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env });

    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: result.stdout + stdoutDecoder.end(), stderr: result.stderr + stderrDecoder.end() });
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
          stdout += stdoutDecoder.write(chunk);
          child.kill("SIGKILL");
        }
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
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

/**
 * Env var names a CLI child is always allowed to inherit. Deliberately minimal: the question is
 * attacker-controlled, so the child must NOT see the Telegram bot token or unrelated API keys. Extra
 * var names are opted in per-provider (e.g. HOUGE_PI_ENV_PASSTHROUGH / HOUGE_AGY_ENV_PASSTHROUGH).
 */
export const CLI_ENV_ALLOWLIST = ["PATH", "HOME", "TERM", "LANG", "USER"] as const;

/** Build the child env from the allowlist plus any comma-separated opt-in passthrough names. */
export function buildChildEnv(passthroughRaw: string | undefined): Record<string, string> {
  const allowed = new Set<string>(CLI_ENV_ALLOWLIST);
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
