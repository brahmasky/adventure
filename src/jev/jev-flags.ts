import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Jev System One flags (ADR 0029 §3.8). Master + one tri-state flag per lane; everything defaults OFF. */
export type JevTriageMode = "off" | "shadow" | "arm";
export const JEV_DISARM_MARKER = "houge.jev-disarmed";

const ON = new Set(["1", "true", "yes", "on"]);

export function resolveJevEnabled(env: NodeJS.ProcessEnv): boolean {
  return ON.has(env.HOUGE_JEV_ENABLED?.trim().toLowerCase() ?? "");
}

/** `/disarm` writes "false" into every DISARM_FLAGS entry; the lane flag reads any non-mode value as off. */
export function resolveJevTriageMode(env: NodeJS.ProcessEnv, dataDir: string): JevTriageMode {
  if (!resolveJevEnabled(env)) return "off";
  const raw = env.HOUGE_JEV_TRIAGE_ENABLED?.trim().toLowerCase();
  const mode: JevTriageMode = raw === "shadow" || raw === "arm" ? raw : "off";
  // The auto-disable marker (spec §5.8 triage_overrides, §3.7 drift) caps an armed lane at shadow; only Paco deletes it.
  // A calibration FILE is for gates only: outside HOUGE_JEV_GATE=1 it caps the lane at shadow too (arming sequence, Task 3).
  const fileOutsideGate = Boolean(env.HOUGE_JEV_CALIBRATION_FILE?.trim()) && env.HOUGE_JEV_GATE !== "1";
  return mode === "arm" && (fileOutsideGate || readJevDisarmMarker(jevDisarmMarkerPath(env, dataDir))) ? "shadow" : mode;
}

export function jevDisarmMarkerPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  return env.HOUGE_JEV_DISARM_PATH?.trim() || join(dataDir, JEV_DISARM_MARKER);
}

export function writeJevDisarmMarker(path: string, reason: string, now: string = new Date().toISOString()): void {
  writeFileSync(path, JSON.stringify({ reason, at: now }), { mode: 0o600 });
}

export function readJevDisarmMarker(path: string): { reason: string; at: string } | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as { reason?: unknown; at?: unknown };
    return { reason: typeof v.reason === "string" ? v.reason : "unknown", at: typeof v.at === "string" ? v.at : "" };
  } catch {
    return { reason: "unreadable", at: "" }; // an unreadable marker still disarms: fail toward today
  }
}
