// Runs inside the omp planner process. Protected (self-write guard). Imports nothing from Houge.
import { getBridge, registered } from "./bridge-client.js";

export const HEARTBEAT_MS = 30_000;
export interface PiLike { registerTool(t: object): void; on(event: "tool_call" | "tool_result", h: (e: any, ctx?: any) => unknown): void }

export async function hougeTools(pi: PiLike): Promise<void> {
  const decls: Array<{ name: string; description: string; parameters: object }> = await getBridge().request({ kind: "manifest" });
  for (const d of decls) {
    pi.registerTool({
      name: d.name, label: d.name, description: d.description, parameters: d.parameters,
      async execute(toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal, onUpdate?: (u: unknown) => void) {
        const beat = setInterval(() => onUpdate?.({ content: [{ type: "text", text: "…still working" }] }), HEARTBEAT_MS);
        try {
          const r = await getBridge().request({ kind: "call", tool: d.name, input: params, toolCallId });
          return { content: [{ type: "text", text: String(r.content ?? "") }], details: undefined, ...(r.isError ? { isError: true } : {}) };
        } finally { clearInterval(beat); }
      }
    });
    registered.add(d.name); // only after registerTool returned: the policy trusts this set, not the manifest alone
  }
}

export default hougeTools;
