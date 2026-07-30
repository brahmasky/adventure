import type { NotificationIntent } from "../notifications/notification-types.js";
import { computeNextRunAt, type ScheduleWeekday } from "../run/schedule-spec.js";
import type { SkillStore } from "../skills/skill-store.js";
import { resolveSkillsEnabled } from "../skills/skill-store.js";
import {
  resolveGateBPasses,
  resolveGateBThreshold,
  verifySkill,
  type AnchorLlm
} from "./anchor-verify.js";
import { resolveRadarTz } from "./idea-radar.js";
import { escapeForTelegram } from "./text-hygiene.js";

/**
 * Weekly SUGGEST-ONLY skill re-verify advisor (skill retirement spec, 2026-07-29 — the
 * deferred Phase-2c "re-verify existing skills" backlog item). Once per week at the pinned
 * wall-clock slot, every skill whose `last_verified` is stale gets a fresh Gate B pass:
 * passers are re-stamped in place (`SkillStore.stampVerification` — no version bump),
 * failers are flagged to Paco with ONE quiet Telegram note suggesting `/skills retire`.
 * It NEVER moves files — the retire decision stays with the operator. Flag-gated OFF
 * (`HOUGE_SKILL_REVERIFY_ENABLED`, in DISARM_FLAGS), weekly latch stamped BEFORE any LLM
 * call (M3 posture, like the idea panel), and never throws into the daemon.
 */

/** The documented default slot: Sunday 10:00 (radar tz) — after the panel's sun 09:00. */
export const REVERIFY_DEFAULT_SCHEDULE: { day: ScheduleWeekday; at: string } = {
  day: "sun",
  at: "10:00"
};

/** Default staleness horizon: a skill unverified for >28 days is a re-verify candidate. */
const DEFAULT_AGE_DAYS = 28;

const DAY_MS = 86_400_000;

/** Failing criteria shown per flagged skill in the report (the rest is noise at a glance). */
const REPORT_FAILING_CAP = 3;

const REVERIFY_WEEKDAYS: ReadonlySet<string> = new Set([
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat"
]);

/** Same shape as schedule-spec's AT_PATTERN: zero-padded 24h `HH:MM` (so `9:00` is malformed). */
const REVERIFY_AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether the advisor is armed (`HOUGE_SKILL_REVERIFY_ENABLED`). Default OFF — "1" arms. */
export function resolveSkillReverifyEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_SKILL_REVERIFY_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Resolve `HOUGE_SKILL_REVERIFY_AT` (the resolvePanelAt grammar, EXACT):
 *   - unset → default `sun 10:00`;
 *   - trim+lowercase `"off"` → `null` (the advisor never fires);
 *   - else trim → lowercase → split on whitespace → exactly 2 tokens, token 1 ∈ the
 *     `ScheduleWeekday` union, token 2 zero-padded `HH:MM`;
 *   - anything malformed → default (never a throw, never a half-parse).
 */
export function resolveSkillReverifyAt(
  env: NodeJS.ProcessEnv
): { day: ScheduleWeekday; at: string } | null {
  const raw = env.HOUGE_SKILL_REVERIFY_AT;
  if (raw === undefined) return { ...REVERIFY_DEFAULT_SCHEDULE };
  const folded = raw.trim().toLowerCase();
  if (folded === "off") return null;
  const tokens = folded.split(/\s+/);
  if (tokens.length !== 2) return { ...REVERIFY_DEFAULT_SCHEDULE };
  const [day, at] = tokens as [string, string];
  if (!REVERIFY_WEEKDAYS.has(day)) return { ...REVERIFY_DEFAULT_SCHEDULE };
  if (!REVERIFY_AT_PATTERN.test(at)) return { ...REVERIFY_DEFAULT_SCHEDULE };
  return { day: day as ScheduleWeekday, at };
}

/** Staleness horizon in days (`HOUGE_SKILL_REVERIFY_AGE_DAYS`, default 28, positive int). */
export function resolveSkillReverifyAgeDays(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_SKILL_REVERIFY_AGE_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AGE_DAYS;
}

/** The store surface the tick needs — RunStore satisfies it (tests inject a fake). */
export interface SkillReverifyStateStore {
  getSkillReverifyLastRun(): string | null;
  setSkillReverifyLastRun(now: string): void;
  recordSkillReverifyTick(p: { checked: number; passed: number; flagged: number }): void;
  enqueueNotification(intent: NotificationIntent): unknown;
}

/** One Gate B failure worth flagging: identity + score margin + the failing criteria. */
export interface FlaggedSkill {
  name: string;
  scope: string;
  score: number;
  threshold: number;
  failing: string[];
}

/**
 * Render the flag report. Failing criteria are Gate B LLM OUTPUT — every criterion (and
 * the frontmatter-derived name/scope) passes through `escapeForTelegram` so model text
 * can't spoof markdown/links; raw HTML chars are neutralized downstream by the outbound
 * `markdownToTelegramHtml` escape. **bold** only, never `##` (the converter has no
 * heading support — /lessons lesson).
 */
export function formatReverifyReport(flags: FlaggedSkill[]): string {
  const blocks = flags.map((f) => {
    const lines = [
      `**${escapeForTelegram(f.name)}** (${escapeForTelegram(f.scope)}) · ` +
        `score ${f.score.toFixed(2)} < ${f.threshold.toFixed(2)}`
    ];
    for (const criterion of f.failing.slice(0, REPORT_FAILING_CAP)) {
      lines.push(`   • ${escapeForTelegram(criterion)}`);
    }
    lines.push(
      `→ retire: /skills retire ${escapeForTelegram(f.name)} · keep: do nothing (re-checked next tick)`
    );
    return lines.join("\n");
  });
  return [`🐒 Skill re-verify — ${flags.length} flagged`, "", blocks.join("\n\n")].join("\n");
}

/**
 * The weekly re-verify tick (order): flags → slot (off → out) → weekly due-check (the
 * epoch anchor makes the first armed tick fire at the next slot) → STAMP LATCH (before any
 * LLM call) → stale candidates → per skill: Gate B; `unscored` skips (an error never
 * condemns a skill and never launders staleness into a fresh stamp), pass re-stamps,
 * fail flags → ledger summary (counts only) → ONE notification iff something was flagged
 * (quiet when healthy). Wrapped whole — a tick must never throw into the daemon.
 */
export async function runSkillReverifyTick(input: {
  store: SkillReverifyStateStore;
  skills: SkillStore;
  anchorLlm: AnchorLlm;
  env: NodeJS.ProcessEnv;
  now: string;
  chatId: string | null;
}): Promise<{ ran: boolean }> {
  try {
    const env = input.env;
    if (!resolveSkillsEnabled(env) || !resolveSkillReverifyEnabled(env)) return { ran: false };
    const at = resolveSkillReverifyAt(env);
    if (at === null) return { ran: false };

    const tz = resolveRadarTz(env);
    const anchor = input.store.getSkillReverifyLastRun() ?? new Date(0).toISOString();
    const next = computeNextRunAt({ kind: "weekly", day: at.day, at: at.at }, tz, anchor);
    if (next === null || Date.parse(next) > Date.parse(input.now)) return { ran: false };

    // M3: latch BEFORE any LLM call — a bad week costs one week, never a retry storm.
    input.store.setSkillReverifyLastRun(input.now);

    const ageMs = resolveSkillReverifyAgeDays(env) * DAY_MS;
    const nowMs = Date.parse(input.now);
    const candidates = input.skills.list().filter((m) => {
      if (!m.last_verified) return true;
      const stamped = Date.parse(m.last_verified);
      if (!Number.isFinite(stamped)) return true;
      return nowMs - stamped > ageMs;
    });

    const opts = { passes: resolveGateBPasses(env), threshold: resolveGateBThreshold(env) };
    let passed = 0;
    const flags: FlaggedSkill[] = [];
    for (const meta of candidates) {
      const skill = input.skills.readSkill(meta.scope, meta.name);
      if (skill === null) continue;
      const verdict = await verifySkill(
        { when: skill.meta.when, body: skill.body },
        opts,
        input.anchorLlm
      );
      if (verdict.unscored) continue; // an error is not a low score — skip, stay stale
      if (verdict.passed) {
        input.skills.stampVerification(meta.scope, meta.name, {
          score: verdict.score,
          last_verified: input.now.slice(0, 10)
        });
        passed += 1;
      } else {
        flags.push({
          name: meta.name,
          scope: meta.scope,
          score: verdict.score,
          threshold: verdict.threshold,
          failing: verdict.failing
        });
      }
    }

    input.store.recordSkillReverifyTick({
      checked: candidates.length,
      passed,
      flagged: flags.length
    });

    if (flags.length > 0 && input.chatId !== null) {
      input.store.enqueueNotification({
        target: { kind: "telegram", chat_id: input.chatId },
        intent_type: "progress",
        idempotency_key: `skill_reverify:${input.now.slice(0, 10)}`,
        correlation_id: "skill-reverify",
        payload: { text: formatReverifyReport(flags) }
      });
    }
    return { ran: true };
  } catch {
    return { ran: false };
  }
}
