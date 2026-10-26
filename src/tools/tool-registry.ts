import type { DecisionRecorder } from "../decisions/types.js";
import type { RiskLevel, SideEffectLevel } from "../domain/types.js";

export type ToolAdapterResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; error: string };

export interface SsrfContext {
  run_id: string | null;
  tool_call_id?: string | null;
  recorder?: DecisionRecorder;
}

export interface ToolMetadata {
  name: string;
  category: "tool" | "coding_agent_cli";
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  timeout_ms: number;
  output_limit_bytes: number;
  execute?: (input: Record<string, unknown>, signal?: AbortSignal, ssrfCtx?: SsrfContext) => Promise<ToolAdapterResult> | ToolAdapterResult;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolMetadata>();

  register(metadata: ToolMetadata): void {
    if (this.tools.has(metadata.name)) {
      throw new Error(`Tool already registered: ${metadata.name}`);
    }

    this.tools.set(metadata.name, metadata);
  }

  get(name: string): ToolMetadata | undefined {
    return this.tools.get(name);
  }
}
