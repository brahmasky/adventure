// Runs inside the omp planner process. Protected (self-write guard). Imports nothing from Houge but its siblings.
import { getBridge, HOOK_TIMEOUT_MS } from "./bridge-client.js";
import { applyFloor, FLOORED_TEXT } from "./injection-floor.js";

/** 2b-i §2.2: the canonical read text is capped before it crosses the bridge; Houge re-caps at its own 32 KiB. */
export const READ_TEXT_CAP = 32 * 1024;
export const TRUNCATED_NOTE = "[truncated by Houge at 32 KiB]";
type Block = { type: string; text?: string } & Record<string, unknown>;
export interface ReadResultEvent { toolName: string; toolCallId: string; isError?: boolean; content?: Block[]; details?: Record<string, unknown> }
type Reply = { verdict: "unchanged" } | { verdict: "rewritten"; text: string };
/** `timeoutMs`: the hook timer (HOOK_TIMEOUT_MS in the daemon; tests pass a short one through hougePolicy's option). */
export interface HookOpts { timeoutMs: number }

/** Text blocks joined with `\n` (omp's hashline header and `N:` prefixes included, P1'), cut on a UTF-8 boundary at the cap. Throws on a malformed content (the caller floors). */
export function canonicalText(content: Block[] | undefined): { text: string; capped: boolean } | null {
  if (content !== undefined && !Array.isArray(content)) throw new Error("malformed read content");
  const texts = (content ?? []).filter((b) => b.type === "text").map((b) => { if (typeof b.text !== "string") throw new Error("malformed text block"); return b.text; });
  if (texts.length === 0) return null;
  const joined = texts.join("\n");
  const buf = Buffer.from(joined, "utf8");
  if (buf.length <= READ_TEXT_CAP) return { text: joined, capped: false };
  let end = READ_TEXT_CAP;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: `${buf.subarray(0, end).toString("utf8")}\n${TRUNCATED_NOTE}`, capped: true };
}

/** The rewritten result: one text block at the first text block's position (images kept, later text blocks dropped), details spread with displayContent as an object (P1'). */
export function rewritten(e: ReadResultEvent, text: string): { content: Block[]; details: Record<string, unknown> } {
  const content: Block[] = [];
  let placed = false;
  for (const b of Array.isArray(e.content) ? e.content : []) {
    if (b.type !== "text") { content.push(b); continue; }
    if (!placed) { content.push({ type: "text", text }); placed = true; }
  }
  if (!placed) content.push({ type: "text", text });
  return { content, details: { ...(e.details ?? {}), displayContent: { text, startLine: 1 } } };
}

function sendReport(e: ReadResultEvent, o: HookOpts, bytes: number, durationMs: number, applied: boolean): void {
  void getBridge().request({ kind: "report", toolCallId: e.toolCallId, outcome: e.isError ? "failed" : "succeeded", bytes_out: bytes, duration_ms: durationMs, applied },
    { timeoutMs: o.timeoutMs }).catch(() => undefined);
}

type Canon = ReturnType<typeof canonicalText>;

/** Any failure: floor the text (fail closed). c undefined = the content itself was unreadable; the report is best-effort. */
function failClosed(e: ReadResultEvent, o: HookOpts, c: Canon | undefined, durationMs: number): unknown {
  try {
    if (c === null) return undefined;
    const floored = c === undefined ? { text: FLOORED_TEXT, withheld: true } : applyFloor(c.text);
    try { sendReport(e, o, Buffer.byteLength(c?.text ?? "", "utf8"), durationMs, false); } catch { /* the floored result still goes out */ }
    return floored.withheld || c?.capped ? rewritten(e, floored.text) : undefined;
  } catch {
    return rewritten(e, FLOORED_TEXT);
  }
}

/**
 * The `tool_result` handler for a built-in `read` (2b-i §2.2). Whatever happens inside — malformed content, a late bridge,
 * a bridge error, a throw — the model gets the judged text or the floored text, never raw text past the floor; the report
 * follows AFTER the result is returned (never awaited: an awaited report could hold the hook past omp's bound, codex B1).
 */
export async function readResultHook(e: ReadResultEvent, startedAt: number | undefined, o: HookOpts = { timeoutMs: HOOK_TIMEOUT_MS }): Promise<unknown> {
  const t0 = startedAt ?? Date.now();
  const durationMs = () => Date.now() - t0;
  let c: Canon | undefined;
  try {
    c = canonicalText(e.content);
    if (c === null) { sendReport(e, o, 0, durationMs(), true); return undefined; }
    const bytes = Buffer.byteLength(c.text, "utf8");
    const r: Reply = await getBridge().request({ kind: "judge_read", toolCallId: e.toolCallId, text: c.text }, { timeoutMs: o.timeoutMs });
    if (r.verdict === "rewritten" && typeof r.text === "string") { sendReport(e, o, bytes, durationMs(), true); return rewritten(e, r.text); }
    // codex plan B1: a read over the cap is rewritten to the capped text in EVERY branch, so nothing past 32 KiB reaches the model unjudged
    if (r.verdict === "unchanged") { sendReport(e, o, bytes, durationMs(), true); return c.capped ? rewritten(e, c.text) : undefined; }
    throw new Error("malformed judge_read reply");
  } catch {
    return failClosed(e, o, c, durationMs());
  }
}
