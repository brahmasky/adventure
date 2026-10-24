import type { Entry, RungAnswer } from "../types.js";

export type ToolManifestVerdict = "include" | "omit";

function rule(s: { include: boolean }): RungAnswer<ToolManifestVerdict> {
  return s.include ? { verdict: "include" } : { verdict: "omit" };
}

export const TOOL_MANIFEST: Entry<{ include: boolean }, ToolManifestVerdict> = {
  id: "tool.manifest", version: 1, stage: "pre_tool", input: "tool",
  question: "Should this tool appear in the manifest?",
  verdicts: ["include", "omit"],
  ladder: [{ kind: "rule", name: "manifest", decide: rule }],
  fail: "omit", defaultVerdict: "include", outcomes: [], armed: { rule: "on" },
  effects: { include: { kind: "none", reversible: true, announced: "none" }, omit: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [],
};
