import { describe, expect, it } from "vitest";
import { RunStore, type DaemonBootInput } from "../../src/run/run-store.js";

// houge_status (2026-10-02): the daemon records one boot row at start so the planner can tell
// whether it restarted, why, and which code is live. Live: Houge told Paco it "can't see the daemon
// start time" after a self-write reload it had in fact already completed.

const boot = (over: Partial<DaemonBootInput> = {}): DaemonBootInput => ({
  boot_id: "boot_1", started_at: "2026-10-02T07:34:00.000Z", pid: 4242, reason: "kickstart",
  reload_sha: null, reload_subject: null, reload_branch: null, reload_merged_at: null,
  head_sha: "4431d13aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", head_subject: "fix(x): y", head_committed_at: "2026-10-02T07:00:00.000Z",
  dist_built_at: "2026-10-02T07:30:00.000Z", ...over
});

describe("RunStore daemon boot record", () => {
  it("the latest boot is the one just recorded, not yet stopped", () => {
    const store = RunStore.openInMemory();
    expect(store.getLatestDaemonBoot()).toBeNull();
    store.recordDaemonBoot(boot());
    store.recordDaemonBoot(boot({ boot_id: "boot_2", started_at: "2026-10-02T08:00:00.000Z", pid: 5151 }));
    expect(store.getLatestDaemonBoot()).toMatchObject({ boot_id: "boot_2", pid: 5151, stopped_at: null });
    store.close();
  });

  it("a clean stop is recorded on that boot only, so the next boot can tell a clean stop from a crash", () => {
    const store = RunStore.openInMemory();
    store.recordDaemonBoot(boot());
    store.markDaemonBootStopped("boot_1", "2026-10-02T09:00:00.000Z");
    expect(store.getLatestDaemonBoot()?.stopped_at).toBe("2026-10-02T09:00:00.000Z");
    store.close();
  });

  it("the last self-write merge comes from the newest boot that consumed a reload marker", () => {
    const store = RunStore.openInMemory();
    expect(store.getLastSelfWriteMerge()).toBeNull();
    store.recordDaemonBoot(boot({ reason: "self_write_reload", reload_sha: "aaaa111", reload_subject: "s1", reload_branch: "houge/selfwrite/run_a", reload_merged_at: "2026-10-01T01:00:00.000Z" }));
    store.recordDaemonBoot(boot({ boot_id: "boot_2", started_at: "2026-10-02T08:00:00.000Z" }));
    expect(store.getLastSelfWriteMerge()).toEqual({ branch: "houge/selfwrite/run_a", sha: "aaaa111", merged_at: "2026-10-01T01:00:00.000Z", pending: false });
    store.close();
  });

  it("a merge whose restart has not happened yet (unconsumed marker) is the last merge, flagged pending", () => {
    const store = RunStore.openInMemory();
    store.recordDaemonBoot(boot({ reason: "self_write_reload", reload_sha: "aaaa111", reload_subject: "s1", reload_branch: "b1", reload_merged_at: "2026-10-01T01:00:00.000Z" }));
    store.writeReloadMarker({ sha: "bbbb222", subject: "s2", branch: "b2", merged_at: "2026-10-02T09:00:00.000Z" });
    expect(store.getLastSelfWriteMerge()).toEqual({ branch: "b2", sha: "bbbb222", merged_at: "2026-10-02T09:00:00.000Z", pending: true });
    expect(store.consumeReloadMarker()).not.toBeNull(); // peeking never consumed it
    store.close();
  });

  it("keeps only the newest 50 boots", () => {
    const store = RunStore.openInMemory();
    for (let i = 0; i < 55; i++) store.recordDaemonBoot(boot({ boot_id: `boot_${i}`, started_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
    expect(store.countDaemonBoots()).toBe(50);
    expect(store.getLatestDaemonBoot()?.boot_id).toBe("boot_54");
    store.close();
  });
});

describe("RunStore last planner model for a chat (houge_status fallback when the supervisor has none)", () => {
  it("is the newest ok compose attempt of a run in THIS chat", async () => {
    const { createQueuedTurnRun } = await import("../helpers/runs.js");
    const store = RunStore.openInMemory();
    expect(store.lastPlannerModel("555")).toBeNull();
    const r1 = createQueuedTurnRun(store, "one");
    store.recordChatTurn({ chat_id: "555", run_id: r1, role: "user", text: "one" });
    store.llmAuditSink({ run_id: r1, role: "compose" }).record({ provider: "anthropic", role: "", outcome: "ok", model: "claude-opus-5-5", request_key: `${r1}:1` });
    store.llmAuditSink({ run_id: r1, role: "compose" }).record({ provider: "kimi-code", role: "", outcome: "error", model: "k3", request_key: `${r1}:2`, error_kind: "quota" });
    store.llmAuditSink({ run_id: r1, role: "reader" }).record({ provider: "google-antigravity", role: "", outcome: "ok", model: "gemini-3.8-flash", request_key: `${r1}:r` });
    expect(store.lastPlannerModel("555")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(store.lastPlannerModel("999")).toBeNull();
    store.close();
  });
});

describe("RunStore restart-note claim (once per chat per boot)", () => {
  it("the first claim for a (boot, chat) wins, later ones do not; a new boot claims again", () => {
    const store = RunStore.openInMemory();
    store.recordDaemonBoot(boot());
    expect(store.claimRestartNote("boot_1", "555")).toBe(true);
    expect(store.claimRestartNote("boot_1", "555")).toBe(false);
    expect(store.claimRestartNote("boot_1", "777")).toBe(true);
    store.recordDaemonBoot(boot({ boot_id: "boot_2", started_at: "2026-10-02T08:00:00.000Z" }));
    expect(store.claimRestartNote("boot_2", "555")).toBe(true);
    store.close();
  });
});
