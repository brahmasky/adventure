// Spec 2b-ii §6.1 (R1): three sections only — Improvements today (effects and accepted proposals since the last digest with
// Undo/Revert/Revoke), Proposals waiting (≤ 8 open, oldest first, Accept/Dismiss, "+N more"), Watch (7-day numbers) — each
// skipped when empty, the message skipped when all three are; drafts redacted; offered_at set inside the latch transaction
// only after the outbox reported queued. (Follow-up 1 brought the Unsure section back, below.) The counts, trust/noise, bar-stale and Health sections are gone.
import { describe, expect, it } from "vitest";
import { barOf, buildDecisionDigest, DIGEST_PROPOSALS_MAX, resolveDigestAt, runDecisionDigestTick, UNSURE_MAX } from "../../src/decisions/digest.js";
import { REGISTRY } from "../../src/decisions/registry.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";
import { drainOutbox } from "../helpers/omp-worker.js";
import { parseDecisionReviewCallback, parseImprovementCallback } from "../../src/triggers/telegram-command-parser.js";
import { skillButtons } from "../../src/skills/promote.js";

const ENV = { HOUGE_DISPLAY_TZ: "Australia/Sydney" };
const NOW = "2026-10-21T11:00:00.000Z"; // 22:00 AEDT
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: "2026-10-21T10:00:00.000Z" };
const open = (s: RunStore, n: number, target: "lesson" | "fact" = "lesson") => Array.from({ length: n }, (_, k) =>
  s.insertImprovementProposal({ decision_id: s.insertDecision(D), target, scope: `scope${k}`, chat_id: "555", draft_json: JSON.stringify({ scope: "ask", text: `Rule ${k}: ${"x".repeat(200)} sk-liveSECRETvalue000000000` }), evidence: `correction on 2026-10-21, scope scope${k}`, created_at: `2026-10-21T0${k % 10}:00:00.000Z` }));
const buttons = (d: NonNullable<ReturnType<typeof buildDecisionDigest>>) => d.button_rows.flat().map((b) => b.data);

describe("buildDecisionDigest (2b-ii)", () => {
  it("renders the three sections and nothing else; offered ids are the rendered proposals and jobs", () => {
    const s = RunStore.openInMemory();
    const ids = open(s, 2);
    const run_id = createTelegramTurn(s, "shorter").run_id;
    const lesson = s.addLesson({ scope: "ask", text: "Answer in one line.", source: "improve" });
    const change = s.insertLessonChange({ run_id, chat_id: "555", new_id: lesson, superseded_id: null, pruned_ids: [] });
    const accepted = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "lesson", scope: "answer", chat_id: "555", draft_json: JSON.stringify({ scope: "ask", text: "Answer in one line." }), evidence: "correction on 2026-10-21, scope answer", created_at: "2026-10-21T01:00:00.000Z" });
    s.transitionProposal({ proposal_id: accepted, from: ["open"], to: "accepted", now: "2026-10-21T09:00:00.000Z", result_json: JSON.stringify({ change_id: change.change_id, lesson_id: lesson }) });
    s.insertImproveSignal({ signal: "correction", value: "answer", run_id, chat_id: "555", about_run_id: run_id, created_at: "2026-10-21T02:00:00.000Z" });
    const d = buildDecisionDigest(s, NOW, ENV)!;
    const headers = d.text.split("\n").filter((l) => l.startsWith("**"));
    expect(headers).toEqual(["**Improvements today**", "**Proposals waiting**", "**Watch (7 d)**"]);
    for (const gone of ["Counts (24 h)", "Health", "Bar stale", "Injection & trust", "Noise band"]) expect(d.text).not.toContain(gone);
    expect(d.text).toContain("lesson saved: Answer in one line. · correction on 2026-10-21, scope answer");
    expect(buttons(d)).toEqual([`memlane:undo:${change.change_id}`, `dec:pr:${ids[0]}:acc`, `dec:pr:${ids[0]}:dis`, `dec:pr:${ids[1]}:acc`, `dec:pr:${ids[1]}:dis`]);
    expect(d.offered).toEqual({ proposal_ids: ids, job_ids: [], decision_ids: [] });
  });
  it("skips an empty day entirely: no message, latch sent 0", () => {
    const s = RunStore.openInMemory();
    expect(buildDecisionDigest(s, NOW, ENV)).toBeNull();
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: false });
    expect(s.getDecisionDigest("2026-10-21")).toMatchObject({ sent: 0, offered: [] });
    expect(drainOutbox(s).size).toBe(0);
  });
  it("Proposals waiting shows at most 8, oldest first, with +N more; a draft line is redacted and cut at 120 code points; every button's data is ≤ 64 bytes", () => {
    const s = RunStore.openInMemory();
    const ids = open(s, 10);
    const d = buildDecisionDigest(s, NOW, ENV)!;
    const lines = d.text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines).toHaveLength(DIGEST_PROPOSALS_MAX);
    expect(d.text).toContain("+2 more");
    expect(d.text).not.toContain("sk-liveSECRET");
    expect(Array.from(lines[0]!.split(" · ")[1]!)).toHaveLength(120);
    expect(d.offered.proposal_ids).toEqual(ids.slice(0, DIGEST_PROPOSALS_MAX));
    for (const b of buttons(d)) expect(Buffer.byteLength(b, "utf8")).toBeLessThanOrEqual(64);
  });
  it("a lesson proposal's waiting line shows its AVOID (redacted and clipped like the text): every line that would enter the planner is in front of Paco (final fix A2)", () => {
    const s = RunStore.openInMemory();
    s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "lesson", scope: "answer", chat_id: "555", draft_json: JSON.stringify({ scope: "ask", text: "Answer in one line.", avoid: `asking before shell sk-liveSECRETvalue000000000 ${"y".repeat(300)}` }), evidence: "correction on 2026-10-21, scope answer", created_at: "2026-10-21T01:00:00.000Z" });
    const line = buildDecisionDigest(s, NOW, ENV)!.text.split("\n").find((l) => l.startsWith("1. "))!;
    expect(line).toContain("Answer in one line. · AVOID: asking before shell");
    expect(line).not.toContain("sk-liveSECRET");
    expect(Array.from(line.split(" · AVOID: ")[1]!.split(" · ")[0]!)).toHaveLength(120);
  });
  it("every improvement button the digest and the job cards build parses back through parseImprovementCallback to its own kind, id and action (final fix F2: the prefixes are duplicated constants)", () => {
    const s = RunStore.openInMemory();
    const [pr] = open(s, 1);
    const job = s.insertImprovementJob({ decision_id: s.insertDecision(D), proposal_id: null, chat_id: "555", origin_json: JSON.stringify({ turn_ids: ["t1"], run_ids: [], category: "answer", text_hashes: [] }), idempotency_key: "f2", created_at: "2026-10-21T01:00:00.000Z" })!;
    s.transitionJob({ job_id: job, from: ["queued"], to: "running", now: "2026-10-21T09:00:00.000Z", bumpAttempt: true });
    s.transitionJob({ job_id: job, from: ["running"], to: "pending_review", now: "2026-10-21T09:30:00.000Z", attempt: 1, patch: { pending_scope: "ask", pending_name: "weekly-report", gate_a: "skill" } });
    const sched = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "schedule", scope: "shell_external", chat_id: "555", draft_json: JSON.stringify({ schedule_id: "s1", hour_from: 11, hour_to: 20, before: {}, after: {} }), evidence: "e", created_at: "2026-10-21T01:00:00.000Z" });
    s.transitionProposal({ proposal_id: sched, from: ["open"], to: "accepted", now: "2026-10-21T09:00:00.000Z" });
    const lad = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "ladder", scope: "turn.settle", chat_id: "555", draft_json: JSON.stringify({ entry_id: "turn.settle", move: "retire_judge" }), evidence: "e", created_at: "2026-10-21T01:00:00.000Z" });
    const move = s.insertLadderMove({ entry_id: "turn.settle", scope: "turn.settle", from_rung: "system_one", to_rung: "model", evidence: [lad], granted_by: "paco", granted_via: "improve.route", paco_callback_id: "cb1", revocable: true, created_at: "2026-10-21T09:00:00.000Z" });
    s.transitionProposal({ proposal_id: lad, from: ["open"], to: "accepted", now: "2026-10-21T09:00:00.000Z", result_json: JSON.stringify({ move_id: move }) });
    const data = [...buttons(buildDecisionDigest(s, NOW, ENV)!), ...skillButtons(job, "collision").map((b) => b.data)];
    expect(data.map((x) => parseImprovementCallback(x))).toEqual([
      { kind: "sk", id: job, action: "accept" }, { kind: "sk", id: job, action: "dismiss" }, { kind: "pr", id: sched, action: "rev" }, { kind: "lm", id: move, action: "revoke" },
      { kind: "pr", id: pr, action: "acc" }, { kind: "pr", id: pr, action: "dis" },
      { kind: "sk", id: job, action: "replace" }, { kind: "sk", id: job, action: "keep" }, { kind: "sk", id: job, action: "dismiss" }]);
  });
  it("Improvements today: a drafted skill with Accept/Dismiss, a suggested job without buttons, a promoted skill, a shifted schedule with Revert, a ladder move with Revoke", () => {
    const s = RunStore.openInMemory();
    const job = (state: "pending_review" | "suggested" | "promoted", name: string) => {
      const id = s.insertImprovementJob({ decision_id: s.insertDecision(D), proposal_id: null, chat_id: "555", origin_json: JSON.stringify({ turn_ids: ["t1", "t2", "t3"], run_ids: [], category: "answer", text_hashes: [] }), idempotency_key: name, created_at: "2026-10-21T01:00:00.000Z" })!;
      s.transitionJob({ job_id: id, from: ["queued"], to: "running", now: "2026-10-21T09:00:00.000Z", bumpAttempt: true });
      s.transitionJob({ job_id: id, from: ["running"], to: state === "promoted" ? "pending_review" : state, now: "2026-10-21T09:30:00.000Z", attempt: 1, patch: { pending_scope: "ask", pending_name: name, gate_a: state === "suggested" ? "lesson" : "skill" } });
      if (state === "promoted") { s.transitionJob({ job_id: id, from: ["pending_review"], to: "promoting", now: "2026-10-21T10:00:00.000Z", patch: { promote_mode: "refuse" } }); s.transitionJob({ job_id: id, from: ["promoting"], to: "promoted", now: "2026-10-21T10:00:00.000Z" }); }
      return id;
    };
    const drafted = job("pending_review", "weekly-report"); job("suggested", "x"); job("promoted", "invoice-finder");
    const sched = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "schedule", scope: "shell_external", chat_id: "555", draft_json: JSON.stringify({ schedule_id: "s1", hour_from: 11, hour_to: 20, before: {}, after: {} }), evidence: "2 expiries at 11:00 (2026-10-19, 2026-10-20)", created_at: "2026-10-21T01:00:00.000Z" });
    s.transitionProposal({ proposal_id: sched, from: ["open"], to: "accepted", now: "2026-10-21T09:00:00.000Z" });
    const lad = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "ladder", scope: "turn.settle", chat_id: "555", draft_json: JSON.stringify({ entry_id: "turn.settle", move: "retire_judge" }), evidence: "3 ❌ on turn.settle in 14 days", created_at: "2026-10-21T01:00:00.000Z" });
    const move_id = s.insertLadderMove({ entry_id: "turn.settle", scope: "turn.settle", from_rung: "system_one", to_rung: "model", evidence: [lad], granted_by: "paco", granted_via: "improve.route", paco_callback_id: "cb1", revocable: true, created_at: "2026-10-21T09:00:00.000Z" });
    s.transitionProposal({ proposal_id: lad, from: ["open"], to: "accepted", now: "2026-10-21T09:00:00.000Z", result_json: JSON.stringify({ move_id }) });
    const d = buildDecisionDigest(s, NOW, ENV)!;
    expect(d.text).toContain("skill weekly-report drafted · 3 requests");
    expect(d.text).toContain("suggested: lesson · 3 requests");
    expect(d.text).toContain("skill invoice-finder promoted");
    expect(d.text).toContain("moved to 20:00 · 2 expiries at 11:00 (2026-10-19, 2026-10-20)");
    expect(d.text).toContain("ladder move retire_judge on turn.settle · 3 ❌ on turn.settle in 14 days");
    expect(buttons(d)).toEqual([`dec:sk:${drafted}:accept`, `dec:sk:${drafted}:dismiss`, `dec:pr:${sched}:rev`, `dec:lm:${move_id}:revoke`]);
    expect(d.offered).toEqual({ proposal_ids: [], job_ids: [drafted], decision_ids: [] });
  });
  it("Watch: corrections, abandoned, clarify rate, unattached by family, deferred, silent signals, wiki disarmed topics, embeddings unavailable days", () => {
    const s = RunStore.openInMemory();
    const run_id = createTelegramTurn(s, "x").run_id;
    s.recordChatTurn({ chat_id: "555", run_id, role: "assistant", text: "Which?", intent: "clarify", created_at: "2026-10-20T10:00:00.000Z" });
    s.recordChatTurn({ chat_id: "555", run_id, role: "assistant", text: "Done.", intent: "answer", created_at: "2026-10-20T10:01:00.000Z" });
    s.insertImproveSignal({ signal: "correction", value: "answer", run_id, chat_id: "555", about_run_id: run_id, created_at: "2026-10-20T10:00:00.000Z" });
    s.insertImproveSignal({ signal: "abandoned", value: "lookup", run_id, chat_id: "555", about_run_id: run_id, created_at: "2026-10-20T10:00:00.000Z" });
    s.insertImproveSignal({ signal: "dig_deeper", value: "lookup", run_id, chat_id: "555", about_run_id: run_id, created_at: "2026-10-20T10:00:00.000Z" });
    s.recordMemoryEvent("improve_signal_skipped", { signal: "rating", code: "no_run" }, "improve");
    s.beginImproveTick("2026-10-20", "2026-10-20T10:00:00.000Z"); s.finishImproveTick("2026-10-20", "done", { deferred: 2, deferred_outage: 4, embed_unavailable: 3 }, "2026-10-20T10:00:00.000Z");
    s.insertDecision({ ...D, verdict: "knowledge", rung: "rule", reason_code: "wiki_disarmed", p: null });
    s.insertDecision({ ...D, verdict: "nothing", reason_code: "inapplicable_top", p: 0.8 });
    s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "lesson", scope: "answer", chat_id: "555", draft_json: JSON.stringify({ scope: "ask", text: "Shorter." }), evidence: "lesson did not hold: 2 corrections since (9 d)", created_at: "2026-10-21T10:00:00.000Z" });
    const lines = buildDecisionDigest(s, NOW, ENV)!.text.split("\n");
    expect(lines).toEqual(expect.arrayContaining(["· corrections 1 · abandoned 1 · clarify rate 50%", "· unattached: rating 1", "· deferred 2", "· deferred on an outage 4", "· silent: review_unsure, lesson_unfollowed", "· wiki disarmed: 1 topics",
      "· embeddings unavailable: 1 days", "· inapplicable top 1", "· lessons not holding 1"]));
    expect(lines.some((l) => l.includes("dig_deeper"))).toBe(false); // it had a row in 7 days, so it is not silent
    // final fix D7: nothing produces review_bad since the ✅/❌ surface left the digest, so Watch names it while it is dark
  });
  it("the offer transaction: offered_at is set for exactly the rendered ids after a queued enqueue; a duplicate or conflicting enqueue sets nothing; an already-offered id keeps its first value", () => {
    const s = RunStore.openInMemory();
    const ids = open(s, 10);
    s.markProposalsOffered([ids[0]!], "2026-10-20T11:00:00.000Z");
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: true });
    const offered = ids.map((id) => s.getImprovementProposal(id)!.offered_at);
    expect(offered[0]).toBe("2026-10-20T11:00:00.000Z");
    expect(offered.slice(1, DIGEST_PROPOSALS_MAX)).toEqual(Array(DIGEST_PROPOSALS_MAX - 1).fill(NOW));
    expect(offered.slice(DIGEST_PROPOSALS_MAX)).toEqual([null, null]);
    expect(s.getDecisionDigest("2026-10-21")).toMatchObject({ sent: 1, offered: [] });
    const s2 = RunStore.openInMemory();
    const more = open(s2, 1);
    s2.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: "decision_digest:2026-10-21", correlation_id: "other", payload: { text: "taken" } });
    expect(runDecisionDigestTick({ store: s2, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: false }); // conflict: another payload holds the key
    expect(s2.getImprovementProposal(more[0]!)?.offered_at).toBeNull();
  });
  it("waits for the day's improve tick while it is running or stopped and under 30 min old; sends after the cap or once the tick is done (ruling 21)", () => {
    const s = RunStore.openInMemory();
    open(s, 1);
    s.beginImproveTick("2026-10-21", "2026-10-21T10:50:00.000Z");                                   // running, 10 min old
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: false });
    s.finishImproveTick("2026-10-21", "stopped", {}, NOW);                                            // budget-stopped, still young
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: false });
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: "2026-10-21T11:25:00.000Z", env: ENV })).toEqual({ ran: true, sent: true }); // 35 min after it started: the cap
    const s2 = RunStore.openInMemory();
    open(s2, 1);
    s2.beginImproveTick("2026-10-21", "2026-10-21T10:50:00.000Z"); s2.finishImproveTick("2026-10-21", "done", {}, NOW);
    expect(runDecisionDigestTick({ store: s2, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: true });
  });
  it("resolveDigestAt survives: off → the default, a time → itself", () => {
    expect(resolveDigestAt({ HOUGE_DECISION_DIGEST_AT: "off" })).toBe("21:00");
    expect(resolveDigestAt({ HOUGE_DECISION_DIGEST_AT: "20:30" })).toBe("20:30");
  });
});

describe("runDecisionDigestTick latch and switches", () => {
  const AT_ENV = { ...ENV, HOUGE_DECISION_DIGEST_AT: "22:30" };
  it("before HOUGE_DECISION_DIGEST_AT nothing runs; after it one message per local date", () => {
    const s = RunStore.openInMemory();
    open(s, 1);
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: AT_ENV })).toEqual({ ran: false }); // 22:00 < 22:30
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: "2026-10-21T11:40:00.000Z", env: AT_ENV })).toEqual({ ran: true, sent: true });
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: "2026-10-21T12:00:00.000Z", env: AT_ENV })).toEqual({ ran: false });
    expect(drainOutbox(s).size).toBe(1);
  });
  it("no operator chat: nothing runs; off (any case) sends nothing and writes no latch; a typo keeps the 21:00 digest", () => {
    const s = RunStore.openInMemory();
    open(s, 1);
    expect(runDecisionDigestTick({ store: s, chatId: null, now: NOW, env: ENV })).toEqual({ ran: false });
    for (const off of ["off", " OFF ", "Off"]) expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: { ...ENV, HOUGE_DECISION_DIGEST_AT: off } })).toEqual({ ran: false });
    expect(s.getDecisionDigest("2026-10-21")).toBeUndefined();
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: { ...ENV, HOUGE_DECISION_DIGEST_AT: "offf" } })).toEqual({ ran: true, sent: true });
  });
});

describe("buildDecisionDigest (2b-ii fix round 1)", () => {
  it("a failing or stopped tick and record failures reach Paco even on a day with no signals, proposals or jobs", () => {
    const s = RunStore.openInMemory();
    s.beginImproveTick("2026-10-21", "2026-10-21T09:00:00.000Z"); s.finishImproveTick("2026-10-21", "failed", { record_failed: 2 }, "2026-10-21T09:01:00.000Z");
    s.beginImproveTick("2026-10-20", "2026-10-20T09:00:00.000Z"); s.finishImproveTick("2026-10-20", "stopped", {}, "2026-10-20T09:01:00.000Z");
    expect(buildDecisionDigest(s, NOW, ENV)!.text).toContain("· ticks failed 1 · stopped 1 · record failed 2");
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: true });
    const ok = RunStore.openInMemory();
    ok.beginImproveTick("2026-10-21", "2026-10-21T09:00:00.000Z"); ok.finishImproveTick("2026-10-21", "done", {}, "2026-10-21T09:01:00.000Z");
    expect(buildDecisionDigest(ok, NOW, ENV)).toBeNull();
  });
  it("only the digest chat's proposals and jobs are rendered and offered; another chat's get no offered_at", () => {
    const s = RunStore.openInMemory();
    const mine = open(s, 1);
    const other = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "lesson", scope: "other", chat_id: "777", draft_json: JSON.stringify({ scope: "ask", text: "Elsewhere." }), evidence: "e", created_at: "2026-10-21T00:00:00.000Z" });
    const nochat = s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "lesson", scope: "none", chat_id: null, draft_json: JSON.stringify({ scope: "ask", text: "Nowhere." }), evidence: "e", created_at: "2026-10-21T00:00:00.000Z" });
    const d = buildDecisionDigest(s, NOW, ENV, "555")!;
    expect(d.offered.proposal_ids).toEqual(mine);
    expect(d.text).not.toContain("Elsewhere"); expect(d.text).not.toContain("Nowhere");
    runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV });
    expect(s.getImprovementProposal(other)!.offered_at).toBeNull();
    expect(s.getImprovementProposal(nochat)!.offered_at).toBeNull();
    expect(s.getImprovementProposal(mine[0]!)!.offered_at).toBe(NOW);
  });
  it("the 120 clip never splits an emoji at the boundary", () => {
    const head = `${"abcdefghi ".repeat(11)}abcdefgh `; // 119 code points of plain words (a long run of one letter reads as a secret)
    const s = RunStore.openInMemory();
    s.insertImprovementProposal({ decision_id: s.insertDecision(D), target: "lesson", scope: "e", chat_id: "555", draft_json: JSON.stringify({ scope: "ask", text: `${head}😀tail` }), evidence: "e", created_at: "2026-10-21T00:00:00.000Z" });
    expect(buildDecisionDigest(s, NOW, ENV)!.text).toContain(` · ${head}😀 · e`);
  });
  it("a duplicate enqueue (same key and payload) latches sent 0 and offers nothing", () => {
    const s = RunStore.openInMemory();
    const ids = open(s, 1);
    const d = buildDecisionDigest(s, NOW, ENV, "555")!;
    s.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: "decision_digest:2026-10-21", correlation_id: "decision-digest",
      payload: { text: d.text, button_rows: d.button_rows } });
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV })).toEqual({ ran: true, sent: false });
    expect(s.getImprovementProposal(ids[0]!)!.offered_at).toBeNull();
  });
});

describe("finished jobs are scoped to the digest chat", () => {
  it("a pending_review job of another chat, or of none, is neither rendered nor marked offered", () => {
    const s = RunStore.openInMemory();
    const job = (chat_id: string | null, name: string): string => {
      const id = s.insertImprovementJob({ decision_id: s.insertDecision(D), proposal_id: null, chat_id, origin_json: JSON.stringify({ turn_ids: ["t1"], run_ids: [], category: "answer", text_hashes: [] }), idempotency_key: name, created_at: "2026-10-21T01:00:00.000Z" })!;
      s.transitionJob({ job_id: id, from: ["queued"], to: "running", now: "2026-10-21T09:00:00.000Z", bumpAttempt: true });
      s.transitionJob({ job_id: id, from: ["running"], to: "pending_review", now: "2026-10-21T09:30:00.000Z", attempt: 1, patch: { pending_scope: "ask", pending_name: name, gate_a: "skill" } });
      return id;
    };
    const mine = job("555", "mine-skill"); const other = job("777", "other-skill"); const none = job(null, "none-skill");
    const d = buildDecisionDigest(s, NOW, ENV, "555")!;
    expect(d.offered.job_ids).toEqual([mine]);
    expect(d.text).toContain("mine-skill"); expect(d.text).not.toContain("other-skill"); expect(d.text).not.toContain("none-skill");
    runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: ENV });
    expect(s.getImprovementJob(mine)!.offered_at).toBe(NOW);
    expect(s.getImprovementJob(other)!.offered_at).toBeNull();
    expect(s.getImprovementJob(none)!.offered_at).toBeNull();
  });
});

// Review taps return to the digest (2b-ii follow-up 1): the rebuild dropped the Unsure section, so offered was always [] and
// wasDecisionOffered refused every tap; nothing produced review_ok / review_bad and the ladder target was dormant.
describe("the Unsure section and the review taps", () => {
  const BAR = barOf(REGISTRY.find((e) => e.id === "turn.settle")!)!;
  const settleRow = (run_id: string | null, p: number, o: Partial<DecisionInsert> = {}): DecisionInsert => ({ ...D, entry_id: "turn.settle", stage: "settle", run_id, p, verdict: "ok", reason_code: "jev_claims_done", ...o });
  const unsureDay = (s: RunStore, n = 1, run = createTelegramTurn(s, "m0").run_id) => Array.from({ length: n }, (_, k) => s.insertDecision(settleRow(run, BAR + 0.01 + k * 0.001, { created_at: `2026-10-21T0${k % 10}:30:00.000Z` })));

  it("renders Unsure after Proposals waiting and before Watch; each ✅/❌ round-trips through parseDecisionReviewCallback and the line carries only code-built words", () => {
    const s = RunStore.openInMemory();
    open(s, 1);
    const [id] = unsureDay(s);
    s.insertImproveSignal({ signal: "correction", value: "answer", run_id: null, chat_id: "555", about_run_id: null, created_at: "2026-10-21T02:00:00.000Z" });
    const d = buildDecisionDigest(s, NOW, ENV, "555")!;
    expect(d.text.split("\n").filter((l) => l.startsWith("**"))).toEqual(["**Proposals waiting**", "**Unsure** (✅ right · ❌ wrong)", "**Watch (7 d)**"]);
    expect(d.text).toContain(`1. turn.settle → ok · p ${(BAR + 0.01).toFixed(2)}`);
    expect(d.text).not.toContain("m0"); // Paco's message text never enters the line
    const review = buttons(d).filter((b) => b.startsWith("dec:rv:"));
    expect(review.map((b) => parseDecisionReviewCallback(b))).toEqual([{ decision_id: id, label: "ok" }, { decision_id: id, label: "bad" }]);
    expect(d.offered.decision_ids).toEqual([id]);
  });
  it("an Unsure section alone is a digest; rows outside the band, of another chat, or not applied are not shown; an empty section is omitted", () => {
    const s = RunStore.openInMemory();
    const run = createTelegramTurn(s, "x").run_id;
    s.insertDecision(settleRow(run, BAR - 0.01));
    s.insertDecision(settleRow(run, BAR + 0.2));
    s.insertDecision(settleRow(run, BAR + 0.02, { armed_mode: "shadow" }));
    expect(buildDecisionDigest(s, NOW, ENV, "555")).toBeNull();
    const inBand = s.insertDecision(settleRow(run, BAR + 0.02));
    expect(buildDecisionDigest(s, NOW, ENV, "555")!.offered.decision_ids).toEqual([inBand]);
    expect(buildDecisionDigest(s, NOW, ENV, "999")).toBeNull();
  });
  it("shows at most 8, newest first", () => {
    const s = RunStore.openInMemory();
    const ids = unsureDay(s, 10);
    const d = buildDecisionDigest(s, NOW, ENV, "555")!;
    expect(d.offered.decision_ids).toEqual(ids.slice(2).reverse());
    expect(d.button_rows.filter((r) => r[0]!.data.startsWith("dec:rv:"))).toHaveLength(UNSURE_MAX);
  });
  it("the tick latches the rendered decision ids as offered: a ❌ tap on one writes review_bad and reaches the improve inbox; a non-offered id is refused", () => {
    const s = RunStore.openInMemory();
    const run_id = createTelegramTurn(s, "x").run_id;
    const [id] = unsureDay(s);
    const other = s.insertDecision(settleRow(run_id, BAR + 0.9));
    expect(runDecisionDigestTick({ store: s, chatId: "555", now: NOW, env: { ...ENV, HOUGE_DECISION_DIGEST_AT: "00:00" } })).toEqual({ ran: true, sent: true });
    expect(s.getDecisionDigest("2026-10-21")!.offered).toEqual([id]);
    const tap = (decision_id: string, label: string) => buildTypedTaskEvent({ source: "telegram", type: "decision_review", requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: `t${decision_id}`, source_reference: `t${decision_id}`, metadata: { telegram_update_id: 1, telegram_callback_id: `t${decision_id}`, decision_id, label } });
    new Gateway(s).intake(tap(id!, "bad"), NOW);
    new Gateway(s).intake(tap(other, "bad"), NOW);
    expect(s.listDecisionOutcomes(id!).map((o) => [o.signal, o.value])).toEqual([["review_bad", "turn.settle"]]);
    expect(s.listDecisionOutcomes(other)).toEqual([]);
    s.mirrorOutcomesIntoInbox();
    expect(s.listImproveSignalsSince("2026-10-01T00:00:00.000Z").filter((x) => x.signal === "review_bad").map((x) => x.value)).toEqual(["turn.settle"]);
  });
  it("review_bad is no longer in the silent families once it has a producer", () => {
    const s = RunStore.openInMemory();
    s.insertImproveSignal({ signal: "correction", value: "answer", run_id: null, chat_id: "555", about_run_id: null, created_at: "2026-10-21T02:00:00.000Z" });
    expect(buildDecisionDigest(s, NOW, ENV)!.text).toMatch(/· silent: review_unsure, lesson_unfollowed, dig_deeper$/m);
  });
});

describe("the Watch line for a switched-off improvement tick", () => {
  it("says improvement tick off, so the silence is never silent, and an otherwise empty day is still sent", () => {
    const s = RunStore.openInMemory();
    expect(buildDecisionDigest(s, NOW, ENV)).toBeNull();
    const d = buildDecisionDigest(s, NOW, { ...ENV, HOUGE_IMPROVE_ENABLED: "false" })!;
    expect(d.text).toContain("**Watch (7 d)**\n· improvement tick off");
  });
});
