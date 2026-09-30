export type BridgeRequest =
  | { id: string; kind: "hello"; token: string }
  | { id: string; kind: "manifest" }
  | { id: string; kind: "call"; tool: string; input: Record<string, unknown>; toolCallId: string }
  | { id: string; kind: "gate"; tool: "read" | "edit" | "write"; input: Record<string, unknown>; toolCallId: string }
  | { id: string; kind: "report"; toolCallId: string; outcome: "succeeded" | "failed"; bytes_out: number; duration_ms: number };
export type BridgeResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export const encodeLine = (msg: object): string => `${JSON.stringify(msg)}\n`;

const MAX_BUFFERED = 1_000_000;

export class LineDecoder {
  private buf = "";
  /** Set once an unterminated line passed MAX_BUFFERED; the caller must drop the connection. */
  overflowed = false;
  push(chunk: string): object[] {
    this.buf += chunk;
    const out: object[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (line.trim().length === 0) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (typeof v === "object" && v !== null && !Array.isArray(v)) out.push(v);
      } catch { /* drop malformed line */ }
    }
    if (this.buf.length > MAX_BUFFERED) { this.buf = ""; this.overflowed = true; }
    return out;
  }
}
