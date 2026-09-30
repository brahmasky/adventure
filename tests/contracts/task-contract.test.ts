import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { compileCodeSelfWriteContract, compileSelfDiagnoseContract, compileSkillAuthorContract, compileTaskContract, TURN_ACTIONS } from "../../src/contracts/task-contract.js";

const runEvent = buildTypedTaskEvent({
  source: "cli",
  type: "run",
  program: "research-brief",
  goal: "compare Pi, OpenClaw, and Hermes",
  requested_by: { kind: "user", id: "paco" },
  notify: { kind: "local" },
  idempotency_key: "cli:research-brief",
  source_reference: "argv"
});

describe("compileTaskContract", () => {
  it("compiles research-brief into a bounded contract", () => {
    const result = compileTaskContract(runEvent);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.allowed_actions).toContain("local_file_read");
      expect(result.contract.forbidden_actions).toContain("coding_agent_cli");
      expect(result.contract.contract_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects unknown programs", () => {
    const badEvent = { ...runEvent, program: "unknown-program" };
    const result = compileTaskContract(badEvent);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "TASK_CONTRACT_INVALID",
        message: "Unknown program: unknown-program"
      }
    });
  });

  it("compiles a turn into the omp planner envelope (spec §9; the classifier front door is gone)", () => {
    const turnEvent = buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "what's new with SpaceX?",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:turn-contract",
      source_reference: "telegram:update:1:message:1"
    });

    const result = compileTaskContract(turnEvent);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.objective).toBe("what's new with SpaceX?");
      // The envelope is every registry entry the bridge may execute; arming flags pick the manifest.
      // Bounty/external-work actions left with their features; intent_router/llm_answer with the classifier.
      expect(result.contract.allowed_actions).toEqual([...TURN_ACTIONS]);
      expect(result.contract.allowed_actions).not.toContain("bounty_scan");
      expect(result.contract.allowed_actions).not.toContain("external_work");
      expect(result.contract.budget.max_tool_calls).toBe(40);
      // external_write is reachable (bash `git push`), but only behind Paco's approval.
      expect(result.contract.forbidden_actions).not.toContain("external_write");
      expect(result.contract.approval_gates).toContain("external_write");
      expect(result.contract.contract_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects a turn with an empty message", () => {
    const empty = buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "   ",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:turn-empty",
      source_reference: "telegram:update:2:message:2"
    });
    expect(compileTaskContract(empty)).toEqual({
      ok: false,
      error: { code: "TASK_CONTRACT_INVALID", message: "Message is required" }
    });
  });

  it("the self-diagnose contract allows coding_agent_cli; the turn contract forbids it (ADR 0011)", () => {
    const self = compileSelfDiagnoseContract("why did you ask which 猴哥?");
    expect(self.allowed_actions).toContain("coding_agent_cli");
    expect(self.allowed_actions).toEqual(["coding_agent_cli", "llm_answer", "write_report"]);
    // Writes/destructive/paid stay forbidden; no new approval gate (external_read consult).
    expect(self.forbidden_actions).toContain("external_write");
    expect(self.forbidden_actions).toContain("destructive");
    expect(self.forbidden_actions).not.toContain("coding_agent_cli");
    expect(self.budget.max_tool_calls).toBe(3);
    expect(self.contract_hash).toMatch(/^[a-f0-9]{64}$/);

    // The normal turn contract keeps coding_agent_cli forbidden — unreachable from a turn.
    const turnEvent = buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "anything",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:turn-forbids-codex",
      source_reference: "telegram:update:9:message:9"
    });
    const turn = compileTaskContract(turnEvent);
    expect(turn.ok).toBe(true);
    if (turn.ok) {
      expect(turn.contract.allowed_actions).not.toContain("coding_agent_cli");
      expect(turn.contract.forbidden_actions).toContain("coding_agent_cli");
    }
  });

  it("the code-self-write contract allows coding_agent_cli; forbids shell/destructive/paid; no approval gate (ADR 0011 Phase 3)", () => {
    const self = compileCodeSelfWriteContract("fix the intent router so it sees your identity");
    // It OPENS write-mode coding_agent_cli (the only contracts that do are the self-* ones).
    expect(self.allowed_actions).toEqual(["coding_agent_cli", "llm_answer", "write_report"]);
    // Shell / destructive / paid / external_write stay forbidden — the diff is a branch, never a live write.
    expect(self.forbidden_actions).toContain("generic_shell");
    expect(self.forbidden_actions).toContain("destructive");
    expect(self.forbidden_actions).toContain("paid_action");
    expect(self.forbidden_actions).toContain("external_write");
    expect(self.forbidden_actions).not.toContain("coding_agent_cli");
    // NO new approval gate — the branch is reversible; merge is Paco's (the gate list is the safety floor only).
    expect(self.approval_gates).toEqual(["local_write", "external_write", "destructive", "paid"]);
    // Long time ceiling (write-Codex + the full test gate are slow); small tool budget (refine capped in-route).
    expect(self.budget.time_minutes).toBe(60);
    expect(self.budget.max_tool_calls).toBe(4);
    expect(self.contract_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("the skill-author contract forbids coding_agent_cli — skills are prose (ADR 0011 Phase 2b)", () => {
    const skill = compileSkillAuthorContract("write a skill for cross-checking figures");
    expect(skill.allowed_actions).toEqual(["llm_answer", "write_report"]);
    expect(skill.allowed_actions).not.toContain("coding_agent_cli");
    expect(skill.forbidden_actions).toContain("coding_agent_cli");
    expect(skill.forbidden_actions).toContain("external_write");
    expect(skill.forbidden_actions).toContain("destructive");
    expect(skill.budget.max_tool_calls).toBe(3);
    expect(skill.contract_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("compiles /ask into the built-in ask program contract", () => {
    const askEvent = buildTypedTaskEvent({
      source: "telegram",
      type: "ask",
      program: "ask",
      goal: "what should Houge do next?",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:ask-contract",
      source_reference: "telegram:update:1:message:1"
    });

    const result = compileTaskContract(askEvent);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.objective).toBe("what should Houge do next?");
      expect(result.contract.allowed_actions).toEqual(["llm_answer", "write_report"]);
      expect(result.contract.eval_hooks).toContain("milestone-2-ask-path");
    }
  });
});

describe("scheduler v2 provenance strip", () => {
  it("turn contract: a schedule-born run's allowed_actions EXCLUDE schedule_task", () => {
    const telegramEvent = buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "每周一早上8点给我AI周报",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: "t:strip-telegram",
      source_reference: "telegram:update:1:message:1"
    });
    const scheduleEvent = buildTypedTaskEvent({
      source: "schedule",
      type: "turn",
      program: "turn",
      goal: "AI周报：搜索Hacker News和X/Twitter本周AI领域最新进展并总结",
      requested_by: { kind: "schedule", id: "sch_test" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: "schedule:sch_test:2026-07-26T22:00:00.000Z",
      source_reference: "scheduled_tasks.sch_test"
    });
    const fromTelegram = compileTaskContract(telegramEvent);
    const fromSchedule = compileTaskContract(scheduleEvent);
    expect(fromTelegram.ok).toBe(true);
    expect(fromSchedule.ok).toBe(true);
    if (fromTelegram.ok && fromSchedule.ok) {
      expect(fromTelegram.contract.allowed_actions).toContain("schedule_task");
      expect(fromSchedule.contract.allowed_actions).not.toContain("schedule_task");
      // The strip is the ONLY difference in the action envelope.
      expect(fromSchedule.contract.allowed_actions).toEqual(
        fromTelegram.contract.allowed_actions.filter((a) => a !== "schedule_task")
      );
    }
  });
});
