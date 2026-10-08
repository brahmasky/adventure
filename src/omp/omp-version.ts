import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { OmpConfig } from "./omp-config.js";

const VERSION_ARGS = ["--version"];
const VERSION_OPTS = { encoding: "utf8" as const, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
const execFileAsync = promisify(execFile);

const defaultRun = (bin: string): string => execFileSync(bin, VERSION_ARGS, VERSION_OPTS);
/** Same command, timeout and stdio as defaultRun, without blocking the event loop (Jev's call is in flight at spawn). */
const defaultRunAsync = async (bin: string): Promise<string> => (await execFileAsync(bin, VERSION_ARGS, VERSION_OPTS)).stdout;

/**
 * Why a version check refused: omp could not be asked at all (`omp_unavailable`). There is no pinned version
 * (Paco, 2026-10-07): any version omp reports is accepted and returned for houge_status.
 */
export type OmpCheckKind = "not_runnable" | "no_version";
export interface OmpCheckFailure { ok: false; kind: OmpCheckKind; version: string | null; reason: string }
export type OmpCheckResult = { ok: true; version: string } | OmpCheckFailure;

const notRunnable = (e: unknown): OmpCheckFailure =>
  ({ ok: false, kind: "not_runnable", version: null, reason: `omp not runnable: ${(e as Error).message}` });

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
