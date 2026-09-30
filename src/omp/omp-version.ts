import { execFileSync } from "node:child_process";
import type { OmpConfig } from "./omp-config.js";

const defaultRun = (bin: string): string =>
  execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });

export function checkOmpVersion(
  cfg: OmpConfig,
  run: (bin: string) => string = defaultRun
): { ok: true; version: string } | { ok: false; version: string | null; reason: string } {
  let raw: string;
  try {
    raw = run(cfg.bin);
  } catch (e) {
    return { ok: false, version: null, reason: `omp not runnable: ${(e as Error).message}` };
  }
  const m = /omp\/(\d+\.\d+\.\d+)/.exec(raw);
  if (!m) return { ok: false, version: null, reason: "omp --version printed no version" };
  const version = m[1] as string;
  if (version === cfg.version || cfg.versionAllow.includes(version)) return { ok: true, version };
  return { ok: false, version, reason: `omp ${version} is not the pinned ${cfg.version}` };
}
