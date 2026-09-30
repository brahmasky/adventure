export type BridgeRequest =
  | { id: string; kind: "hello"; token: string }
  | { id: string; kind: "manifest" }
  | { id: string; kind: "call"; tool: string; input: Record<string, unknown>; toolCallId: string }
  | { id: string; kind: "gate"; tool: "read" | "edit" | "write"; input: Record<string, unknown>; toolCallId: string }
  | { id: string; kind: "report"; toolCallId: string; outcome: "succeeded" | "failed"; bytes_out: number; duration_ms: number };
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
