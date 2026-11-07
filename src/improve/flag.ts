/**
 * The improvement tick's two knobs (spec 2026-11-07 §10). `HOUGE_IMPROVE_ENABLED` (2b-ii follow-up 2): the STOP switch, read
 * live at every tick so `/disarm` (which writes "false" into the running process env) stops it. Default ON; only the exact
 * word `false`, any case, turns it off, so a typo keeps the loop running instead of silencing it. `HOUGE_IMPROVE_AT`: the
 * tick's local time; no `off` (R13). The digest's `HOUGE_DECISION_DIGEST_AT` is retired: named once at boot, never read.
 */
export function resolveImproveEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.HOUGE_IMPROVE_ENABLED?.trim().toLowerCase() !== "false";
}

export const DEFAULT_IMPROVE_AT = "21:00";
/** `HH:MM` in HOUGE_DISPLAY_TZ; anything else (unset, a typo, `off`) is the default: a typo never moves the tick. */
export function resolveImproveAt(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_IMPROVE_AT?.trim();
  return raw !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_IMPROVE_AT;
}

/** Boot only: the digest is gone (ADR 0034 13.1); a still-set HOUGE_DECISION_DIGEST_AT is named once and ignored. */
export function warnRetiredDigestAt(env: NodeJS.ProcessEnv, log: (line: string) => void = console.error): boolean {
  if (env.HOUGE_DECISION_DIGEST_AT === undefined) return false;
  log("improve: HOUGE_DECISION_DIGEST_AT is retired (ADR 0034 13.1: no digest) and ignored; the tick's time is HOUGE_IMPROVE_AT; remove it from .env");
  return true;
}
