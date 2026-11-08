import type { AttachCheck } from "../../notifications/attachment-check.js";
import type { Entry, RungAnswer } from "../types.js";

/** Spec R7 §4.3: may this `[[attach:]]` file go to Paco? Asked at the supervisor's parse (E2) and at the outbox's send-time re-check (E11). */
export const ATTACH_PATH_ID = "attach.path";
export type AttachVerdict = "send" | "refuse";
export type AttachInput = { seam: "parse"; check: "accepted" | "marker_outside" } | { seam: "send"; check: AttachCheck };
/** The send-time refusals (spec R7 §4.2 split): every check answer but `ok`. */
export const SEND_REASONS = ["over_count", "workspace_unverified", "outside_workspace", "not_a_file", "too_large", "linked", "changed", "not_found", "unreadable", "unsupported"] as const;

/** Maps the answer today's code already computed (one read, one predicate); it re-reads nothing. */
function rule(s: AttachInput): RungAnswer<AttachVerdict> {
  if (s.seam === "parse") return s.check === "accepted" ? { verdict: "send", reason: "parsed" } : { verdict: "refuse", reason: "marker_outside" };
  return s.check === "ok" ? { verdict: "send", reason: "checked" } : { verdict: "refuse", reason: s.check };
}

export const ATTACH_PATH: Entry<AttachInput, AttachVerdict> = {
  id: ATTACH_PATH_ID, version: 1, stage: "settle", input: "tool", locked: true,
  question: "May this [[attach:]] file go to Paco: its marker resolves inside the chat's workspace (parse), and at send it is still a single-link regular file of at most 20 MB, one of the first five, inside the verified workspace (send)?",
  verdicts: ["send", "refuse"],
  ladder: [{ kind: "rule", name: "attach_check", decide: rule }],
  fail: "refuse", defaultVerdict: "send", outcomes: [], armed: { rule: "on" },
  effects: {
    send: { kind: "none", reversible: true, announced: "none" },
    refuse: { kind: "tighten", reversible: true, announced: "none", what: "the file is not sent: at send, one '⚠ Not attached: <name> (<why>)' line follows the reply as today; at parse, the marker is dropped silently as today" }
  },
  reasonCodes: ["marker_outside", ...SEND_REASONS, "parsed", "checked"],
};
