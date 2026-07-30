import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDisarmPosture,
  clearDisarmPosture,
  DEFAULT_DISARM_PATH,
  DISARM_FLAGS,
  disarmPosturePresent,
  formatDisarmAckText,
  formatRearmAckText,
  resolveDisarmPath,
  writeDisarmPosture
} from "../../src/config/disarm-posture.js";
import { loadHougeEnv } from "../../src/config/load-env.js";
import { resolveSchedulerEnabled } from "../../src/run/schedule-spec.js";
import { resolveSelfWriteEnabled } from "../../src/capabilities/intent.js";

const dir = mkdtempSync(join(tmpdir(), "houge-disarm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// PINNED_ENV hermeticity: the loadHougeEnv integration below mutates process.env (the
// module's real target), so every touched key is pinned before and restored after —
// the self-write test-gate runs this suite with the daemon's .env exported.
const PINNED_ENV = ["HOUGE_DISARM_PATH", ...DISARM_FLAGS] as const;
const pinned = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of PINNED_ENV) {
    pinned.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PINNED_ENV) {
    const value = pinned.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("DISARM_FLAGS", () => {
  it("covers evolution + unattended autonomy — and deliberately NOT episodic memory", () => {
    // WHY this exact set: /disarm is "stop Houge changing himself / acting unattended".
    // Remembering a conversation is neither, and losing memory would punish the operator
    // for reaching for the brake — so HOUGE_EPISODIC_ENABLED is exempt by design.
    expect([...DISARM_FLAGS]).toEqual([
      "HOUGE_SELFWRITE_ENABLED",
      "HOUGE_CODEX_ENABLED",
      "HOUGE_SKILLS_ENABLED",
      "HOUGE_SCHEDULER_ENABLED",
      // ADR 0023: the external engineering workspace is an autonomous evolution capability
      // (clones + runs external code in a container unattended) — the STOP switch covers it.
      "HOUGE_EXTWORK_ENABLED",
      // P2 (spec 2026-07-18): bounty intake reads external venues + writes durable
      // project rows unattended-adjacent (scheduled scans) — the STOP switch covers it.
      "HOUGE_BOUNTY_ENABLED",
      // ADR 0025: acts under Houge's own Google identity — the STOP switch must cover
      // identity reads too.
      "HOUGE_GOOGLE_ENABLED",
      "HOUGE_LESSON_CONSOLIDATE_ENABLED",
      // Skill retirement spec (2026-07-29): the weekly re-verify advisor re-scores Houge's
      // OWN procedures — evolution surface, covered like lesson consolidation.
      "HOUGE_SKILL_REVERIFY_ENABLED",
      // Idea Radar R1 (spec 2026-07-24): unattended external reads + a daily metered LLM
      // call + durable card writes — the STOP switch covers it like bounty intake.
      "HOUGE_RADAR_ENABLED",
      // Idea Radar R2 (ADR 0027): the weekly judge panel — unattended metered calls, status/
      // snapshot writes, the memory/briefs/ projection, and the first proactive weekly push.
      "HOUGE_RADAR_PANEL_ENABLED"
    ]);
    expect(DISARM_FLAGS).not.toContain("HOUGE_EPISODIC_ENABLED");
  });
});

describe("posture file lifecycle", () => {
  it("defaults to houge.disarm and honors HOUGE_DISARM_PATH", () => {
    expect(resolveDisarmPath({})).toBe(DEFAULT_DISARM_PATH);
    expect(DEFAULT_DISARM_PATH).toBe("houge.disarm");
    expect(resolveDisarmPath({ HOUGE_DISARM_PATH: "/x/houge.disarm" })).toBe("/x/houge.disarm");
  });

  it("write → present → clear roundtrip", () => {
    const env: NodeJS.ProcessEnv = { HOUGE_DISARM_PATH: join(dir, "roundtrip.disarm") };
    expect(disarmPosturePresent(env)).toBe(false);
    writeDisarmPosture({ disarmed_at: "2026-07-15T00:00:00.000Z", by: "paco" }, env);
    expect(disarmPosturePresent(env)).toBe(true);
    clearDisarmPosture(env);
    expect(disarmPosturePresent(env)).toBe(false);
    expect(() => clearDisarmPosture(env)).not.toThrow();
  });

  it("presence IS the posture: a corrupt/empty posture file still disarms", () => {
    const env: NodeJS.ProcessEnv = { HOUGE_DISARM_PATH: join(dir, "corrupt.disarm") };
    writeFileSync(env.HOUGE_DISARM_PATH!, "not json");
    expect(applyDisarmPosture(env)).toBe(true);
    expect(env.HOUGE_SCHEDULER_ENABLED).toBe("false");
  });
});

describe("applyDisarmPosture", () => {
  it("forces every flag to 'false' — OVER a pre-set truthy value (the posture is a STOP)", () => {
    const env: NodeJS.ProcessEnv = {
      HOUGE_DISARM_PATH: join(dir, "force.disarm"),
      HOUGE_SELFWRITE_ENABLED: "true",
      HOUGE_SCHEDULER_ENABLED: "1"
    };
    writeDisarmPosture({ disarmed_at: "2026-07-15T00:00:00.000Z", by: "paco" }, env);
    expect(applyDisarmPosture(env)).toBe(true);
    for (const flag of DISARM_FLAGS) expect(env[flag]).toBe("false");
  });

  it("no posture file → no-op (flags untouched)", () => {
    const env: NodeJS.ProcessEnv = {
      HOUGE_DISARM_PATH: join(dir, "absent.disarm"),
      HOUGE_SCHEDULER_ENABLED: "true"
    };
    expect(applyDisarmPosture(env)).toBe(false);
    expect(env.HOUGE_SCHEDULER_ENABLED).toBe("true");
  });
});

describe("restart survival: posture outranks .env at load (ADR 0018)", () => {
  it("loadHougeEnv applies the posture BEFORE the .env parse — flags land 'false' despite .env saying true", () => {
    // The mechanism under test: loadHougeEnv is first-writer-wins (it never overwrites a
    // set variable), so setting the flags to "false" before the file parse means the
    // .env's HOUGE_*_ENABLED=true never lands — the disarm survives every restart.
    const envFile = join(dir, "armed.env");
    writeFileSync(envFile, DISARM_FLAGS.map((flag) => `${flag}=true`).join("\n"));
    process.env.HOUGE_DISARM_PATH = join(dir, "survive.disarm");
    writeDisarmPosture({ disarmed_at: "2026-07-15T00:00:00.000Z", by: "paco" }, process.env);

    const applied = loadHougeEnv({ path: envFile });

    for (const flag of DISARM_FLAGS) {
      expect(process.env[flag]).toBe("false");
      expect(applied).not.toContain(flag); // .env lost first-writer-wins for every flag
    }
    // and the LIVE resolvers the daemon actually consults see the disarmed state:
    expect(resolveSchedulerEnabled(process.env)).toBe(false);
    expect(resolveSelfWriteEnabled(process.env)).toBe(false);
  });

  it("without the posture file, the same .env arms the flags normally (the posture is the only difference)", () => {
    const envFile = join(dir, "armed2.env");
    writeFileSync(envFile, DISARM_FLAGS.map((flag) => `${flag}=true`).join("\n"));
    process.env.HOUGE_DISARM_PATH = join(dir, "never-written.disarm");

    loadHougeEnv({ path: envFile });

    expect(resolveSchedulerEnabled(process.env)).toBe(true);
    expect(resolveSelfWriteEnabled(process.env)).toBe(true);
  });
});

describe("user-facing strings", () => {
  it("the /disarm ack lists exactly what was switched off + the survival/rearm story", () => {
    const text = formatDisarmAckText("/x/houge.disarm");
    for (const flag of DISARM_FLAGS) expect(text).toContain(`${flag}=false`);
    expect(text).toContain("/x/houge.disarm");
    expect(text).toContain("/rearm");
  });

  it("the /rearm ack says flags re-apply on RESTART (never claims a live re-enable)", () => {
    const text = formatRearmAckText("/x/houge.disarm");
    expect(text).toContain("next restart");
    expect(text).toContain("launchctl kickstart");
  });
});
