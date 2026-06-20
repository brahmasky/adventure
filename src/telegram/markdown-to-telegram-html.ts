/**
 * Convert the CommonMark the model emits into Telegram's HTML dialect (ADR 0010 fix).
 *
 * The daemon used to send replies with no `parse_mode`, so `**bold**` showed up as
 * literal asterisks. Telegram's Markdown dialects are inconsistent (legacy bold is a
 * single `*`; MarkdownV2 is strict and needs heavy escaping), so we target the HTML
 * dialect instead — it has a small, well-defined tag set and only `&`, `<`, `>` need
 * escaping in text.
 *
 * Conservative by design (correctness over completeness): we convert the inline marks
 * Houge actually produces (bold, italic, inline code, code fences, links) and HTML-escape
 * everything else. Code spans/blocks are extracted first so their contents are never
 * re-interpreted as markup.
 */

/** HTML-escape the three characters that are special in Telegram HTML text. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Private-use sentinels wrapping a placeholder index — cannot collide with real text. */
const STASH_OPEN = "";
const STASH_CLOSE = "";

export function markdownToTelegramHtml(md: string): string {
  // Stash converted HTML (code/links) behind a sentinel so its contents are never
  // re-interpreted by the later inline-markup passes, then restore it verbatim at the end.
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    placeholders.push(html);
    return `${STASH_OPEN}${placeholders.length - 1}${STASH_CLOSE}`;
  };

  // Strip our private-use sentinels from the input first, so a user pasting them can't
  // collide with the stash placeholders (which would otherwise restore to a literal
  // "undefined" and corrupt the message body).
  let text = md.replace(/[]/g, "");

  // 1) Fenced code blocks ```...``` → <pre> (stashed so inner text isn't re-parsed).
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    stash(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`)
  );

  // 2) Inline code `...` → <code> (stashed).
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code>${escapeHtml(code)}</code>`));

  // 3) Links [text](url) → <a href="url">text</a> (stashed; href + text escaped).
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    stash(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`)
  );

  // 4) Escape the remaining plain text BEFORE emitting bold/italic tags.
  text = escapeHtml(text);

  // 5) Bold **x** / __x__ → <b>x</b> (run before single-char italic).
  text = text.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^\n]+?)__/g, "<b>$1</b>");

  // 6) Italic *x* / _x_ → <i>x</i>.
  text = text.replace(/\*([^*\n]+?)\*/g, "<i>$1</i>");
  text = text.replace(/_([^_\n]+?)_/g, "<i>$1</i>");

  // 7) Restore stashed code/link HTML.
  text = text.replace(
    new RegExp(`${STASH_OPEN}(\\d+)${STASH_CLOSE}`, "g"),
    (_m, i: string) => placeholders[Number(i)]!
  );

  return text;
}
