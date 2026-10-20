export type BridgeRequest =
  | { id: string; kind: "hello"; token: string }
  | { id: string; kind: "manifest" }
  | { id: string; kind: "call"; tool: string; input: Record<string, unknown>; toolCallId: string }
  | { id: string; kind: "gate"; tool: "read" | "edit" | "write"; input: Record<string, unknown>; toolCallId: string }
  /** `applied` (2b-i §2.1): the judge_read reply arrived inside the extension's timer and was applied; absent counts as false. `tool`: only for an ungated built-in (`todo`), which has no gate row to name it. */
  | { id: string; kind: "report"; toolCallId: string; outcome: "succeeded" | "failed"; bytes_out: number; duration_ms: number; applied?: boolean; tool?: string }
  /** 2b-i §2.2: the canonical text of a built-in `read` result (<= 32 KiB), judged by tool.injection before the model reads it. */
  | { id: string; kind: "judge_read"; toolCallId: string; text: string }
  /** 2b-i §2.3: omp's session_stop; Houge decides turn.settle and answers whether the reply goes back for one more pass. */
  | { id: string; kind: "settle"; stop_hook_active: boolean; text: string };
export type JudgeReadReply = { verdict: "unchanged" } | { verdict: "rewritten"; text: string };
export type SettleReply = { sendBack: false } | { sendBack: true; note: string };
export type BridgeResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export const encodeLine = (msg: object): string => `${JSON.stringify(msg)}\n`;

// Contract: a `gate` request's input carries PATH FIELDS ONLY ({ path, file_path }), never a write/edit body
// (the extension strips it), so no legitimate frame is large. 16 MB is headroom for big `call` results/inputs.
const MAX_BUFFERED = 16 * 1024 * 1024;

export class LineDecoder {
  /** Pieces of the current unterminated line; joined only when a newline arrives (a 16 MB line is never re-copied per chunk). */
  private parts: string[] = [];
  private size = 0;
  /** Set once an unterminated line passed MAX_BUFFERED; the caller must drop the connection. */
  overflowed = false;
  push(chunk: string): object[] {
    const out: object[] = [];
    let rest = chunk;
    for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
      const line = this.parts.join("") + rest.slice(0, i);
      this.parts = []; this.size = 0; rest = rest.slice(i + 1);
      if (line.trim().length === 0) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (typeof v === "object" && v !== null && !Array.isArray(v)) out.push(v);
      } catch { /* drop malformed line */ }
    }
    if (rest.length > 0) { this.parts.push(rest); this.size += rest.length; }
    if (this.size > MAX_BUFFERED) { this.parts = []; this.size = 0; this.overflowed = true; }
    return out;
  }
}
