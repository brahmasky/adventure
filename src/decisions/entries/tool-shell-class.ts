import type { Entry, RungAnswer } from "../types.js";
import { classifyCommand } from "../../omp/command-matcher.js";

export type ShellClassVerdict = "plain" | "external_write" | "destructive";
export type ShellClassReason = string;
const V = ["plain", "external_write", "destructive"] as const;

function rule(s: { command: string }): RungAnswer<ShellClassVerdict> {
  const c = classifyCommand(s.command);
  return c.kind === "plain" ? { verdict: "plain" } : { verdict: c.kind, reason: c.label };
}

export const TOOL_SHELL_CLASS: Entry<{ command: string }, ShellClassVerdict> = {
  id: "tool.shell_class", version: 1, stage: "pre_tool", input: "tool",
  question: "What class is this shell command: plain, external write, or destructive?",
  verdicts: V, ladder: [{ kind: "rule", name: "classifyCommand", decide: rule }],
  fail: "destructive", defaultVerdict: "plain", outcomes: [], armed: { rule: "on" },
  effects: {
    plain: { kind: "none", reversible: true, announced: "none" },
    external_write: { kind: "proposal", reversible: true, announced: "card", what: "an approval tap" },
    destructive: { kind: "proposal", reversible: true, announced: "card", what: "an approval tap" },
  },
  reasonCodes: [],
};
