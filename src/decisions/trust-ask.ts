import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import type { TrustLevel } from "./entries/turn-trust.js";
import { isReadOnlyCommand } from "./shell-readonly.js";

/**
 * The trust half of tool.policy's ask (spec §7.2; ADR 0029 decision 2: ask := code_ask ∨ trust_ask). It only ever ADDS a
 * tap; it never denies and never lifts a code ask. The reasons are code-owned card lines (exported for tests).
 */
export const HOSTILE_REASON = "this turn read text aimed at the assistant";
export const UNTRUSTED_REASON = "this turn read outside content (web, mail, calendar or network shell output)";
export const UNTRUSTED_ASK_ENTRIES: ReadonlySet<string> = new Set(["lesson_write", "schedule_task", "self_write_propose", "skill_author"]);
const SHELL_ENTRIES: ReadonlySet<string> = new Set(["shell", "shell_external", "shell_destructive"]);
/**
 * Spec §7.2 "every write asks" at hostile, held as an allowlist: only these reads stay tap-free (OMP_LOOP_TOOL_META marks
 * them read or none; fs_read is the built-in reader). Any other entry, a future one included, asks (Ruling: fail closed).
 */
const HOSTILE_READS: ReadonlySet<string> = new Set(["web_search", "http_fetch", "to_local_time", "self_diagnose", "gmail_read", "google_api",
  "houge_status", "memory_correct", "fs_read"]);
export type TrustAsk = { ask: false } | { ask: true; reason: string };
const NO: TrustAsk = { ask: false };
const HOSTILE_ASK: TrustAsk = { ask: true, reason: HOSTILE_REASON };

export function trustAsk(level: TrustLevel, entry: string, command?: string): TrustAsk {
  if (level === "clean") return NO;
  if (UNTRUSTED_ASK_ENTRIES.has(entry)) return { ask: true, reason: level === "hostile" ? HOSTILE_REASON : UNTRUSTED_REASON };
  if (level !== "hostile") return NO;
  if (SHELL_ENTRIES.has(entry)) return command !== undefined && isReadOnlyCommand(command) ? NO : HOSTILE_ASK;
  return HOSTILE_READS.has(entry) ? NO : HOSTILE_ASK;
}

/** Spec §7.2 / ADR 0029 decision 2: three added taps a local date. */
export const TRUST_TAP_BUDGET = 3;
const BUDGET_KIND: ReadonlySet<string> = new Set(["trust_tap_budget"]);

/** Counts one trust ask; pages at the budget (the taps still ask); a new date's first ask resolves yesterday's page. */
export function countTrustAsk(store: RunStore, env: NodeJS.ProcessEnv, now: string): number {
  const date = formatInstantInZone(now, resolveDisplayZone(env)).slice(0, 10);
  const n = store.bumpTrustTapBudget(date, now);
  if (n === 1) resolveOpenIncidents(store, BUDGET_KIND, undefined, now);
  if (n >= TRUST_TAP_BUDGET) openAlertedIncident(store, { kind: "trust_tap_budget", subject: date, detail: { count: n, budget: TRUST_TAP_BUDGET }, env, now });
  return n;
}

/** Spec §7.2: the hostile card shows target paths and byte counts when the command passes the 3000-char card cap. */
export function targetsLine(command: string): string {
  const paths = [...new Set(command.split(/[\s;|&<>()]+/).map((w) => w.replace(/^["']|["']$/g, ""))
    .filter((w) => /^(?:~|\.{1,2})?\//.test(w) && w.length > 1))].slice(0, 10);
  return `Targets: ${paths.join(", ") || "none named"} · ${Buffer.byteLength(command, "utf8")} bytes`;
}
