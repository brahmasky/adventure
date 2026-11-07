import { DIGEST_PR_PREFIX } from "../decisions/digest.js";
import { redactForImprove } from "../decisions/egress.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { ImprovementProposalRow, ProposalTarget, RunStore } from "../run/run-store.js";

/**
 * Spec 2026-11-07 §2, §5: a proposal that does not apply on its own is one card at the tick (topic improve_card, chat),
 * Accept / Dismiss, offered as the digest once offered it (offered_at starts the 14-day tap window). Code-built lines:
 * the redacted draft, its AVOID, the evidence.
 */
export const DRAFT_LINE_CHARS = 120;
/** `knowledge` is recorded only (ADR 0034 R5: NEEDS_DRAFT excludes it, draftFor returns null) and never reaches a card; the key exists for the closed record type. */
export const CARD_LABEL: Readonly<Record<ProposalTarget, string>> = { lesson: "📒 Lesson", fact: "🧠 Fact", skill: "🛠 Skill", schedule: "⏰ Schedule", knowledge: "📚 Knowledge", tool_gap: "🔧 Tool gap", ladder: "🪜 Ladder" };
export type CardProposal = Pick<ImprovementProposalRow, "proposal_id" | "target" | "draft_json" | "evidence">;

/** Code points, not UTF-16 units: a split surrogate pair would make Telegram reject the HTML send. */
export const clip = (text: string, n: number): string => Array.from(text.replace(/\s+/g, " ").trim()).slice(0, n).join("");
export function button(text: string, data: string): NotificationButton {
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("proposal callback_data exceeds 64 bytes");
  return { text, data };
}
/** A stored JSON object, or {} for anything else: a corrupt row never breaks a card or a /changes line. */
export function parsed(json: string | null): Record<string, unknown> {
  try { const v: unknown = JSON.parse(json ?? "{}"); return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What a proposal's draft says in one line (redacted before the cut so a secret is never half-shown). */
export function draftSummary(store: RunStore, p: Pick<ImprovementProposalRow, "target" | "draft_json">, chars: number): string {
  const d = parsed(p.draft_json);
  const raw = p.target === "lesson" || p.target === "fact" ? str(d.text)
    : p.target === "schedule" ? `move ${str(d.schedule_id).slice(0, 12)} to ${String(d.hour_to ?? "?")}:00`
    : p.target === "ladder" ? `${str(d.move)} on ${str(d.entry_id)}` : str(d.text);
  return clip(redactForImprove(store, raw), chars);
}
/** A lesson's AVOID enters every planner prompt, so the card shows it, redacted then clipped like the text (final fix A2). */
export function avoidSummary(store: RunStore, p: Pick<ImprovementProposalRow, "target" | "draft_json">, chars: number): string {
  const avoid = p.target === "lesson" ? str(parsed(p.draft_json).avoid) : "";
  return avoid ? ` · AVOID: ${clip(redactForImprove(store, avoid), chars)}` : "";
}
export function proposalCardText(store: RunStore, p: CardProposal): string {
  return `${CARD_LABEL[p.target]} proposal · ${draftSummary(store, p, DRAFT_LINE_CHARS)}${avoidSummary(store, p, DRAFT_LINE_CHARS)} · ${p.evidence}`;
}
export function proposalCardButtons(proposal_id: string): NotificationButton[] {
  return [button("✅ Accept", `${DIGEST_PR_PREFIX}${proposal_id}:acc`), button("🗑 Dismiss", `${DIGEST_PR_PREFIX}${proposal_id}:dis`)];
}
/** Inside the group's transaction: the card row (keyed by proposal, so a redelivery is a duplicate) and offered_at. A refused enqueue throws: no silent card loss. */
export function queueProposalCard(store: RunStore, p: CardProposal, chat_id: string, now: string): void {
  const r = store.enqueueNotification({ topic: "improve_card", target: { kind: "telegram", chat_id }, intent_type: "progress", idempotency_key: `improve_proposal:${p.proposal_id}`,
    correlation_id: `improve_proposal:${p.proposal_id}`, payload: { text: proposalCardText(store, p), buttons: proposalCardButtons(p.proposal_id) } });
  if (r.status !== "queued" && r.status !== "duplicate") throw new Error(`proposal card not queued: ${r.status}`);
  store.markProposalsOffered([p.proposal_id], now);
}
