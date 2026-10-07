import { execFileSync } from "node:child_process";
import type { OmpConfig } from "./omp-config.js";

const defaultRun = (bin: string): string =>
  execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });

/**
 * Why a version check refused: omp could not be asked at all (`omp_unavailable`). There is no pinned version
 * (Paco, 2026-10-07): any version omp reports is accepted and returned for houge_status.
 */
export type OmpCheckKind = "not_runnable" | "no_version";
export interface OmpCheckFailure { ok: false; kind: OmpCheckKind; version: string | null; reason: string }
export type OmpCheckResult = { ok: true; version: string } | OmpCheckFailure;

export function checkOmpVersion(
  cfg: Pick<OmpConfig, "bin">,
  run: (bin: string) => string = defaultRun
): { ok: true; version: string } | OmpCheckFailure {
  let raw: string;
  try {
    raw = run(cfg.bin);
  } catch (e) {
    return { ok: false, kind: "not_runnable", version: null, reason: `omp not runnable: ${(e as Error).message}` };
  }
  const m = /omp\/(\d+\.\d+\.\d+)/.exec(raw);
  if (!m) return { ok: false, kind: "no_version", version: null, reason: "omp --version printed no version" };
  return { ok: true, version: m[1] as string };
}
