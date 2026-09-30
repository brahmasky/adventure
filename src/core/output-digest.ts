// The text form of a tool's raw output (moved out of the deleted inner loop, Task 14): the omp
// wall hands exactly this, capped, to the quarantined reader as the untrusted source.

/** The standing header line above rendered to_local_time rows (the B5 relative_day rule). */
export const TIME_CONVERT_DIGEST_HEADER =
  "Use only each row's relative_day below to include/exclude events for today/tomorrow requests.";

/**
 * R1: the header for a digest whose rows carry a named local zone (`output.local_tz`) — one
 * clause telling the planner the rows are ALREADY in the user's zone, so prose never re-frames
 * the converted clocks as some other zone (07-12 live gate S3: correct Sydney clocks quoted as
 * 北京时间). Zone-less outputs keep the legacy header byte-identical.
 */
export function timeConvertDigestHeader(targetZone: string): string {
  return targetZone.length > 0
    ? `${TIME_CONVERT_DIGEST_HEADER} Local times below are already in the user's zone (${targetZone}).`
    : TIME_CONVERT_DIGEST_HEADER;
}

/** Discriminate to_local_time results (`{when, tz, local|error}`) from web results (`{title, url}`).
 *  An optional `label` (B6) rides along untouched — the guard is structural on when/tz only. */
function isTimeConvertResults(results: unknown[]): boolean {
  const first = results[0] as Record<string, unknown> | undefined;
  return (
    first !== undefined &&
    typeof first.when === "string" &&
    typeof first.tz === "string" &&
    (typeof first.local === "string" || typeof first.error === "string")
  );
}

/**
 * Digest a successful tool output, truncated under the char cap. `answer` outputs surface the
 * answer text; http_fetch-shaped outputs (`{url, status, content}` jointly) render a readable
 * header + content (+ redirect hint); web-search-shaped outputs render numbered result lines;
 * to_local_time outputs render labelled rows; anything else is compact JSON.
 */
export function digestOutput(output: Record<string, unknown>, charCap: number): string {
  let text: string;
  if (typeof output.answer === "string" && output.answer.trim().length > 0) {
    text = output.answer.trim();
  } else if (typeof output.url === "string" && typeof output.status === "number" && typeof output.content === "string") {
    const type = typeof output.content_type === "string" && output.content_type.length > 0 ? ` (${output.content_type})` : "";
    const lines = [`${output.url} → HTTP ${output.status}${type}`];
    if (typeof output.location === "string" && output.location.length > 0) {
      lines.push(`Redirect target: ${output.location} — fetch it as your next step if you still need the content.`);
    }
    if (typeof output.note === "string" && output.note.length > 0) lines.push(output.note);
    if (output.truncated === true) lines.push("(content truncated)");
    if (output.content.length > 0) lines.push(output.content);
    text = lines.join("\n");
  } else if (Array.isArray(output.results) && isTimeConvertResults(output.results)) {
    text = renderTimeConvertRows(output, output.results);
  } else if (Array.isArray(output.results)) {
    text = output.results
      .map((r, i) => {
        const row = r as Record<string, unknown>;
        const title = typeof row.title === "string" ? row.title : "";
        const url = typeof row.url === "string" ? row.url : "";
        const content = typeof row.content === "string" ? row.content : "";
        return `[${i + 1}] ${title} — ${url}${content ? `\n${content}` : ""}`;
      })
      .join("\n");
  } else {
    text = JSON.stringify(output);
  }
  return text.length > charCap ? `${text.slice(0, charCap)}…` : text;
}

/** to_local_time rows as `when (tz) → local (relative_day, local_zone)` lines (or a per-item error). */
function renderTimeConvertRows(output: Record<string, unknown>, results: unknown[]): string {
  // to_local_time: readable `when (tz) → local (relative_day, local_zone)` lines (or a
  // per-item error), so the planner reads the code-computed label instead of re-doing the
  // tz math itself. R1: `output.local_tz` (adapter-sanitized) names the zone the rows were
  // converted INTO, rendered INSIDE the existing parens — nothing may sit between
  // time and paren (the old relative-day guard matched `HH:MM (`).
  const targetZone = typeof output.local_tz === "string" ? output.local_tz.trim() : "";
  return [
    timeConvertDigestHeader(targetZone),
    ...results.map((r) => {
      const row = r as Record<string, unknown>;
      const when = typeof row.when === "string" ? row.when : "";
      const tz = typeof row.tz === "string" ? row.tz : "";
      // B6: the event label (adapter-sanitized — never raw model text) prefixes BOTH success
      // and error rows, so answer prose stays bound to the row that actually converted.
      const label = typeof row.label === "string" && row.label.length > 0 ? `${row.label}: ` : "";
      if (typeof row.error === "string" && row.error.length > 0) return `${label}${when} (${tz}) → error: ${row.error}`;
      const local = typeof row.local === "string" ? row.local : "";
      const relative = typeof row.relative_day === "string" ? row.relative_day : "";
      const frame = [relative, targetZone].filter((part) => part.length > 0).join(", ");
      return `${label}${when} (${tz}) → ${local} (${frame})`;
    })
  ].join("\n");
}
