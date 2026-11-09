import type { RunStore } from "../run/run-store.js";
import { ADDRESS_RE } from "./envelope.js";

/** Mail triage env switches (spec 2026-11-09 §3.1, §8.3). Default OFF; in DISARM_FLAGS. */
export function resolveMailEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_MAIL_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function mailPollMinutes(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_MAIL_POLL_MIN);
  if (!env.HOUGE_MAIL_POLL_MIN || !Number.isFinite(n)) return 5;
  return Math.min(60, Math.max(2, Math.floor(n)));
}

const DEFAULT_QUIET = { start: 23, end: 7 };
export function mailQuietWindow(env: NodeJS.ProcessEnv): { start: number; end: number } {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(env.HOUGE_MAIL_QUIET?.trim() ?? "");
  if (!m) return { ...DEFAULT_QUIET };
  const start = Number(m[1]);
  const end = Number(m[2]);
  return start > 23 || end > 23 ? { ...DEFAULT_QUIET } : { start, end };
}

export function mailTextDays(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_MAIL_TEXT_DAYS);
  if (!env.HOUGE_MAIL_TEXT_DAYS || !Number.isFinite(n)) return 30;
  return Math.max(1, Math.floor(n));
}

/** Paco's inbox may be read only when the env switch AND the stored `/mail on` switch are both on. */
export function pacoMailReadable(env: NodeJS.ProcessEnv, store: Pick<RunStore, "mailState">): boolean {
  return resolveMailEnabled(env) && store.mailState().enabled;
}

export function pacoAddress(env: NodeJS.ProcessEnv): string | undefined {
  const a = env.HOUGE_PACO_GMAIL_ADDRESS?.trim();
  return a && ADDRESS_RE.test(a) ? a.toLowerCase() : undefined;
}
