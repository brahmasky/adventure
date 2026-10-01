import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunStore, type DaemonBootInput } from "../../src/run/run-store.js";
import { classifyBoot, collectHougeStatus, renderHougeStatus, HOUGE_STATUS_MAX_CHARS, type StatusSupervisor } from "../../src/status/houge-status.js";

// houge_status (2026-10-02): Houge could not tell whether the daemon restarted or which code was live
// and asked Paco to kickstart a daemon that had already restarted itself. Every field below is what the
// planner needs to answer that from its own state, rendered by code, short, with no env value in it.

const NOW = new Date("2026-10-02T09:39:00.000Z");
const SHA = "4431d13aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CANARY = "canary-secret-7Qx9";
let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hst-"));
  env = {
    HOUGE_TOMBSTONE_PATH: join(dir, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(dir, "houge.parked"), HOUGE_DISARM_PATH: join(dir, "houge.disarm"),
    HOUGE_TIMEZONE: "Australia/Sydney", HOUGE_TELEGRAM_BOT_TOKEN: CANARY, HOUGE_STATUS_CANARY: CANARY, HOUGE_GMAIL_REFRESH_TOKEN: CANARY
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bootRow = (over: Partial<DaemonBootInput> = {}): DaemonBootInput => ({
  boot_id: "boot_1", started_at: "2026-10-02T07:34:00.000Z", pid: 4242, reason: "self_write_reload",
  reload_sha: SHA, reload_subject: "houge self-write: Retry; prior attempt never landed (main still greps -rqF)",
  reload_branch: "houge/selfwrite/run_79faefea", reload_merged_at: "2026-10-02T07:33:00.000Z",
  head_sha: SHA, head_subject: "houge self-write: Retry; prior attempt never landed (main still greps -rqF)",
  head_committed_at: "2026-10-02T07:33:00.000Z", dist_built_at: "2026-10-02T07:33:30.000Z", ...over
});

function seeded(): RunStore {
  const store = RunStore.openInMemory();
  store.recordDaemonBoot(bootRow());
  store.openIncident({ kind: "heartbeat_gap", subject: "daemon", detail: {} });
  store.openIncident({ kind: "planner_crash_loop", subject: "chat:555", detail: {} });
  store.recordGlobalBudgetRun({ now: "2026-10-02T09:00:00.000Z" });
  store.recordPollHeartbeat({ now: "2026-10-02T09:38:30.000Z", ok: true });
  return store;
}

const supervisor: StatusSupervisor = { ompVersion: () => "18.4.4", answeredModel: () => ({ provider: "anthropic", model: "claude-opus-5-5" }) };

function status(store: RunStore, sup: StatusSupervisor | null = supervisor): string {
  return renderHougeStatus(collectHougeStatus({ store, env, chatId: "555", pid: 4242, now: NOW, ...(sup ? { supervisor: sup } : {}) }));
}

describe("houge_status rendering", () => {
  it("renders every field from the seeded store and the boot record", () => {
    const store = seeded();
    const out = status(store);
    expect(out).toContain("pid 4242");
    expect(out).toContain("started 2026-10-02T07:34:00.000Z (2026-10-02 17:34 Australia/Sydney)");
    expect(out).toContain("up 2h05m");
    expect(out).toContain("Boot reason: self_write_reload 4431d13");
    expect(out).toContain('HEAD 4431d13 "houge self-write: Retry; prior attempt never landed (main s…"');
    expect(out).toContain("dist built 2026-10-02 17:33");
    expect(out).not.toContain("STALE");
    expect(out).toContain("Last self-write merge: houge/selfwrite/run_79faefea 4431d13 at 2026-10-02 17:33");
    expect(out).toContain("omp 18.4.4");
    expect(out).toContain("planner top anthropic/claude-opus-5-5:medium");
    expect(out).toContain("last answered by anthropic/claude-opus-5-5");
    expect(out).toContain("reader top google-antigravity/gemini-3.8-flash:low");
    expect(out).toContain("incidents 2 open (heartbeat_gap, planner_crash_loop)");
    expect(out).toContain("breaker runs 1/200, tool_calls 0/1000, gated 0/100");
    expect(out).toContain("posture normal");
    expect(out).toContain("last poll 2026-10-02 19:38");
    store.close();
  });

  it("flags built code as stale when HEAD is newer than the dist", () => {
    const store = RunStore.openInMemory();
    store.recordDaemonBoot(bootRow({ head_committed_at: "2026-10-02T07:40:00.000Z", dist_built_at: "2026-10-02T07:30:00.000Z" }));
    expect(status(store)).toContain("STALE: HEAD is newer than dist");
    store.close();
  });

  it("shows kill, park and disarm state, and an unconsumed merge as not yet live", () => {
    const store = seeded();
    writeFileSync(env.HOUGE_TOMBSTONE_PATH as string, "{}");
    writeFileSync(env.HOUGE_DISARM_PATH as string, "{}");
    store.writeReloadMarker({ sha: "bbbb2222", subject: "s", branch: "houge/selfwrite/run_b", merged_at: "2026-10-02T09:30:00.000Z" });
    const out = status(store);
    expect(out).toContain("posture killed, disarmed");
    expect(out).toContain("houge/selfwrite/run_b bbbb222 at 2026-10-02 19:30 (merged, not live until restart)");
    store.close();
  });

  it("falls back to the last compose attempt in this chat when the supervisor has no answered model", async () => {
    const { createQueuedTurnRun } = await import("../helpers/runs.js");
    const store = seeded();
    const run = createQueuedTurnRun(store, "x");
    store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text: "x" });
    store.llmAuditSink({ run_id: run, role: "compose" }).record({ provider: "kimi-code", role: "", outcome: "ok", model: "k3", request_key: `${run}:1` });
    expect(status(store, { ompVersion: () => null, answeredModel: () => undefined })).toContain("last answered by kimi-code/k3");
    expect(status(store, null)).toContain("omp unknown");
    store.close();
  });

  it("says so when there is no boot record instead of inventing one", () => {
    const store = RunStore.openInMemory();
    const out = status(store);
    expect(out).toContain("no boot record");
    expect(out).toContain("Boot reason: unknown");
    store.close();
  });

  it("never carries an env value, a home path or more than the size bound", () => {
    const store = seeded();
    const out = status(store);
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain(dir);
    expect(out).not.toMatch(/\/Users\/|\/home\//);
    expect(out).not.toMatch(/[{}"]\s*:/); // no JSON noise
    expect(out.length).toBeLessThanOrEqual(HOUGE_STATUS_MAX_CHARS);
    expect(HOUGE_STATUS_MAX_CHARS).toBeLessThanOrEqual(1200);
    store.close();
  });

  it("stays under the bound even with many incident kinds and long subjects", () => {
    const store = RunStore.openInMemory();
    store.recordDaemonBoot(bootRow({ reload_subject: "x".repeat(500), head_subject: "y".repeat(500), reload_branch: "b".repeat(300) }));
    for (let i = 0; i < 40; i++) store.openIncident({ kind: `kind_${"k".repeat(30)}_${i}`, subject: `s${i}`, detail: {} });
    expect(status(store).length).toBeLessThanOrEqual(HOUGE_STATUS_MAX_CHARS);
    store.close();
  });
});

describe("boot reason — derived from what the daemon already knows at boot, never guessed", () => {
  const hostUp = "2026-09-01T00:00:00.000Z";
  it("a consumed reload marker is a self-write reload", () => {
    expect(classifyBoot({ marker: true, parked: true, previous: null, hostBootedAt: hostUp })).toBe("self_write_reload");
  });
  it("a park marker at boot is a revive after /kill", () => {
    expect(classifyBoot({ marker: false, parked: true, previous: { stopped_at: null }, hostBootedAt: hostUp })).toBe("revive_after_kill");
  });
  it("a previous boot that never recorded a clean stop is a crash recovery", () => {
    expect(classifyBoot({ marker: false, parked: false, previous: { stopped_at: null }, hostBootedAt: hostUp })).toBe("crash_recovery");
  });
  it("a clean stop with the host up throughout is a kickstart", () => {
    expect(classifyBoot({ marker: false, parked: false, previous: { stopped_at: "2026-10-02T07:00:00.000Z" }, hostBootedAt: hostUp })).toBe("kickstart");
  });
  it("a clean stop followed by a host reboot is only a restart (cannot tell why)", () => {
    expect(classifyBoot({ marker: false, parked: false, previous: { stopped_at: "2026-10-02T07:00:00.000Z" }, hostBootedAt: "2026-10-02T07:05:00.000Z" })).toBe("restart");
  });
  it("no previous boot record is unknown", () => {
    expect(classifyBoot({ marker: false, parked: false, previous: null, hostBootedAt: hostUp })).toBe("unknown");
  });
});
