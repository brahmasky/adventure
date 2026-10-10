import type { LlmResult } from "../../llm/types.js";
import { digestOutput } from "../output-digest.js";
import { buildReaderQuestion, parseReaderExtraction, READER_INPUT_CHAR_CAP, renderExtractionDigest } from "../quarantine.js";
import { LATE, within } from "./lane-time.js";
import type { StrictRead } from "./lane-types.js";

export interface StrictReaderDeps {
  /** One Reader-role one-shot (production: the omp seat with the planner family's D10 ordering). */
  reader(req: { question: string; system: string; deadlineMs: number; signal: AbortSignal }): Promise<LlmResult>;
  system: string;
}

/**
 * The planner's wall (`quarantineExtract`) without its fail-safe: the same digest → question → two attempts → parse, but a
 * parse miss is `{ok: false}` (a lane cannot answer from an "unreadable" digest; it falls through). Each attempt is
 * bounded by `attemptMs()`, read as it starts; none starts once it is ≤ 0.
 */
export async function quarantineExtractStrict(d: StrictReaderDeps, rawOutput: Record<string, unknown>, objective: string,
  o: { attemptMs: () => number; signal: AbortSignal }): Promise<StrictRead> {
  const question = buildReaderQuestion(objective, digestOutput(rawOutput, READER_INPUT_CHAR_CAP));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ms = o.attemptMs();
    if (ms <= 0) return attempt === 0 ? { ok: false, why: "reserve" } : { ok: false, why: "unreadable" };
    const r = await within(ms, d.reader({ question, system: d.system, deadlineMs: ms, signal: o.signal }), o.signal);
    if (o.signal.aborted) return { ok: false, why: "aborted" };
    if (r === LATE || !r.ok) continue;
    const extraction = parseReaderExtraction(r.answer);
    if (extraction) return { ok: true, extraction, digest: renderExtractionDigest(extraction) };
  }
  return { ok: false, why: "unreadable" };
}
