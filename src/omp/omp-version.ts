import { execFileSync } from "node:child_process";
import type { OmpConfig } from "./omp-config.js";

const defaultRun = (bin: string): string =>
  execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });

/**
 * Why a version check refused. Only `version_mismatch` means a version was READ and differs from
 * the pin; the other two mean omp could not be asked at all (`omp_unavailable`, not a mismatch).
 */
export type OmpCheckKind = "version_mismatch" | "not_runnable" | "no_version";
export interface OmpCheckFailure { ok: false; kind: OmpCheckKind; version: string | null; reason: string }

export function checkOmpVersion(
  cfg: OmpConfig,
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
  const version = m[1] as string;
  if (version === cfg.version || cfg.versionAllow.includes(version)) return { ok: true, version };
  return { ok: false, kind: "version_mismatch", version, reason: `omp ${version} is not the pinned ${cfg.version}` };
}
