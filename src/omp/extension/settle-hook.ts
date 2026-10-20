// Runs inside the omp planner process. Protected (self-write guard). Imports nothing from Houge but its siblings.
import { getBridge, HOOK_TIMEOUT_MS } from "./bridge-client.js";

type Block = { type: string; text?: string };
export interface SessionStopEvent { stop_hook_active: boolean; signal: AbortSignal; last_assistant_message?: { content?: Block[] } }
const CAP = 32 * 1024;

/** 2b-i §2.3: settle on every fire; only `{ sendBack: true, note }` continues the session. Everything else fails open. */
export async function sessionStopHook(e: SessionStopEvent, o: { timeoutMs: number } = { timeoutMs: HOOK_TIMEOUT_MS }): Promise<{ continue: true; additionalContext: string } | undefined> {
  if (e.signal?.aborted) return undefined;
  try {
    const text = (e.last_assistant_message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").slice(0, CAP);
    const r = await getBridge().request({ kind: "settle", stop_hook_active: e.stop_hook_active === true, text }, { timeoutMs: o.timeoutMs });
    if (e.signal?.aborted) return undefined; // P2': omp aborted the settle pass; a continuation now would be ignored or harmful
    return r?.sendBack === true && typeof r.note === "string" ? { continue: true, additionalContext: r.note } : undefined;
  } catch {
    return undefined;
  }
}
