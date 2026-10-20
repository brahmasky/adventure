import type { LedgerEvent } from "../run/run-ledger.js";
import type { SettleState } from "./entries/turn-settle.js";
import { isBookkeeping } from "./settle-checks.js";
export type { SettleState, TodoSnapshot } from "./entries/turn-settle.js";

/** 2b-i §3.1: Paco's message reaches the Jev copy capped; the reply's Jev copy is cut in settleJevState (head + tail). */
export const PACO_MESSAGE_CAP = 600;
export const SETTLE_JEV_HEAD = 4_000;
export const SETTLE_JEV_TAIL = 2_000;
export type RawSettleState = Omit<SettleState, "redacted" | "toolSummary">;

/** 2b-i final review A11.3: cuts in UTF-16 units never leave a lone surrogate (TypeSafe's JSON parser may reject one). */
const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const headOf = (s: string, n: number): string => s.slice(0, n > 0 && n < s.length && isHigh(s.charCodeAt(n - 1)) ? n - 1 : n);
const tailOf = (s: string, n: number): string => { const at = Math.max(0, s.length - n); return s.slice(at < s.length && isLow(s.charCodeAt(at)) ? at + 1 : at); };

/** Tool names and outcomes this turn, in ledger order, todo bookkeeping left out (A5); code-built, never text (spec §3.3). */
export function toolSummary(evidence: readonly LedgerEvent[]): string {
  const rows = evidence.filter((e) => e.event_type === "tool_finished" && !isBookkeeping(e)).map((e) => `${String(e.payload.tool ?? "unknown")}: ${String(e.payload.status ?? "unknown")}`);
  return rows.length === 0 ? "none" : rows.join("; ");
}

/** The redactor is a required argument (senior B4): no state reaches the Jev rung unredacted. */
export function buildSettleState(raw: RawSettleState, redact: (s: string) => string): SettleState {
  return { ...raw, redacted: { text: redact(raw.text), pacoMessage: headOf(redact(raw.pacoMessage), PACO_MESSAGE_CAP) }, toolSummary: toolSummary(raw.evidence) };
}

/** What leaves for TypeSafe: three strings, built HERE (protected) from the redacted fields only (senior plan W). */
export type SettleJevState = { reply: string; paco_message: string; tools: string }; // a type alias, not an interface: decide()'s state is Record<string, unknown> (senior plan r2)
/** Ruling 8: head and tail of the redacted reply (endings carry promises and permission asks), never the whole 32 KiB. */
export function settleJevState(s: SettleState): SettleJevState {
  const t = s.redacted.text;
  const reply = t.length <= SETTLE_JEV_HEAD + SETTLE_JEV_TAIL ? t : `${headOf(t, SETTLE_JEV_HEAD)}\n[…]\n${tailOf(t, SETTLE_JEV_TAIL)}`;
  return { reply, paco_message: s.redacted.pacoMessage, tools: s.toolSummary };
}
