import { headerValue, HEADER_FIELD_CAP, SNIPPET_CAP } from "../capabilities/gmail-read.js";
import { sanitizeVenueText } from "../capabilities/text-hygiene.js";
import { redactForJudge } from "../decisions/egress.js";

/** Houge's own Gmail address (a code constant, not configuration). */
export const HOUGE_GMAIL_ADDRESS = "wukong.houge@gmail.com";
export const ADDRESS_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export interface GmailMetadata { id: string; threadId: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }
export interface MailItemState { item_id: string; gmail_message_id: string; thread_id: string; from_address: string; from_name: string | null; known_sender: boolean;
  subject: string | null; snippet: string | null; labels: string[]; important: boolean; received_at: string; thread_pinged_6h: boolean; backfill: boolean }
export interface MailJevState { from_name: string | null; from_address: string; known_sender: boolean; subject: string | null; snippet: string | null; labels: string[]; important: boolean }

/** Parses a From header; the address is lower-cased and must pass the allowlist, else "invalid". */
export function parseFrom(header: string | undefined): { address: string; name: string | null } {
  const raw = (header ?? "").trim();
  const angle = /^(.*)<([^<>]*)>\s*$/.exec(raw);
  const addr = (angle ? angle[2]! : raw).trim();
  const name = angle ? angle[1]!.trim().replace(/^"(.*)"$/, "$1").trim() : "";
  return { address: ADDRESS_RE.test(addr) ? addr.toLowerCase() : "invalid", name: name || null };
}

/** Hygiene, cap, then mask codes, link tokens and broker secrets; empty text is null. */
export function redactMailText(text: string | undefined, cap: number, brokerRedact: (s: string) => string): string | null {
  if (!text) return null;
  const clean = sanitizeVenueText(text, cap);
  if (!clean) return null;
  return redactForJudge(clean, { brokerRedact, codeShapes: true, linkTokens: true });
}

export function buildItemState(m: GmailMetadata, x: { item_id: string; known_sender: boolean; thread_pinged_6h: boolean; backfill: boolean; brokerRedact: (s: string) => string }): MailItemState {
  const msg = m as unknown as Record<string, unknown>;
  const from = parseFrom(headerValue(msg, "From"));
  const labels = Array.isArray(m.labelIds) ? m.labelIds.filter((l): l is string => typeof l === "string") : [];
  const ms = Number(m.internalDate);
  return {
    item_id: x.item_id, gmail_message_id: m.id, thread_id: m.threadId, from_address: from.address,
    from_name: redactMailText(from.name ?? undefined, HEADER_FIELD_CAP, x.brokerRedact), known_sender: x.known_sender,
    subject: redactMailText(headerValue(msg, "Subject"), HEADER_FIELD_CAP, x.brokerRedact),
    snippet: redactMailText(m.snippet, SNIPPET_CAP, x.brokerRedact),
    labels, important: labels.includes("IMPORTANT"),
    received_at: new Date(Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString(),
    thread_pinged_6h: x.thread_pinged_6h, backfill: x.backfill
  };
}

/** Exactly the seven keys Jev sees; a fresh literal, never a spread of the item state. */
export function jevStateOf(s: MailItemState): MailJevState {
  return { from_name: s.from_name, from_address: s.from_address, known_sender: s.known_sender, subject: s.subject, snippet: s.snippet, labels: s.labels, important: s.important };
}
