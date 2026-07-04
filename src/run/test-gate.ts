import { execFileSync } from "node:child_process";
import { execFileAsync } from "./exec-file-async.js";

/**
 * Test gate (Phase 3, checker 2 — ADR 0011 §7 / spec docs/superpowers/specs/2026-06-25-phase3-code-self-write.md).
 *
 * Runs the project's objective eval INSIDE a self-write worktree — `npm run typecheck`,
 * then `npm test`, then `npm run build` — stopping at the first red stage. This is the
 * deterministic, ungameable truth check: a self-authored diff that doesn't compile or
 * turns a test red never reaches the (more expensive) reviewer or the published branch.
 *
 * Mirrors `coding-agent.ts`: shells with `cwd: <worktree>`, a wall-clock timeout
 * (`resolveTestGateTimeoutMs`), and a CAP on captured output so a huge failure log
 * can't blow memory. Never throws — a spawn error / non-zero exit maps to a red result.
 *
 * ⓪·3g: the SELF-WRITE pipeline uses {@link runTestGateAsync} (promisified spawns so the
 * daemon's event loop keeps breathing during the multi-minute npm runs); the MERGE path
 * keeps the synchronous {@link runTestGate} deliberately — mergeAndReload stays sync end
 * to end because it terminates in a self-restart. Same stages, same order, same caps.
 */

const DEFAULT_TEST_GATE_TIMEOUT_MS = 300_000;
/** Cap on captured output (last N bytes). A red `npm test` log can be enormous. */
const OUTPUT_CAP_BYTES = 8 * 1024;

export type TestGateStage = "typecheck" | "test" | "build";

export type TestGateResult =
  | { green: true }
  | { green: false; stage: TestGateStage; output: string };

export interface TestGateOptions {
  /** Injectable env for config resolution (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Resolve the gate's wall-clock timeout in ms (`HOUGE_TESTGATE_TIMEOUT_MS`, default 300000). */
export function resolveTestGateTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_TESTGATE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TEST_GATE_TIMEOUT_MS;
}

/** The three stages, in order. Each runs the named npm script; stop at first failure. */
const STAGES: ReadonlyArray<{ stage: TestGateStage; script: string }> = [
  { stage: "typecheck", script: "typecheck" },
  { stage: "test", script: "test" },
  { stage: "build", script: "build" }
];

/** Keep only the last {@link OUTPUT_CAP_BYTES} bytes of a captured log. */
function capOutput(text: string): string {
  if (text.length <= OUTPUT_CAP_BYTES) return text;
  return text.slice(text.length - OUTPUT_CAP_BYTES);
}

interface NodeError extends Error {
  code?: string;
  status?: number | null;
  signal?: string | null;
  stdout?: Buffer | string | null;
  stderr?: Buffer | string | null;
}

/** Collect a spawn error's captured stdout+stderr (best-effort) into a capped string. */
function errorOutput(err: NodeError): string {
  const parts: string[] = [];
  const stdout = err.stdout != null ? err.stdout.toString() : "";
  const stderr = err.stderr != null ? err.stderr.toString() : "";
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  if (parts.length === 0) parts.push(err.message ?? "unknown error");
  return capOutput(parts.join("\n"));
}

/**
 * Run the objective eval (typecheck → test → build) inside `worktree`. Returns
 * `{ green: true }` only if all three pass; otherwise `{ green: false, stage, output }`
 * for the first stage that fails. Never throws.
 */
export function runTestGate(worktree: string, opts?: TestGateOptions): TestGateResult {
  const env = opts?.env ?? process.env;
  const timeout = resolveTestGateTimeoutMs(env);

  for (const { stage, script } of STAGES) {
    try {
      execFileSync("npm", ["run", script], {
        cwd: worktree,
        timeout,
        // Capture both streams so a red stage's log can be surfaced (and capped).
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const err = error as NodeError;
      if (err.code === "ENOENT") {
        return { green: false, stage, output: capOutput(`npm not found: ${err.message}`) };
      }
      if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
        return { green: false, stage, output: `${stage} timed out after ${timeout}ms` };
      }
      return { green: false, stage, output: errorOutput(err) };
    }
  }

  return { green: true };
}

/**
 * Async twin of {@link runTestGate} (⓪·3g): identical stages, order, timeout, and output
 * caps — the npm children just run via promisified spawns so the poll loop interleaves.
 */
export async function runTestGateAsync(worktree: string, opts?: TestGateOptions): Promise<TestGateResult> {
  const env = opts?.env ?? process.env;
  const timeout = resolveTestGateTimeoutMs(env);

  for (const { stage, script } of STAGES) {
    try {
      await execFileAsync("npm", ["run", script], { cwd: worktree, timeout });
    } catch (error) {
      const err = error as NodeError;
      if (err.code === "ENOENT") {
        return { green: false, stage, output: capOutput(`npm not found: ${err.message}`) };
      }
      if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
        return { green: false, stage, output: `${stage} timed out after ${timeout}ms` };
      }
      return { green: false, stage, output: errorOutput(err) };
    }
  }

  return { green: true };
}
