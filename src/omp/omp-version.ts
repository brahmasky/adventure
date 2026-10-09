import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { OmpConfig } from "./omp-config.js";

const VERSION_ARGS = ["--version"];
const VERSION_OPTS = { encoding: "utf8" as const, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
const execFileAsync = promisify(execFile);

const defaultRun = (bin: string): string => execFileSync(bin, VERSION_ARGS, VERSION_OPTS);
/**
 * Same command, args and timeout as defaultRun, without blocking the event loop (Jev's call is in flight at spawn).
 * execFile ignores `stdio` and always captures stderr (into the error's message): notRunnable never reads the message.
 */
const defaultRunAsync = async (bin: string): Promise<string> => (await execFileAsync(bin, VERSION_ARGS, VERSION_OPTS)).stdout;

/**
 * Why a version check refused: omp could not be asked at all (`omp_unavailable`). There is no pinned version
 * (Paco, 2026-10-07): any version omp reports is accepted and returned for houge_status.
 */
export type OmpCheckKind = "not_runnable" | "no_version";
export interface OmpCheckFailure { ok: false; kind: OmpCheckKind; version: string | null; reason: string }
export type OmpCheckResult = { ok: true; version: string } | OmpCheckFailure;

/** The reason reaches the omp_unavailable error_ref: the exit code, errno code or signal only, never omp's own text (stderr). */
function notRunnable(e: unknown): OmpCheckFailure {
  // execFile reports an exit status as `code`, execFileSync as `status`; a spawn failure as an errno `code` (ENOENT)
  const { code, status, signal } = (e ?? {}) as { code?: unknown; status?: unknown; signal?: unknown };
  const why = [code, status, signal].find((v) => typeof v === "string" || typeof v === "number") ?? "error";
  return { ok: false, kind: "not_runnable", version: null, reason: `omp not runnable: ${why}` };
}

function parseVersion(raw: string): OmpCheckResult {
  const m = /omp\/(\d+\.\d+\.\d+)/.exec(raw);
  if (!m) return { ok: false, kind: "no_version", version: null, reason: "omp --version printed no version" };
  return { ok: true, version: m[1] as string };
}

export function checkOmpVersion(cfg: Pick<OmpConfig, "bin">, run: (bin: string) => string = defaultRun): OmpCheckResult {
  let raw: string;
  try { raw = run(cfg.bin); } catch (e) { return notRunnable(e); }
  return parseVersion(raw);
}

/** checkOmpVersion without blocking the event loop: the spawn paths (planner child, one-shot seats) await this one. */
export async function checkOmpVersionAsync(
  cfg: Pick<OmpConfig, "bin">, run: (bin: string) => Promise<string> = defaultRunAsync
): Promise<OmpCheckResult> {
  let raw: string;
  try { raw = await run(cfg.bin); } catch (e) { return notRunnable(e); }
  return parseVersion(raw);
}
