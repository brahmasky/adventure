import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnchorLlm } from "../../src/capabilities/anchor-verify.js";
import {
  formatReverifyReport,
  resolveSkillReverifyAgeDays,
  resolveSkillReverifyAt,
  resolveSkillReverifyEnabled,
  REVERIFY_DEFAULT_SCHEDULE,
  REVERIFY_MAX_PER_TICK,
  runSkillReverifyTick,
  type FlaggedSkill,
  type SkillReverifyStateStore
} from "../../src/capabilities/skill-reverify.js";
import type { NotificationIntent } from "../../src/notifications/notification-types.js";
import { SkillStore } from "../../src/skills/skill-store.js";

// Sunday 10:30 Sydney (AEST = UTC+10) — 30 min past the default sun 10:00 slot.
const NOW = "2026-08-30T00:30:00.000Z";
const ARMED: NodeJS.ProcessEnv = { HOUGE_SKILL_REVERIFY_ENABLED: "1" };

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempSkillStore(): { store: SkillStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "houge-reverify-"));
  dirs.push(root);
  return { store: new SkillStore({ root }), root };
}

function writeSkillFile(root: string, scope: string, name: string, lastVerified?: string): void {
  mkdirSync(join(root, scope), { recursive: true });
  const stamp = lastVerified ? `last_verified: ${lastVerified}\n` : "";
  writeFileSync(
    join(root, scope, `${name}.md`),
    `---\nname: ${name}\nscope: ${scope}\nwhen: testing the advisor\nanchors:\n  - an anchor\n${stamp}---\n\n1. Do the thing carefully.`,
    "utf8"
  );
}

/** A fake state store recording call ORDER (latch-before-LLM is an invariant under test). */
function fakeStateStore(lastRun: string | null = null): SkillReverifyStateStore & {
  events: string[];
  ticks: Array<{ checked: number; passed: number; flagged: number }>;
  notifications: NotificationIntent[];
} {
  const events: string[] = [];
  const ticks: Array<{ checked: number; passed: number; flagged: number }> = [];
  const notifications: NotificationIntent[] = [];
  return {
    events,
    ticks,
    notifications,
    getSkillReverifyLastRun: () => lastRun,
    setSkillReverifyLastRun: (now: string) => {
      events.push(`latch:${now}`);
    },
    recordSkillReverifyTick: (p) => {
      events.push("record");
      ticks.push(p);
    },
    enqueueNotification: (intent) => {
      events.push("notify");
      notifications.push(intent);
      return undefined;
    }
  };
}

/** A canned Gate B llm: every pass answers the same criteria JSON; calls are order-logged. */
function cannedGateB(answer: string | undefined, events?: string[]): AnchorLlm {
  return async () => {
    events?.push("verify");
    return answer;
  };
}

const ALL_FAIL = '{"criteria":[{"text":"cites a primary source","ok":0}]}';
const ALL_PASS = '{"criteria":[{"text":"cites a primary source","ok":1}]}';

// --- resolvers ----------------------------------------------------------------

describe("resolveSkillReverifyEnabled", () => {
  it("defaults OFF; '1' arms it", () => {
    expect(resolveSkillReverifyEnabled({})).toBe(false);
    expect(resolveSkillReverifyEnabled({ HOUGE_SKILL_REVERIFY_ENABLED: "0" })).toBe(false);
    expect(resolveSkillReverifyEnabled({ HOUGE_SKILL_REVERIFY_ENABLED: "1" })).toBe(true);
  });
});

describe("resolveSkillReverifyAt", () => {
  it("defaults to sun 10:00 when unset", () => {
    expect(resolveSkillReverifyAt({})).toEqual(REVERIFY_DEFAULT_SCHEDULE);
    expect(resolveSkillReverifyAt({})).toEqual({ day: "sun", at: "10:00" });
  });

  it("parses a 'day HH:MM' override (case/whitespace folded)", () => {
    expect(resolveSkillReverifyAt({ HOUGE_SKILL_REVERIFY_AT: "wed 08:30" })).toEqual({
      day: "wed",
      at: "08:30"
    });
    expect(resolveSkillReverifyAt({ HOUGE_SKILL_REVERIFY_AT: "  MON   21:15 " })).toEqual({
      day: "mon",
      at: "21:15"
    });
  });

  it("'off' disables the advisor (null — no fallback)", () => {
    expect(resolveSkillReverifyAt({ HOUGE_SKILL_REVERIFY_AT: "off" })).toBeNull();
    expect(resolveSkillReverifyAt({ HOUGE_SKILL_REVERIFY_AT: " OFF " })).toBeNull();
  });

  it("malformed values fall back to the default (never a throw, never a half-parse)", () => {
    for (const garbage of ["garbage", "sun", "sun 9:00", "sun 08:30 extra", "someday 10:00", "sun 25:00"]) {
      expect(resolveSkillReverifyAt({ HOUGE_SKILL_REVERIFY_AT: garbage })).toEqual(
        REVERIFY_DEFAULT_SCHEDULE
      );
    }
  });
});

describe("resolveSkillReverifyAgeDays", () => {
  it("defaults to 28; positive int override; garbage/non-positive → default", () => {
    expect(resolveSkillReverifyAgeDays({})).toBe(28);
    expect(resolveSkillReverifyAgeDays({ HOUGE_SKILL_REVERIFY_AGE_DAYS: "7" })).toBe(7);
    expect(resolveSkillReverifyAgeDays({ HOUGE_SKILL_REVERIFY_AGE_DAYS: "abc" })).toBe(28);
    expect(resolveSkillReverifyAgeDays({ HOUGE_SKILL_REVERIFY_AGE_DAYS: "-1" })).toBe(28);
    expect(resolveSkillReverifyAgeDays({ HOUGE_SKILL_REVERIFY_AGE_DAYS: "0" })).toBe(28);
  });
});

// --- formatReverifyReport ------------------------------------------------------

describe("formatReverifyReport", () => {
  it("escapes LLM-output criteria (markdown metachars stripped; raw HTML inert downstream)", () => {
    const flags: FlaggedSkill[] = [
      {
        name: "shady-skill",
        scope: "research",
        score: 0.05,
        threshold: 0.15,
        failing: ["<b>use *markdown* [tricks](http://x)</b> to spoof"]
      }
    ];
    const text = formatReverifyReport(flags);
    expect(text).toContain("🐒 Skill re-verify — 1 flagged");
    expect(text).toContain("**shady-skill** (research) · score 0.05 < 0.15");
    // The criterion went through escapeForTelegram: no markdown/link metachars survive
    // (the `<b>` HTML chars are escaped downstream by markdownToTelegramHtml's escapeHtml).
    expect(text).not.toContain("*markdown*");
    expect(text).not.toContain("[tricks](http://x)");
    expect(text).toContain("use markdown trickshttp://x");
    expect(text).toContain("→ retire: /skills retire shady-skill · keep: do nothing (re-checked next tick)");
  });

  it("bolds with ** only — never ## (the Telegram converter has no heading support)", () => {
    const text = formatReverifyReport([
      { name: "a", scope: "s", score: 0, threshold: 0.15, failing: ["c1", "c2", "c3", "c4"] }
    ]);
    expect(text).not.toContain("##");
    // Failing criteria are capped at 3 per skill.
    expect(text).toContain("• c3");
    expect(text).not.toContain("c4");
  });
});

// --- runSkillReverifyTick --------------------------------------------------------

describe("runSkillReverifyTick", () => {
  it("does nothing when the flag is off (no latch, no LLM, no ledger)", async () => {
    const { store: skills, root } = tempSkillStore();
    writeSkillFile(root, "research", "stale-skill"); // unverified = stale
    const state = fakeStateStore();
    const events = state.events;
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(ALL_FAIL, events),
      env: {},
      now: NOW,
      chatId: "222"
    });
    expect(out).toEqual({ ran: false });
    expect(events).toEqual([]);
  });

  it("due + failing stale skill: latch stamped with NOW before any verify, counts + notification", async () => {
    const { store: skills, root } = tempSkillStore();
    writeSkillFile(root, "research", "stale-skill", "2026-06-01");
    const state = fakeStateStore();
    const events = state.events;
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(ALL_FAIL, events),
      env: ARMED,
      now: NOW,
      chatId: "222"
    });
    expect(out).toEqual({ ran: true });
    // Latch BEFORE the first Gate B call (M3 posture).
    expect(events[0]).toBe(`latch:${NOW}`);
    expect(events.indexOf("verify")).toBeGreaterThan(0);
    expect(state.ticks).toEqual([{ checked: 1, passed: 0, flagged: 1 }]);
    expect(state.notifications).toHaveLength(1);
    const intent = state.notifications[0]!;
    expect(intent.intent_type).toBe("progress");
    expect(intent.idempotency_key).toBe("skill_reverify:2026-08-30");
    expect(intent.target).toEqual({ kind: "telegram", chat_id: "222" });
    const text = String(intent.payload.text);
    expect(text).toContain("stale-skill");
    expect(text).toContain("/skills retire stale-skill");
    // The stale skill was NOT stamped and NOT moved.
    const file = readFileSync(join(root, "research", "stale-skill.md"), "utf8");
    expect(file).toContain("last_verified: 2026-06-01");
  });

  it("passing stale skill: last_verified refreshed to today, no notification, counts {1,1,0}", async () => {
    const { store: skills, root } = tempSkillStore();
    writeSkillFile(root, "research", "good-skill", "2026-06-01");
    const state = fakeStateStore();
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(ALL_PASS),
      env: ARMED,
      now: NOW,
      chatId: "222"
    });
    expect(out).toEqual({ ran: true });
    expect(state.ticks).toEqual([{ checked: 1, passed: 1, flagged: 0 }]);
    expect(state.notifications).toHaveLength(0); // quiet when healthy
    const file = readFileSync(join(root, "research", "good-skill.md"), "utf8");
    expect(file).toContain("last_verified: 2026-08-30");
    expect(file).toContain("score: 1.00");
  });

  it("fresh skill is not a candidate; an unscored verify neither stamps nor flags", async () => {
    const { store: skills, root } = tempSkillStore();
    writeSkillFile(root, "research", "fresh-skill", "2026-08-25"); // 5 days < 28
    writeSkillFile(root, "research", "stale-skill", "2026-06-01");
    const state = fakeStateStore();
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(undefined), // LLM down → every pass unparseable → unscored
      env: ARMED,
      now: NOW,
      chatId: "222"
    });
    expect(out).toEqual({ ran: true });
    // Only the stale skill was a candidate; unscored → skipped (no stamp, no flag).
    expect(state.ticks).toEqual([{ checked: 1, passed: 0, flagged: 0 }]);
    expect(state.notifications).toHaveLength(0);
    const stale = readFileSync(join(root, "research", "stale-skill.md"), "utf8");
    expect(stale).toContain("last_verified: 2026-06-01"); // an error never launders staleness
    const fresh = readFileSync(join(root, "research", "fresh-skill.md"), "utf8");
    expect(fresh).toContain("last_verified: 2026-08-25");
  });

  it("first arm (NULL latch) fires immediately mid-week — a first sweep today, then weekly", async () => {
    const { store: skills, root } = tempSkillStore();
    writeSkillFile(root, "research", "stale-skill", "2026-06-01");
    const state = fakeStateStore(null); // seeded-NULL latch = never ran
    // Wednesday 12:00 Sydney — nowhere near the sun 10:00 slot; the epoch anchor still fires.
    const NOW_WED = "2026-08-26T02:00:00.000Z";
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(ALL_PASS),
      env: ARMED,
      now: NOW_WED,
      chatId: "222"
    });
    expect(out).toEqual({ ran: true });
    expect(state.events[0]).toBe(`latch:${NOW_WED}`);
    expect(state.ticks).toEqual([{ checked: 1, passed: 1, flagged: 0 }]);
  });

  it("bounds a tick at REVERIFY_MAX_PER_TICK candidates — excess stays stale for next week", async () => {
    const { store: skills, root } = tempSkillStore();
    for (let i = 1; i <= 13; i += 1) {
      writeSkillFile(root, "research", `skill-${String(i).padStart(2, "0")}`, "2026-06-01");
    }
    const state = fakeStateStore();
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(ALL_PASS),
      env: ARMED,
      now: NOW,
      chatId: "222"
    });
    expect(out).toEqual({ ran: true });
    expect(REVERIFY_MAX_PER_TICK).toBe(12);
    expect(state.ticks).toEqual([{ checked: 12, passed: 12, flagged: 0 }]);
    // The 13th (last in list order) was left for the next tick — still stale, untouched.
    const leftover = readFileSync(join(root, "research", "skill-13.md"), "utf8");
    expect(leftover).toContain("last_verified: 2026-06-01");
    const swept = readFileSync(join(root, "research", "skill-12.md"), "utf8");
    expect(swept).toContain("last_verified: 2026-08-30");
  });

  it("not due (lastRun after this week's slot): no work, latch not re-stamped", async () => {
    const { store: skills, root } = tempSkillStore();
    writeSkillFile(root, "research", "stale-skill", "2026-06-01");
    // Fired earlier today (sun 10:00 Sydney = 00:00 UTC) → next fire is NEXT Sunday.
    const state = fakeStateStore("2026-08-30T00:10:00.000Z");
    const events = state.events;
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(ALL_FAIL, events),
      env: ARMED,
      now: NOW,
      chatId: "222"
    });
    expect(out).toEqual({ ran: false });
    expect(events).toEqual([]);
  });

  it("HOUGE_SKILL_REVERIFY_AT=off never fires even when armed", async () => {
    const { store: skills, root } = tempSkillStore();
    writeSkillFile(root, "research", "stale-skill");
    const state = fakeStateStore();
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(ALL_FAIL),
      env: { ...ARMED, HOUGE_SKILL_REVERIFY_AT: "off" },
      now: NOW,
      chatId: "222"
    });
    expect(out).toEqual({ ran: false });
    expect(state.events).toEqual([]);
  });

  it("flags without a chatId still latch + record but enqueue nothing (CLI context)", async () => {
    const { store: skills, root } = tempSkillStore();
    writeSkillFile(root, "research", "stale-skill", "2026-06-01");
    const state = fakeStateStore();
    const out = await runSkillReverifyTick({
      store: state,
      skills,
      anchorLlm: cannedGateB(ALL_FAIL),
      env: ARMED,
      now: NOW,
      chatId: null
    });
    expect(out).toEqual({ ran: true });
    expect(state.ticks).toEqual([{ checked: 1, passed: 0, flagged: 1 }]);
    expect(state.notifications).toHaveLength(0);
  });
});
