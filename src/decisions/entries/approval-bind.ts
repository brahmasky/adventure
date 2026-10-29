import type { Entry, RungAnswer } from "../types.js";

export type ApprovalBindVerdict = "bound" | "unbound";
/** The omp sink's seven refusal codes verbatim (run-store.ts consumeToolApproval) plus no_sink for a resume with no sink. */
export const APPROVAL_BIND_REASONS = ["no_sink", "unknown_approval", "not_approved", "expired", "action_mismatch", "owner_mismatch", "requester_mismatch", "lease_lost"] as const;
const LISTED: ReadonlySet<string> = new Set(APPROVAL_BIND_REASONS);

function rule(s: { ok: boolean; code?: string }): RungAnswer<ApprovalBindVerdict> {
  if (s.ok) return { verdict: "bound" };
  return s.code !== undefined && LISTED.has(s.code) ? { verdict: "unbound", reason: s.code } : { verdict: "unbound" };
}

export const APPROVAL_BIND: Entry<{ ok: boolean; code?: string }, ApprovalBindVerdict> = {
  id: "approval.bind", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "Does this consume bind the approved row to this exact action, owner and requester?",
  verdicts: ["bound", "unbound"],
  ladder: [{ kind: "rule", name: "consumeBinding", decide: rule }],
  fail: "unbound", defaultVerdict: "bound", alwaysRecord: true, outcomes: [], armed: { rule: "on" },
  effects: { bound: { kind: "none", reversible: true, announced: "none" }, unbound: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [...APPROVAL_BIND_REASONS],
};
