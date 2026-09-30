// Runs inside the omp planner process. Protected (self-write guard). Imports nothing from Houge but its sibling.
import { getBridge, registered } from "./bridge-client.js";
import type { PiLike } from "./houge-tools.js";

export const BUILTIN_TOOLS = ["read", "edit", "write"] as const;
export const TOOL_NOT_ALLOWED = "tool_not_allowed";
const isBuiltin = (n: string): n is (typeof BUILTIN_TOOLS)[number] => (BUILTIN_TOOLS as readonly string[]).includes(n);
const startedAt = new Map<string, number>();

const MAX_GATE_PATHS = 64;

/** Gate contract: the daemon sees path fields only, never a write/edit body (bridge-protocol.ts). */
function gateInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["path", "file_path"]) if (typeof input?.[k] === "string") out[k] = input[k];
  if (Array.isArray(input?.paths)) out.paths = input.paths.filter((p): p is string => typeof p === "string").slice(0, MAX_GATE_PATHS);
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
        startedAt.set(e.toolCallId, Date.now());
        const r = await getBridge().request({ kind: "gate", tool: e.toolName, input: gateInput(e.input), toolCallId: e.toolCallId });
        if (r?.decision === "allow") return undefined;
        startedAt.delete(e.toolCallId); // blocked: omp emits no tool_result to clear it
        return { block: true, reason: String(r?.reason ?? "denied") };
      }
      return registered.has(e.toolName) && (await bridgeTools()).has(e.toolName) ? undefined : { block: true, reason: TOOL_NOT_ALLOWED };
    } catch (err) {
      startedAt.delete(e.toolCallId);
      return { block: true, reason: `bridge_unavailable: ${(err as Error).message}` };
    }
  });
  pi.on("tool_result", async (e: { toolName: string; toolCallId: string; isError?: boolean; content?: Array<{ text?: string }> }) => {
    if (!isBuiltin(e.toolName)) return;
    const bytes = (e.content ?? []).reduce((n, c) => n + Buffer.byteLength(c.text ?? "", "utf8"), 0);
    const t0 = startedAt.get(e.toolCallId); startedAt.delete(e.toolCallId);
    await getBridge().request({ kind: "report", toolCallId: e.toolCallId, outcome: e.isError ? "failed" : "succeeded", bytes_out: bytes, duration_ms: t0 === undefined ? 0 : Date.now() - t0 }).catch(() => undefined);
  });
}
