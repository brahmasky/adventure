/** `/changes` (spec 2026-11-03 §7): the background change log as one chat message, newest first. Code-built, no model. */
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { CHAT_TEXT_MAX, type RunStore } from "../run/run-store.js";

export const CHANGES_MAX_CHARS = CHAT_TEXT_MAX;
const ROW_MAX = 300;
const DAYS = 30;
const MAX_ROWS = 20;
const FETCH_ROWS = 500; // rows read before collapsing repeats; the "older" count comes from the table total
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `DD Mon HH:MM` in the display zone. */
function stamp(iso: string, zone: string): string {
  const local = formatInstantInZone(iso, zone); // YYYY-MM-DD HH:MM
  return `${local.slice(8, 10)} ${MONTHS[Number(local.slice(5, 7)) - 1]} ${local.slice(11, 16)}`;
}

/** At most ROW_MAX chars, cut on a word boundary with `…`; a backtick left unmatched by the cut is dropped. */
function cut(text: string): string {
  const t = text.trim();
  if (t.length <= ROW_MAX) return t;
  const head = t.slice(0, ROW_MAX - 1);
  const space = head.lastIndexOf(" ");
  let out = (space > 0 ? head.slice(0, space) : head).trimEnd();
  if ((out.match(/`/g)?.length ?? 0) % 2 === 1) out = out.slice(0, out.lastIndexOf("`")).trimEnd();
  return `${out}…`;
}

/** Consecutive rows (newest first) with identical text become one entry stamped by the newest, so a flapping kind cannot crowd the view. */
function collapse(rows: { text: string; created_at: string }[]): { text: string; created_at: string; n: number }[] {
  const out: { text: string; created_at: string; n: number }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.text === r.text) last.n += 1; else out.push({ text: r.text, created_at: r.created_at, n: 1 });
  }
  return out;
}

export function changesText(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env): string {
  const since = new Date(Date.parse(now) - DAYS * 86_400_000).toISOString();
  const entries = collapse(store.listChangeLog(since, FETCH_ROWS));
  if (entries.length === 0) return "No background changes in the last 30 days.";
  const zone = resolveDisplayZone(env);
  const out: string[] = ["🗂 **Background changes** (last 30 days)"];
  let used = out[0]!.length;
  let shown = 0, consumed = 0;
  for (const e of entries) {
    const line = `${stamp(e.created_at, zone)} · ${cut(e.text)}${e.n > 1 ? ` (×${e.n})` : ""}`;
    if (shown === MAX_ROWS || used + line.length + 1 + 20 > CHANGES_MAX_CHARS) break;
    out.push(line);
    used += line.length + 1;
    shown += 1;
    consumed += e.n;
  }
  const total = store.countChangeLogSince(since);
  if (consumed < total) out.push(`… ${total - consumed} older`);
  return out.join("\n");
}
