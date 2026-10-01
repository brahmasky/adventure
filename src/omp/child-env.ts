import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** The child env for every spawned CLI: an allowlist, never process.env wholesale (ADR 0015 §5). */
export const CLI_ENV_ALLOWLIST = ["PATH", "HOME", "TERM", "LANG", "USER"] as const;

/**
 * A sandboxed child's TMPDIR: `<its workspace>/.tmp`, created by the daemon (0700). The profiles deny
 * /private/var/folders (os.tmpdir()), so without it a child's temp files would land in planner-writable /tmp (B13).
 */
export function childTmpDir(workspace: string): string {
  const dir = join(workspace, ".tmp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function buildChildEnv(passthrough: string[] | string | undefined): Record<string, string> {
  const extra = Array.isArray(passthrough) ? passthrough : (passthrough ?? "").split(",");
  const allowed = new Set<string>(CLI_ENV_ALLOWLIST);
  for (const name of extra.map((n) => n.trim())) if (name.length > 0) allowed.add(name);
  const env: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// Shared spawn machinery for the CLI legs that are not omp (the agy-cli voice leg): a single-shot
// child with OUR timeout (SIGKILL on the whole process group), a hard stdout byte cap, and a total
// result (resolve every outcome, never reject). Moved here from llm/providers/cli-spawn.ts when the
// pi/kimi/gemini providers were deleted (Task 14, ruling 3); buildChildEnv is its env allowlist.

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
   * Text written to the child's stdin. A CLI that reads its prompt from stdin gets it THIS way
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
 * Grace period after a SIGKILL before we stop waiting for `close` and settle anyway. `close` fires
 * only once the child has exited AND its stdio streams have closed — and an AGENTIC CLI's
 * grandchild inherits the stdout write end, so a surviving grandchild holds the pipe open and
 * `close` never arrives. Without this the promise never settles, and because the daemon's poll loop
 * is a single serialized `while`, one such call stops Telegram polling, every scheduled tick, the
 * outbox flush, and the heartbeat — permanently, and invisibly to `/status`, which the same loop
 * writes. The timeout must therefore be authoritative on its own, not contingent on the pipe.
 */
const KILL_GRACE_MS = 2_000;

/**
 * Default spawn impl: uses `spawn` so a prompt can be written to the child's stdin, resolving (never rejecting) a SpawnResult. Enforces our own timeout (SIGKILL) and a hard
 * stdout byte cap (kills on overflow).
 *
 * Children are spawned DETACHED so each gets its own process group and a kill reaches the whole
 * tree, not just the leader — `agy` is agentic and may spawn tool grandchildren that outlive it.
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

    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true });

    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ ...result, stdout: result.stdout + stdoutDecoder.end(), stderr: result.stderr + stderrDecoder.end() });
    };

    /**
     * Kill the child's whole PROCESS GROUP, then start the grace timer. Killing only the leader
     * leaves tool grandchildren alive holding our stdout pipe, which is what would hang `close`.
     */
    const killTree = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // ESRCH (already gone) or EPERM — fall back to the leader, then let the grace timer settle.
        try {
          child.kill("SIGKILL");
        } catch {
          /* nothing left to kill */
        }
      }
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          // `close` never came — a grandchild still holds the pipe. Settle on what we have.
          finish({ code: null, stdout, stderr, timedOut });
        }, KILL_GRACE_MS);
        graceTimer.unref?.();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
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
          killTree();
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
