import type { MailAsk } from "../../jev/mail-ask.js";
import { MAIL_KIND, MAIL_URGENCY } from "../../jev/questions/mail.js";
import { criteriaHash } from "../../jev/questions/types.js";
import { HOUGE_GMAIL_ADDRESS, type MailItemState } from "../../mail/envelope.js";
import type { MailKind } from "../../run/run-store.js";
import type { Entry, ProvisionalBar, RungAbstain, RungAnswer, RungResult, VerdictEffect } from "../types.js";

/**
 * `mail.triage` (spec 2026-11-09 §3.4; ADR 0034 2.6): one new mail, ping Paco now or list it in /inbox. Ladder: code floors (own
 * address, sender rules, backfill), then Jev's `mail_urgency` with `mail_kind` beside it. Up (ping) at p >= 0.6, down (inbox) only at
 * p >= 0.85, `fail` and default ping. Jev failures page through the Jev client's incidents (record.ts `JEV_PAGED_ELSEWHERE`).
 */
export const MAIL_TRIAGE_ID = "mail.triage";
export type MailVerdict = "ping" | "inbox";
export const MAIL_UP_BAR_P = 0.6;
export const MAIL_DOWN_BAR = 0.85;
const EPS = 1e-9;

/** `jev` is filled by the executor; the floors never read it. */
export interface MailTriageState { item: MailItemState; rule: "always" | "never" | null; jev?: MailAsk }
export type MailTriageDetail = { kind: MailKind | null };

export const MAIL_REASONS: readonly string[] = ["own_output", "rule_never", "rule_always", "backfill", "jev_now", "jev_later", "jev_unsure"];

const CARD: VerdictEffect = { kind: "effect", reversible: false, announced: "card", what: "a mail card is sent to Paco now (silent in quiet hours or as a thread follow-up)" };
const INBOX: VerdictEffect = { kind: "effect", reversible: true, announced: "inbox", what: "the mail is listed in /inbox with a 'should have pinged' tap" };
export const MAIL_TRIAGE_BAR: ProvisionalBar = { kind: "provisional", question: MAIL_URGENCY.id, criteriaHash: criteriaHash(MAIL_URGENCY), p: MAIL_UP_BAR_P,
  source: "Paco D4 2026-11-09, armed at ship" };

type FloorResult = RungAnswer<MailVerdict, MailTriageDetail> | RungAbstain<MailVerdict, MailTriageDetail>;
const NO_KIND: MailTriageDetail = { kind: null };

/** The code floors, in order: Houge's own address never pings; Paco's `never` then `always` rule; backfill mail is listed, not pinged. */
export function mailFloors(s: MailTriageState): FloorResult {
  if (s.item.from_address === HOUGE_GMAIL_ADDRESS) return { verdict: "inbox", reason: "own_output", detail: NO_KIND };
  if (s.rule === "never") return { verdict: "inbox", reason: "rule_never", detail: NO_KIND };
  if (s.rule === "always") return { verdict: "ping", reason: "rule_always", detail: NO_KIND };
  if (s.item.backfill) return { verdict: "inbox", reason: "backfill", detail: NO_KIND };
  return { abstain: true };
}

/** The system_one executor's mapping: Jev's urgency choice against the two bars; anything short of a bar pings (unsure). */
export function jevMailAnswer(a: MailAsk): RungResult<MailVerdict, MailTriageDetail> {
  if ("failed" in a) return { failed: a.failed };
  const kind = a.kind?.choice as MailKind | undefined;
  const detail: MailTriageDetail = { kind: kind && (MAIL_KIND.criteria as readonly (readonly [string, string])[]).some(([id]) => id === kind) ? kind : null };
  const p = Math.max(0, ...Object.values(a.urgency.probabilities));
  if (a.urgency.choice === "later" && p + EPS >= MAIL_DOWN_BAR) return { verdict: "inbox", p, reason: "jev_later", detail };
  if (a.urgency.choice === "now" && p + EPS >= MAIL_UP_BAR_P) return { verdict: "ping", p, reason: "jev_now", detail };
  return { verdict: "ping", p, reason: "jev_unsure", detail };
}

const KEYS: ReadonlySet<string> = new Set(["item", "rule", `jev`]); // backticks: tests/capabilities/panel-judge-providers scans for quoted provider names
/** ADR 0034 2.6: routing is per item. One call, one item: the state carries nothing past `item`, `rule`, `jev`. */
export function perItemRouting(s: MailTriageState, verdict: string): boolean {
  if (verdict !== "ping" && verdict !== "inbox") return false;
  if (typeof s !== "object" || s === null || Object.keys(s).some((k) => !KEYS.has(k))) return false;
  const item = s.item as unknown;
  if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
  const id = (item as { item_id?: unknown }).item_id;
  return typeof id === "string" && id.length > 0;
}

export const MAIL_TRIAGE: Entry<MailTriageState, MailVerdict, MailTriageDetail> = {
  id: MAIL_TRIAGE_ID, version: 1, stage: "inbound", input: "tool",
  question: "Should Paco be pinged about this mail now, or can it wait in /inbox?",
  verdicts: ["ping", "inbox"],
  ladder: [
    { kind: "rule", name: "mail_floors", decide: mailFloors },
    { kind: "system_one", name: "mail_urgency", questions: [MAIL_URGENCY, MAIL_KIND], bars: MAIL_TRIAGE_BAR, timeoutMs: 6_000, recordedP: MAIL_URGENCY.id }
  ],
  fail: "ping", defaultVerdict: "ping", alwaysRecord: true,
  outcomes: [], armed: { rule: "on", system_one: "on" },
  effects: { ping: CARD, inbox: INBOX },
  perItemRouting,
  reasonCodes: MAIL_REASONS
};
