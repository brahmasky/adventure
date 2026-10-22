/**
 * `HOUGE_IMPROVE_ENABLED` (2b-ii follow-up 2): the improvement tick's switch, read live at every tick so `/disarm` (which writes
 * "false" into the running process env) stops it. Default ON; only the exact word `false`, any case, turns it off, so a typo
 * keeps the loop running instead of silencing it (the `HOUGE_DECISION_DIGEST_AT=off` precedent, ADR 0030: the newest, tested
 * default-on resolver; the older `0/no/off` family reads more words as off than anyone typed on purpose).
 */
export function resolveImproveEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.HOUGE_IMPROVE_ENABLED?.trim().toLowerCase() !== "false";
}
