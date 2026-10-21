import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { handleImprovementTap, TAP_FAILED_TEXT, TAP_HANDLED_TEXT } from "../../src/gateway/improvement-commands.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { parseSkillFile, setFrontmatterFields, SkillStore } from "../../src/skills/skill-store.js"; // drop the names a file does not use
import { createQueuedTurnRun, createTelegramTurn } from "../helpers/runs.js"; // drop whichever a file does not use
import { reconcileJobs } from "../../src/core/skill-job.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2b-ii §5.1, §5.2, §5.5, §5.6, §6.3: every tap is one improvement_taps row; a tap acts only on the state named for it,
// only on an offered subject, only within 14 days; anything else answers "Already handled." and writes only the tap row;
// a redelivered callback id replays the stored answer. Accept of a lesson/fact/schedule/ladder is one transaction with the
// state change; skill Accept promotes (collision → the collision card); tool_gap Accept replies the focus text.
const NOW = "2026-10-21T10:00:00.000Z";
const GOOD = "---\nname: weekly-report\nscope: ask\nwhen: asked\nanchors:\n  - a\nversion: 1\n---\n1. step\n";
const D: DecisionInsert = { entry_id: "improve.route", entry_version: 1, run_id: null, tool_call_id: null, stage: "after_turn", rung: "system_one", verdict: "lesson", p: 0.7, reason_code: "jev_choice",
  fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1, created_at: NOW };
let cb = 0;
const tap = (kind: "pr" | "sk" | "lm", id: string, action: string, callback = `cb${++cb}`) => buildTypedTaskEvent({ source: "telegram", type: "improvement_tap", requested_by: { kind: "user", id: "paco" },
  notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `telegram:1:callback:${callback}`, source_reference: `telegram:update:1:callback:${callback}`,
  metadata: { telegram_update_id: 1, telegram_callback_id: callback, kind, id, action } });
const reply = (s: RunStore) => [...drainOutbox(s).values()].map((p) => String(p.text));
function proposal(s: RunStore, target: "lesson" | "fact" | "schedule" | "skill" | "tool_gap" | "ladder", draft: unknown, scope = "answer", offered = true, chat_id = "555") {
  const run_id = createTelegramTurn(s, "x").run_id;
  const id = s.insertImprovementProposal({ decision_id: s.insertDecision({ ...D, run_id }), target, scope, chat_id, draft_json: JSON.stringify(draft), evidence: "e", created_at: NOW });
  if (offered) s.markProposalsOffered([id], NOW);
  return { id, run_id };
}
const skills = () => new SkillStore({ root: mkdtempSync(join(tmpdir(), "hg-skills-")) });

describe("proposal taps", () => {
  it("Accept on an open lesson saves it with Undo in one transaction, records the tap, replies; Dismiss on it afterwards is handled; a never-offered id is handled", () => {
    const s = RunStore.openInMemory();
    const { id } = proposal(s, "lesson", { scope: "ask", text: "Answer in one line." });
    expect(handleImprovementTap(s, skills(), tap("pr", id, "acc"), NOW)).toMatchObject({ ok: true, status: "improvement_tapped" });
    expect(s.getImprovementProposal(id)).toMatchObject({ state: "accepted", result_json: expect.stringContaining("lc_") });
    expect(reply(s)[0]).toMatch(/lesson #\d+ saved/i);
    handleImprovementTap(s, skills(), tap("pr", id, "dis"), NOW);
    expect(reply(s)).toEqual([TAP_HANDLED_TEXT]);
    const { id: never } = proposal(s, "lesson", { scope: "ask", text: "x" }, "lookup", false);
    handleImprovementTap(s, skills(), tap("pr", never, "acc"), NOW);
    expect(reply(s)).toEqual([TAP_HANDLED_TEXT]);
    expect(s.getImprovementProposal(never)?.state).toBe("open");
    expect(s.listImprovementTaps().map((t) => [t.action, t.result])).toEqual([["acc", "applied"], ["dis", "handled"], ["acc", "handled"]]);
  });
  it("a tap from another chat is handled and changes nothing (ruling 19); a store failure mid-effect answers the failed text and a NEW tap retries", () => {
    const s = RunStore.openInMemory();
    const { id } = proposal(s, "lesson", { scope: "ask", text: "Answer in one line." }, "answer", true, "-999");
    handleImprovementTap(s, skills(), tap("pr", id, "acc"), NOW);
    expect(reply(s)).toEqual([TAP_HANDLED_TEXT]);
    expect(s.getImprovementProposal(id)?.state).toBe("open");
    const { id: bad } = proposal(s, "lesson", { scope: "ask", text: "x".repeat(10) });
    const broken = Object.create(s) as RunStore; (broken as { saveReconciledLesson: unknown }).saveReconciledLesson = () => { throw new Error("disk full"); };
    handleImprovementTap(broken, skills(), tap("pr", bad, "acc"), NOW);
    expect(reply(s).at(-1)).toBe(TAP_FAILED_TEXT);
    expect(s.getImprovementProposal(bad)?.state).toBe("open");            // the transaction rolled back
    handleImprovementTap(s, skills(), tap("pr", bad, "acc"), NOW);        // a new callback id: the retry goes through
    expect(s.getImprovementProposal(bad)?.state).toBe("accepted");
  });
  it("a redelivered callback id replays the stored result and writes nothing new; a new callback id on an accepted proposal is handled", () => {
    const s = RunStore.openInMemory();
    const { id } = proposal(s, "lesson", { scope: "ask", text: "Answer in one line." });
    const first = tap("pr", id, "acc", "same");
    const a = handleImprovementTap(s, skills(), first, NOW);
    const b = handleImprovementTap(s, skills(), first, NOW);
    expect(b).toEqual(a);
    expect(s.listDecisionsBetween("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toHaveLength(1);
  });
  it("a tap older than 14 days after the offer is handled; expired proposals too", () => {
    const s = RunStore.openInMemory();
    const { id } = proposal(s, "lesson", { scope: "ask", text: "x" });
    handleImprovementTap(s, skills(), tap("pr", id, "acc"), "2026-11-06T10:00:00.000Z");
    expect(reply(s)).toEqual([TAP_HANDLED_TEXT]);
    expect(s.getImprovementProposal(id)?.state).toBe("open");
  });
  it("Revert's 14 days count from the Accept, not the offer (codex B21)", () => {
    const s = RunStore.openInMemory();
    const schedule_id = s.addScheduledTask({ chat_id: "555", goal: "check the mailbox", spec_json: JSON.stringify({ kind: "daily", at: "11:00" }), tz: "Australia/Sydney", next_run_at: "2026-10-22T00:00:00.000Z", now: "2026-10-01T00:00:00.000Z" }).schedule_id;
    const before = { spec_json: JSON.stringify({ kind: "daily", at: "11:00" }), tz: "Australia/Sydney", next_run_at: s.getScheduledTask(schedule_id)!.next_run_at };
    const after = { spec_json: JSON.stringify({ kind: "daily", at: "20:00" }), tz: "Australia/Sydney", next_run_at: "2026-10-22T09:00:00.000Z" };
    const { id } = proposal(s, "schedule", { schedule_id, before, after, hour_from: 11, hour_to: 20 }, "shell_external");
    handleImprovementTap(s, skills(), tap("pr", id, "acc"), "2026-11-03T10:00:00.000Z");     // accepted 13 days after the offer
    expect(s.getImprovementProposal(id)?.state).toBe("accepted");
    handleImprovementTap(s, skills(), tap("pr", id, "rev"), "2026-11-10T10:00:00.000Z");     // 20 days after the offer, 7 after the accept: allowed
    expect(s.getImprovementProposal(id)?.state).toBe("reverted");
  });
  it("schedule: Accept shifts the row only when its spec still equals before; Revert within 14 days restores under the same check; a second Revert is handled", () => {
    const s = RunStore.openInMemory();
    const schedule_id = s.addScheduledTask({ chat_id: "555", goal: "check the mailbox", spec_json: JSON.stringify({ kind: "daily", at: "11:00" }), tz: "Australia/Sydney", next_run_at: "2026-10-22T00:00:00.000Z", now: "2026-10-01T00:00:00.000Z" }).schedule_id;
    const before = { spec_json: JSON.stringify({ kind: "daily", at: "11:00" }), tz: "Australia/Sydney", next_run_at: s.getScheduledTask(schedule_id)!.next_run_at };
    const after = { spec_json: JSON.stringify({ kind: "daily", at: "20:00" }), tz: "Australia/Sydney", next_run_at: "2026-10-22T09:00:00.000Z" };
    const { id } = proposal(s, "schedule", { schedule_id, before, after, hour_from: 11, hour_to: 20 }, "shell_external");
    handleImprovementTap(s, skills(), tap("pr", id, "acc"), NOW);
    expect(s.getScheduledTask(schedule_id)).toMatchObject({ spec_json: after.spec_json, next_run_at: after.next_run_at });
    handleImprovementTap(s, skills(), tap("pr", id, "rev"), NOW);
    expect(s.getScheduledTask(schedule_id)?.spec_json).toBe(before.spec_json);
    expect(s.getImprovementProposal(id)?.state).toBe("reverted");
    handleImprovementTap(s, skills(), tap("pr", id, "rev"), NOW);
    expect(reply(s).at(-1)).toBe(TAP_HANDLED_TEXT);
    // Paco edited it meanwhile: Accept on a fresh proposal whose before no longer matches → handled, state expired
    const { id: id2 } = proposal(s, "schedule", { schedule_id, before: { ...before, spec_json: JSON.stringify({ kind: "daily", at: "07:00" }) }, after, hour_from: 7, hour_to: 20 }, "http_fetch");
    handleImprovementTap(s, skills(), tap("pr", id2, "acc"), NOW);
    expect(reply(s).at(-1)).toBe(TAP_HANDLED_TEXT);
    expect(s.getImprovementProposal(id2)?.state).toBe("expired");
  });
  it("ladder: Accept inserts a paco move with the callback id and no other change; tool_gap: Accept replies the self_write_propose focus text; a locked entry is refused by the store and answered handled", () => {
    const s = RunStore.openInMemory();
    const { id } = proposal(s, "ladder", { entry_id: "turn.settle", move: "retire_judge" }, "turn.settle");
    handleImprovementTap(s, skills(), tap("pr", id, "acc", "cbl"), NOW);
    const move = s.listLadderMovesCreatedSince("2026-01-01T00:00:00.000Z")[0]!;
    expect(move).toMatchObject({ entry_id: "turn.settle", scope: "turn.settle", from_rung: "system_one", to_rung: "model", granted_by: "paco", granted_via: "improve.route", paco_callback_id: "cbl", state: "active" });
    expect(s.getImprovementProposal(id)?.result_json).toBe(JSON.stringify({ move_id: move.move_id }));
    const { id: tg } = proposal(s, "tool_gap", { focus: "answer turns fail on model_error 3 times" }, "model_error");
    handleImprovementTap(s, skills(), tap("pr", tg, "acc"), NOW);
    expect(reply(s).at(-1)).toBe('Send this to start a self-write: self_write_propose focus="answer turns fail on model_error 3 times"');
    const { id: locked } = proposal(s, "ladder", { entry_id: "turn.trust", move: "lower_bar" }, "turn.trust");
    handleImprovementTap(s, skills(), tap("pr", locked, "acc"), NOW);
    expect(reply(s).at(-1)).toBe(TAP_HANDLED_TEXT);
  });
});

describe("skill job taps", () => {
  function pendingJob(s: RunStore, sk: SkillStore, name = "weekly-report", body = GOOD) {
    sk.writePending("ask", name, body.replace("weekly-report", name));
    const id = s.insertImprovementJob({ decision_id: s.insertDecision(D), proposal_id: null, chat_id: "555", origin_json: JSON.stringify({ turn_ids: ["t1"], run_ids: ["r1"], category: "answer", text_hashes: ["h"] }), idempotency_key: `${name}:${++cb}`, created_at: NOW })!; // unique per call (senior W18)
    s.transitionJob({ job_id: id, from: ["queued"], to: "running", now: NOW, bumpAttempt: true });
    s.transitionJob({ job_id: id, from: ["running"], to: "pending_review", now: NOW, attempt: 1, patch: { pending_scope: "ask", pending_name: name, gate_a: "skill" } });
    s.markJobsOffered([id], NOW);
    return id;
  }
  it("Accept promotes a pending_review draft: active tree, registry, pending gone, job promoted; a second Accept is handled", () => {
    const s = RunStore.openInMemory(); const sk = skills();
    const id = pendingJob(s, sk);
    handleImprovementTap(s, sk, tap("sk", id, "accept"), NOW);
    expect(s.getImprovementJob(id)).toMatchObject({ state: "promoted", promote_mode: "refuse" });
    expect(sk.list().map((m) => m.name)).toEqual(["weekly-report"]);
    expect(sk.listPending()).toEqual([]);
    handleImprovementTap(s, sk, tap("sk", id, "accept"), NOW);
    expect(reply(s).at(-1)).toBe(TAP_HANDLED_TEXT);
  });
  it("Accept on a name that collides moves the job to collision with the Replace/Keep/Dismiss card and resets offered_at; Replace then retires the active one and promotes; Keep gives -2", () => {
    const s = RunStore.openInMemory(); const sk = skills();
    sk.writeSkill("ask", "weekly-report", GOOD.replace("asked", "old"));
    const id = pendingJob(s, sk);
    handleImprovementTap(s, sk, tap("sk", id, "accept"), NOW);
    expect(s.getImprovementJob(id)).toMatchObject({ state: "collision", offered_at: NOW });
    const out = drainOutbox(s);
    const card = [...out.entries()].find(([k]) => k === `improve_job:${id}:1:collision`)![1];
    expect((card.buttons as Array<{ data: string }>).map((b) => b.data)).toEqual([`dec:sk:${id}:replace`, `dec:sk:${id}:keep`, `dec:sk:${id}:dismiss`]);
    handleImprovementTap(s, sk, tap("sk", id, "replace"), NOW);
    expect(s.getImprovementJob(id)).toMatchObject({ state: "promoted", promote_mode: "replace" });
    expect(sk.listRetired().map((m) => m.name)).toEqual(["weekly-report"]);
    expect(sk.readSkill("ask", "weekly-report")?.meta.when).toBe("asked");
    // a draft identical to the active file is a retry of a finished promotion (Task 11), not a collision: this one differs
    const id2 = pendingJob(s, sk, "weekly-report", GOOD.replace("asked", "again"));
    handleImprovementTap(s, sk, tap("sk", id2, "accept"), NOW);
    handleImprovementTap(s, sk, tap("sk", id2, "keep"), NOW);
    expect(s.getImprovementJob(id2)).toMatchObject({ state: "promoted", pending_name: "weekly-report-2" });
    expect(sk.list().map((m) => m.name).sort()).toEqual(["weekly-report", "weekly-report-2"]);
  });
  it("a crash after the promoting step is finished by the tick's reconcile, which finds an already-promoted file by its origin stamp", () => {
    const s = RunStore.openInMemory(); const sk = skills();
    const id = pendingJob(s, sk);
    s.transitionJob({ job_id: id, from: ["pending_review"], to: "promoting", now: NOW, patch: { promote_mode: "refuse" } });
    reconcileJobs({ store: s, skills: sk, now: NOW, chatId: "555" });
    expect(s.getImprovementJob(id)?.state).toBe("promoted");
    expect(sk.list().map((m) => m.name)).toEqual(["weekly-report"]);
  });
  it("Dismiss on pending_review or collision retires the draft; replace/keep on pending_review are handled; a suggested job's taps are handled", () => {
    const s = RunStore.openInMemory(); const sk = skills();
    const id = pendingJob(s, sk);
    handleImprovementTap(s, sk, tap("sk", id, "replace"), NOW);
    expect(reply(s).at(-1)).toBe(TAP_HANDLED_TEXT);
    handleImprovementTap(s, sk, tap("sk", id, "dismiss"), NOW);
    expect(s.getImprovementJob(id)?.state).toBe("dismissed");
    expect(sk.listRetired().map((m) => m.name)).toEqual(["weekly-report"]);
  });
});

describe("ladder move taps", () => {
  it("Revoke ends an active move once; the move is chat-bound through its proposal", () => {
    const s = RunStore.openInMemory();
    const { id: pr } = proposal(s, "ladder", { entry_id: "turn.settle", move: "retire_judge" }, "turn.settle");
    const move_id = s.insertLadderMove({ entry_id: "turn.settle", scope: "turn.settle", from_rung: "system_one", to_rung: "model", evidence: [pr], granted_by: "paco", granted_via: "improve.route", paco_callback_id: "cb0", revocable: true, created_at: NOW });
    const other = buildTypedTaskEvent({ ...tap("lm", move_id, "revoke"), notify: { kind: "telegram", chat_id: "-999" } });
    handleImprovementTap(s, skills(), other, NOW);
    expect(s.getLadderMove(move_id)?.state).toBe("active");
    handleImprovementTap(s, skills(), tap("lm", move_id, "revoke"), NOW);
    expect(s.getLadderMove(move_id)?.state).toBe("ended");
    handleImprovementTap(s, skills(), tap("lm", move_id, "revoke"), NOW);
    expect(reply(s)).toEqual([TAP_HANDLED_TEXT, expect.stringMatching(/revoked/i), TAP_HANDLED_TEXT]);
  });
});
