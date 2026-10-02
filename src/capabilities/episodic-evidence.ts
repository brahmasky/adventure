import type { ChatTurnRow } from "../run/run-store.js";

/**
 * Evidence for extracted facts (memory A1 §4): provenance, not truth. The extract transcript is numbered
 * (`[n] user: …`) and flattened, each fact names `{line, quote}`, and code checks that line n is a user turn of a
 * run that is not schedule-born and that the quote is a substring of the line's clipped text after NFKC and
 * whitespace normalisation. A matching quote can still be a question or a hypothetical: that judgment is the
 * extract prompt's in A1 and the A2 cascade's after.
 */
export type EvidenceMode = "off" | "shadow" | "enforce";

export function resolveEpisodicEvidenceMode(env: NodeJS.ProcessEnv): EvidenceMode {
  const raw = env.HOUGE_EPISODIC_EVIDENCE?.trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "shadow";
}

export type EvidenceReason = "missing" | "bad_line" | "not_user" | "schedule_born" | "quote_absent";

/** Per-turn clip of the extract feed (a bounded read, never the whole message). */
export const EXTRACT_TURN_CHARS = 400;

/** Every line-break class inside a turn becomes a space: turn text can never forge a `[n] user:` line. */
export function flattenTurnText(text: string): string {
  return text.replace(/[\r\n\u2028\u2029\u0085\v\f]+/g, " ");
}

export function normalizeForEvidence(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export interface TranscriptLine {
  /** 1-based, as shown to the model. */
  n: number;
  turn: Pick<ChatTurnRow, "role" | "text"> & Partial<Pick<ChatTurnRow, "turn_id" | "run_id">>;
  /** The flattened, clipped text the model saw (what a quote is checked against). */
  text: string;
}

export function transcriptLines(turns: ReadonlyArray<TranscriptLine["turn"]>, cap: number): TranscriptLine[] {
  return turns.slice(-cap).map((turn, i) => ({ n: i + 1, turn, text: flattenTurnText(turn.text).slice(0, EXTRACT_TURN_CHARS) }));
}

export function checkEvidence(
  evidence: { line: number; quote: string } | null,
  lines: readonly TranscriptLine[],
  runSource: (runId: string) => string | undefined
): { ok: true; turn_id: string } | { ok: false; reason: EvidenceReason } {
  if (!evidence) return { ok: false, reason: "missing" };
  const line = lines[evidence.line - 1];
  if (!line?.turn.turn_id) return { ok: false, reason: "bad_line" };
  if (line.turn.role !== "user") return { ok: false, reason: "not_user" };
  if (line.turn.run_id !== undefined && runSource(line.turn.run_id) === "schedule") return { ok: false, reason: "schedule_born" };
  const quote = normalizeForEvidence(evidence.quote);
  if (quote.length === 0 || !normalizeForEvidence(line.text).includes(quote)) return { ok: false, reason: "quote_absent" };
  return { ok: true, turn_id: line.turn.turn_id };
}
