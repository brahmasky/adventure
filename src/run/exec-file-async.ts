import { execFile } from "node:child_process";

/**
 * Promisified `execFile` that mirrors `execFileSync`'s contract (⓪·3g "THE LANE FIX").
 *
 * The evolution pipeline's child processes (writer/reviewer/test-gate/git) were spawned
 * with `execFileSync`, freezing the single-threaded daemon's event loop for the whole
 * spawn (10–19 min live) — messages queued unanswered and Telegram expired unfetched
 * callback taps. This helper keeps the CALLING CONTRACT identical (stdin `input`,
 * `timeout`, `maxBuffer`, `cwd`, `env`; throws on non-zero exit with `status`/`signal`/
 * `stdout`/`stderr` shaped like a sync error) while yielding the event loop.
 *
 *  - A non-zero exit rejects with `status` = the exit code (execFile puts it on `code`;
 *    we mirror it onto `status` so existing `err.status` handling keeps working).
 *  - A timeout kills the child with SIGTERM and rejects with `signal: "SIGTERM"` —
 *    matching the `err.signal === "SIGTERM"` checks the sync call sites already use.
 *  - ENOENT rejects with `code: "ENOENT"` exactly as before.
 */

export interface ExecFileAsyncOptions {
  /** Written to the child's stdin, then stdin is closed (execFileSync's `input`). */
  input?: string;
  /** Wall-clock cap in ms; expiry kills the child with SIGTERM. */
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExecFileAsyncError extends Error {
  code?: string | number;
  /** Exit code on a non-zero exit (mirrors execFileSync), else null/undefined. */
  status?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

export function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileAsyncOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        killSignal: "SIGTERM"
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as ExecFileAsyncError;
          // execFile reports the exit code on `code`; execFileSync callers read `status`.
          if (typeof err.code === "number") err.status = err.code;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
    // stdin: write the input then close (or just close, matching stdio "ignore"/"pipe").
    // An early-exiting child EPIPEs the write — swallowed; the exit error surfaces instead.
    child.stdin?.on("error", () => {});
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}
