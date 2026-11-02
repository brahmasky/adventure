import { afterEach, describe, expect, it, vi } from "vitest";
import { FRESH_FAILED_PREFIX, type PlannerSupervisor } from "../../src/omp/planner-supervisor.js";
import { PlannerRpcError } from "../../src/omp/planner-session.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { setSharedOmpVersionCacheForTest } from "../../src/omp/omp-version-cache.js";
import { cleanups, fakeSession, harness, heldSession, req } from "../helpers/supervisor-harness.js";

// Spec 2026-11-02 §6.2: the transcript carried `hostile` for 19 days and nothing could start a new one. /fresh is that exit:
// persisted (a restart or a child exit cannot lose it), honoured at the next start whatever the lesson set, committed only by
// the reset that served it, and a failed reset never pretends — the reply says so and the carry stays.
afterEach(async () => { setSharedOmpVersionCacheForTest(null); for (const c of cleanups.splice(0)) await c(); });
type Store = ReturnType<typeof harness>["store"];
const turnTrust = (store: Store, run: string) =>
  store.getLedgerEvents(run).filter((e) => e.event_type === "turn_trust").map((e) => e.payload);
const resetReasons = (store: Store) =>
  store.getLedgerEvents().filter((e) => e.event_type === "planner_session_reset").map((e) => (e.payload as { reason: string }).reason);
const waitStopped = async (sup: PlannerSupervisor) => { const end = Date.now() + 5_000; while (sup.state() !== "STOPPED") { if (Date.now() > end) throw new Error("child never stopped"); await new Promise((r) => setTimeout(r, 10)); } };
const run = async (h: { store: Store; sup: PlannerSupervisor }) => { const id = createQueuedTurnRun(h.store); h.sup.submit(req(id)); await h.sup.whenIdle(); return id; };
/** The reset rows this case added: harness() with sessionState "current" seeds one lesson_change row. */
const newResets = (store: Store, base: number) => resetReasons(store).slice(base);

describe("/fresh", () => {
  it("idle child: it stops now; the next turn resets, carries nothing, commits clean and clears the marker", async () => {
    const h = harness(); const base = resetReasons(h.store).length; // 1: the harness seed
    await run(h);
    h.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await h.sup.onFreshRequested();
    expect(h.sup.state()).toBe("STOPPED");
    const next = await run(h);
    expect([h.session.resets, newResets(h.store, base), turnTrust(h.store, next)]).toEqual([1, ["fresh"], []]);
    expect([h.store.freshRequestedAt("42"), h.store.getTranscriptTrust("42")]).toEqual([null, "clean"]);
  });
  it("turn in flight: the turn is not cancelled; the next turn is fresh", async () => {
    const held = heldSession(); const h = harness(held.session);
    const first = createQueuedTurnRun(h.store); h.sup.submit(req(first)); await held.live();
    h.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await h.sup.onFreshRequested();
    expect(h.sup.state()).toBe("RUNNING");
    held.end(); await h.sup.whenIdle();
    expect(h.store.getRunState(first)).toBe("completed");
    const next = createQueuedTurnRun(h.store); h.sup.submit(req(next)); await held.live(2); held.end(); await h.sup.whenIdle();
    expect([held.session.resets, turnTrust(h.store, next), h.store.freshRequestedAt("42")]).toEqual([1, [], null]);
  });
  it("a daemon restart between /fresh and the next turn: still fresh", async () => {
    const a = harness();
    await run(a);
    a.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
    a.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await a.sup.shutdown();
    const b = harness(fakeSession(), {}, {}, { store: a.store });
    const next = await run(b);
    expect([b.session.resets, turnTrust(b.store, next), b.store.freshRequestedAt("42")]).toEqual([1, [], null]);
  });
  it("a failed reset: served on the old transcript with its carry, the prefix sent, the marker kept, the incident open", async () => {
    const h = harness(fakeSession({ newSession: async () => { throw new PlannerRpcError("command_failed:new_session"); } }));
    h.store.setTranscriptTrust("42", "hostile", new Date().toISOString());
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    const id = await run(h);
    expect(turnTrust(h.store, id)).toEqual([{ level: "hostile", cause: "carried_hostile" }]);
    expect((h.outcome.done[0] as { text: string }).text).toBe(`${FRESH_FAILED_PREFIX}\n\nanswer`);
    // P21e: the stored assistant turn is the planner's own text; the prefix is only on the reply Paco receives
    const stored = h.store.getChatTurnsAfter("42", undefined, 100).filter((t) => t.run_id === id && t.role === "assistant").map((t) => t.text);
    expect(stored).toEqual(["answer"]);
    expect(h.store.freshRequestedAt("42")).toBe("2026-11-02T01:00:00.000Z");
    expect(h.outcome.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ k: "planner_session_reset_failed" })]));
  });
  it("a failed reset is retried at the next spawn, not on every turn of the live child; the prefix is that child's only (M90/M92, M93)", async () => {
    // Ruled behaviour (freshTried): restarting a live child each turn would turn one failing new_session into a retry storm.
    // The failed child's replies say they continue the old conversation; a later child's fresh transcript must not say so.
    let n = 0;
    const h = harness(fakeSession({ newSession: async () => { if (++n === 1) throw new PlannerRpcError("command_failed:new_session"); return { cancelled: false }; } }));
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await run(h); await run(h);
    expect(h.session.resets).toBe(1);                                   // the second turn rode the same child: no second attempt
    h.session.exit(1); await waitStopped(h.sup);
    await run(h);
    const texts = h.outcome.done.map((d) => (d as { text: string }).text);
    expect([h.session.resets, texts, h.store.freshRequestedAt("42")]).toEqual([2, [`${FRESH_FAILED_PREFIX}\n\nanswer`, `${FRESH_FAILED_PREFIX}\n\nanswer`, "answer"], null]);
  });
  it("only the child whose reset served the /fresh can clear the marker; another generation's commit leaves it (M87, N2)", async () => {
    // Defensive pin: today every start with a pending marker re-serves it, so a stale served generation is reached only when
    // the second start reads no marker (stubbed below). A lesson-reset child must then commit its own reset, not Paco's /fresh.
    let prompts = 0;
    const session = fakeSession({ beforePrompt: async () => { if (++prompts === 1) session.exit(1); } }); // gen 1 dies before its commit
    const h = harness(session);
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await run(h); await waitStopped(h.sup);
    h.store.addLesson({ scope: "ask", text: "be brief", source: "user_feedback" }); // gen 2 makes (and commits) a lesson reset
    const read = vi.spyOn(h.store, "freshRequestedAt").mockReturnValue(null);
    await run(h);
    read.mockRestore();
    expect([newResets(h.store, 1), h.store.freshRequestedAt("42")]).toEqual([["fresh", "lesson_change"], "2026-11-02T01:00:00.000Z"]);
  });
  it("N2: a /fresh written while a lesson-reset child's first prompt RPC is in flight survives that turn's commit", async () => {
    // The marker is written INSIDE the prompt RPC (beforePrompt), i.e. after the lesson reset and before commitReset:
    // the window codex's N2 named. Writing it after held.live() would land after the commit.
    let h!: ReturnType<typeof harness>; let prompts = 0;
    const session = fakeSession({ beforePrompt: async () => { if (++prompts === 1) h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z"); } });
    h = harness(session, {}, {}, { sessionState: "none" }); // no stored lesson set → a lesson reset at spawn
    const base = resetReasons(h.store).length;              // 0: sessionState "none" seeds nothing
    await run(h);
    expect(newResets(h.store, base)).toEqual(["lesson_change"]);
    expect(h.store.getPlannerSessionState("42")?.pending_fingerprint).toBeNull();      // the lesson reset WAS committed …
    expect(h.store.freshRequestedAt("42")).toBe("2026-11-02T01:00:00.000Z");        // … and did not consume the marker
    await run(h);
    expect([newResets(h.store, base), h.store.freshRequestedAt("42"), session.resets]).toEqual([["lesson_change", "fresh"], null, 2]);
  });
  it("is honoured with HOUGE_LESSON_SESSION_RESET off (P21a)", async () => {
    const h = harness(fakeSession(), {}, { env: { HOUGE_LESSON_SESSION_RESET: "0" } });
    h.store.requestFreshTranscript("42", "2026-11-02T01:00:00.000Z");
    await run(h);
    expect([h.session.resets, h.store.freshRequestedAt("42")]).toEqual([1, null]);
  });
});
