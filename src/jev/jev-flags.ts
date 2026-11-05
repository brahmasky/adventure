import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disarmPosturePresent } from "../config/disarm-posture.js";

/** Jev System One front-door flags (ADR 0034 1.6): the master flag, the disarm posture and marker; everything defaults OFF. */
export type JevTriageMode = "off" | "arm";
export const JEV_DISARM_MARKER = "houge.jev-disarmed";

const ON = new Set(["1", "true", "yes", "on"]);

export function resolveJevEnabled(env: NodeJS.ProcessEnv): boolean {
  return ON.has(env.HOUGE_JEV_ENABLED?.trim().toLowerCase() ?? "");
}

export function jevDisarmMarkerPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  return env.HOUGE_JEV_DISARM_PATH?.trim() || join(dataDir, JEV_DISARM_MARKER);
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

export type FrontDoorCause = "armed" | "disarmed" | "env_off" | "calibration_file" | "disarm_marker";
export interface FrontDoor { mode: JevTriageMode; cause: FrontDoorCause }

/**
 * The front door's arming (ADR 0034 1.6; spec 2026-11-05 §4). First match wins. `disarmed` needs the flag off AND the
 * posture file: in the daemon /disarm sets both, but a gate's child env can carry the file with the flag on, and then the
 * flag decides. Both caps fail toward the planner (off), as they failed toward shadow before.
 */
export function resolveJevFrontDoor(env: NodeJS.ProcessEnv, dataDir: string): FrontDoor {
  if (!resolveJevEnabled(env)) return { mode: "off", cause: disarmPosturePresent(env) ? "disarmed" : "env_off" };
  if (Boolean(env.HOUGE_JEV_CALIBRATION_FILE?.trim()) && env.HOUGE_JEV_GATE !== "1") return { mode: "off", cause: "calibration_file" };
  if (readJevDisarmMarker(jevDisarmMarkerPath(env, dataDir))) return { mode: "off", cause: "disarm_marker" };
  return { mode: "arm", cause: "armed" };
}

const FRONT_DOOR_TEXT: Readonly<Record<FrontDoorCause, string>> = {
  armed: "Jev front door: armed",
  disarmed: "Jev front door: off (/disarm; /rearm restores it)",
  env_off: "Jev front door: off (HOUGE_JEV_ENABLED is off in this process: .env, or /rearm awaiting a restart)",
  calibration_file: "Jev front door: off (HOUGE_JEV_CALIBRATION_FILE is set outside a gate)",
  disarm_marker: "Jev front door: off (houge.jev-disarmed marker from an older build; remove it by hand)"
};

/** The `/status` line (spec §7): names env vars, never values. */
export function frontDoorLine(env: NodeJS.ProcessEnv, dataDir: string): string {
  try {
    return FRONT_DOOR_TEXT[resolveJevFrontDoor(env, dataDir).cause];
  } catch (e) {
    console.error(`jev: front-door status check failed: ${e instanceof Error ? e.message : String(e)}`);
    return "Jev front door: unknown (check failed)";
  }
}

/** Retired by spec 2026-11-05 (ADR 0034 1.6): read for no behaviour; named here only for the boot warning. */
export const RETIRED_JEV_FLAGS = ["HOUGE_JEV_LANES_OFF", "HOUGE_JEV_TRIAGE_ENABLED"] as const;

/** Would this value have changed behaviour on the old build? `TRIAGE=arm` is the live, rollback-safe value: silent. */
function retiredValueMatters(name: (typeof RETIRED_JEV_FLAGS)[number], v: string | undefined): boolean {
  if (v === undefined) return false;
  return name === "HOUGE_JEV_TRIAGE_ENABLED" ? v.trim().toLowerCase() !== "arm" : v.trim().length > 0;
}

/** Boot only (spec §5): one error line per retired var whose value would have changed behaviour; fail loud, run on. */
export function warnRetiredJevFlags(env: NodeJS.ProcessEnv, log: (line: string) => void = console.error): string[] {
  const warned = RETIRED_JEV_FLAGS.filter((n) => retiredValueMatters(n, env[n]));
  for (const n of warned) log(`jev: ${n} is retired (ADR 0034 1.6) and ignored; remove it from .env`);
  return warned;
}
