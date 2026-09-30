import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../../src/contracts/task-contract.js";
import { telegramTurnEvent } from "../helpers/events.js";

describe("turn contract under omp (spec §9, plan deviation 4)", () => {
  const c = (source: "telegram" | "schedule") => {
    const r = compileTaskContract(telegramTurnEvent({ source }));
    if (!r.ok) throw new Error("compile failed");
    return r.contract;
  };
  it("allows the built-in and shell actions and no longer routes through a classifier", () => {
    expect(c("telegram").allowed_actions).toEqual(expect.arrayContaining(["fs_read", "fs_write", "shell", "shell_external", "shell_destructive"]));
    expect(c("telegram").allowed_actions).not.toContain("intent_router");
    expect(c("telegram").allowed_actions).not.toContain("llm_answer");
  });
  it("gates external writes and destructive actions but not local writes (D5 yolo)", () => {
    expect(c("telegram").approval_gates).toEqual(["external_write", "destructive", "paid"]);
  });
  it("keeps the provenance strip: a schedule-born run cannot create schedules", () => {
    expect(c("schedule").allowed_actions).not.toContain("schedule_task");
    expect(c("telegram").allowed_actions).toContain("schedule_task");
  });
  it("raises the per-turn cap to 40 now that reads are not budgeted", () => {
    expect(c("telegram").budget.max_tool_calls).toBe(40);
  });
  it("forbids only the coding agent and paid actions (shell_external must stay reachable, behind its gate)", () => {
    expect(c("telegram").forbidden_actions).toEqual(["coding_agent_cli", "paid_action"]);
  });
});
