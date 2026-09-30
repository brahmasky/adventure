// Runs inside the omp planner process. Protected (self-write guard). Imports nothing from Houge but its sibling.
import { getBridge } from "./bridge-client.js";
import type { PiLike } from "./houge-tools.js";

export const BUILTIN_TOOLS = ["read", "edit", "write"] as const;
export const TOOL_NOT_ALLOWED = "tool_not_allowed";
const isBuiltin = (n: string): n is (typeof BUILTIN_TOOLS)[number] => (BUILTIN_TOOLS as readonly string[]).includes(n);

/** Gate contract: the daemon sees path fields only, never a write/edit body (bridge-protocol.ts). */
function gateInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["path", "file_path"]) if (typeof input?.[k] === "string") out[k] = input[k];
  return out;
}

export default async function hougePolicy(pi: PiLike): Promise<void> {
  let allowed: Set<string> | null = null;
  const bridgeTools = async () => {
    allowed ??= new Set((await getBridge().request({ kind: "manifest" }) as Array<{ name: string }>).map((d) => d.name));
    return allowed;
  };
  pi.on("tool_call", async (e: { toolName: string; toolCallId: string; input: Record<string, unknown> }) => {
    try {
      if (isBuiltin(e.toolName)) {
        const r = await getBridge().request({ kind: "gate", tool: e.toolName, input: gateInput(e.input), toolCallId: e.toolCallId });
        return r.decision === "allow" ? undefined : { block: true, reason: String(r.reason ?? "denied") };
      }
      return (await bridgeTools()).has(e.toolName) ? undefined : { block: true, reason: TOOL_NOT_ALLOWED };
    } catch (err) {
      return { block: true, reason: `bridge_unavailable: ${(err as Error).message}` };
    }
  });
  pi.on("tool_result", async (e: { toolName: string; toolCallId: string; isError?: boolean; content?: Array<{ text?: string }> }) => {
    if (!isBuiltin(e.toolName)) return;
    const bytes = (e.content ?? []).reduce((n, c) => n + (c.text?.length ?? 0), 0);
    await getBridge().request({ kind: "report", toolCallId: e.toolCallId, outcome: e.isError ? "failed" : "succeeded", bytes_out: bytes, duration_ms: 0 }).catch(() => undefined);
  });
}
