import { existsSync, rmSync, writeFileSync } from "node:fs";
import { REVIVE_COMMAND } from "../run/tombstone.js";

/**
 * Disarm posture (ADR 0018, Phase S-1): the one-command "hands off the controls" switch.
 *
 * `/disarm` writes this file AND flips the {@link DISARM_FLAGS} to `"false"` in the live
 * `process.env` (the arming flags are read LIVE at every call site, so the effect is
 * immediate). The file makes the posture survive a restart: {@link applyDisarmPosture}
 * runs at the very top of `loadHougeEnv`, BEFORE the `.env` file is parsed — and because
 * `.env` loading is first-writer-wins (it never overwrites a variable already set), the
 * posture's `"false"` outranks any `HOUGE_*_ENABLED=true` in `.env`. It also outranks a
 * flag set in the real environment: the posture is the operator's STOP, and a stop that
 * a stale shell export could override would not be one.
 *
 * `/rearm` deletes the file; the flags re-apply from `.env`/env on the NEXT restart
 * (live re-enable would require remembering pre-disarm values — deliberately not done).
 *
 * NOTE: `HOUGE_DISARM_PATH` must be a REAL environment variable (shell / launchd plist),
 * not a `.env` entry — the posture is read before `.env` exists in the process.
 */

/** Default posture path — repo root, beside `houge.kill` (cwd-relative). Gitignored. */
export const DEFAULT_DISARM_PATH = "houge.disarm";

/**
 * The flags `/disarm` forces to `"false"`: evolution (self-write, codex consult, ambient
 * skills) plus unattended autonomy (scheduler). Episodic memory stays ON — remembering a
 * conversation is not an autonomous action, and losing memory would punish the operator
 * for reaching for the brake.
 */
export const DISARM_FLAGS: readonly string[] = [
  "HOUGE_SELFWRITE_ENABLED",
  "HOUGE_CODEX_ENABLED",
  "HOUGE_SKILLS_ENABLED",
  "HOUGE_SCHEDULER_ENABLED"
];

export function resolveDisarmPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HOUGE_DISARM_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_DISARM_PATH;
}

/** Write the posture file (JSON body). Returns the path written. */
export function writeDisarmPosture(
  record: { disarmed_at: string; by: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const path = resolveDisarmPath(env);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** Whether the posture file exists. Content is irrelevant — presence IS the posture. */
export function disarmPosturePresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveDisarmPath(env));
}

/** Remove the posture file (`/rearm`). Missing file is a no-op. */
export function clearDisarmPosture(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(resolveDisarmPath(env), { force: true });
}

/**
 * If the posture file exists, force every {@link DISARM_FLAGS} entry to `"false"` in `env`.
 * Called from `loadHougeEnv` BEFORE the `.env` parse (restart survival) and from the
 * `/disarm` handler (immediate effect). Returns whether the posture was applied.
 */
export function applyDisarmPosture(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!disarmPosturePresent(env)) return false;
  for (const flag of DISARM_FLAGS) {
    env[flag] = "false";
  }
  return true;
}

/** The Telegram ack `/disarm` enqueues — lists exactly what was switched off. */
export function formatDisarmAckText(path: string): string {
  return [
    "🔒 Disarmed — evolution + unattended autonomy are OFF (episodic memory stays on):",
    ...DISARM_FLAGS.map((flag) => `• ${flag}=false`),
    `The posture survives restarts (${path}). /rearm re-enables on the next restart.`
  ].join("\n");
}

/** The Telegram ack `/rearm` enqueues — flags re-apply on the next restart, not live. */
export function formatRearmAckText(path: string): string {
  return [
    `🔓 Re-armed — posture file removed (${path}).`,
    `Flags re-apply from .env on the next restart: ${REVIVE_COMMAND}`
  ].join("\n");
}
