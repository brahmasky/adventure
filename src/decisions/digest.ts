import { STANDING_DIGEST_TEXT } from "../run/run-store.js";

/**
 * What is left of the daily decision digest (gone since spec 2026-11-07; ADR 0034 13.1): improvements apply on their own or
 * arrive as cards (improve/proposal-card.ts), applied improvements and standing-grant ends are /changes rows, faults page
 * `improve_tick_degraded`, and the counts live in /status (decisions/status-lines.ts). The callback prefixes stay so every
 * card and every button on an old message still parses; the standing text stays with its row.
 */
export { STANDING_DIGEST_TEXT };
/** The review tap's callback prefix (`dec:rv:<decision_id>:<ok|bad>`); the parser imports it and an old tap is answered "closed". */
export const REVIEW_PREFIX = "dec:rv:";
/** The callback prefixes of telegram-command-parser.ts (`PR_PREFIX` / `LM_PREFIX`); that file imports this one, so they are literals here and a test pins the pair. */
export const DIGEST_PR_PREFIX = "dec:pr:";
export const DIGEST_LM_PREFIX = "dec:lm:";
