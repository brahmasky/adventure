import type { NotificationButton } from "../../notifications/notification-types.js";

/** Stage B §3/§6: every lane card's way to the planner. Code-owned copy; the tap re-admits the message, skipping triage. */
export const LANE_ASK_PREFIX = "lane:ask:";
export const DIG_DEEPER_TEXT = "🔍 Dig deeper";
const CALLBACK_DATA_MAX_BYTES = 64;
/** The renderer's own link syntax (`markdown-to-telegram-html.ts` step 3): any scheme, no whitespace in the url. */
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const ATTACH_MARKER = /\[\[attach:[^\]\n]*\]\]/g;

export function digDeeperButton(run_id: string): NotificationButton {
  const data = `${LANE_ASK_PREFIX}${run_id}`;
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) throw new Error("lane callback_data exceeds 64 bytes");
  return { text: DIG_DEEPER_TEXT, data };
}

/**
 * No masked link survives: `[label](url)` → `label (url)`, or the bare url when the label is the url (or empty). Nested
 * links (`[[BOM](https://bom.gov.au)](https://evil.example)`) unwrap one layer per pass, so the pass repeats until the text
 * stops changing. No cap is needed: every replacement drops at least one character (`[l](u)` → `l (u)`), so each pass that
 * changes the text makes it strictly shorter and the loop terminates; a lookup reply is composed over attacker-reachable
 * pages, so a bounded cap that could leave one `[label](url)` behind would be the exact hole.
 */
export function flattenLinks(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(MARKDOWN_LINK, (_m, label: string, url: string) => {
      const l = label.trim();
      return l.length === 0 || l === url ? url : `${l} (${url})`;
    });
    if (next === out) return out;
    out = next;
  }
}

/** The text a lane may deliver or store: attach markers gone, links flattened, trimmed. Shared by the card and the catch-up line. */
export function sanitizeLaneText(text: string): string {
  return flattenLinks(text.replace(ATTACH_MARKER, "")).trim();
}

/**
 * A lane reply is text only: attach markers stripped, links flattened, the optional note line, then Dig deeper. `null` when
 * nothing is left after stripping (a reply that was only an attach marker): the caller treats it as `empty_reply`.
 */
export function laneCard(i: { text: string; run_id: string; note?: string }): { text: string; buttons: NotificationButton[] } | null {
  const body = sanitizeLaneText(i.text);
  if (body.length === 0) return null;
  return { text: i.note ? `${body}\n\n${i.note}` : body, buttons: [digDeeperButton(i.run_id)] };
}

/** The card's line when a rule saved this turn (the memory card's header form). */
export function laneSavedNote(lesson_id: number, theme: string): string {
  return `📒 Saved lesson #${lesson_id} · ${theme}`;
}
