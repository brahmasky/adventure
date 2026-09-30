/** `provider/model[:effort]` — the single syntax for every omp seat chain (spec §8). */
export type OmpEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelString { provider: string; model: string; effort?: OmpEffort }
export type ModelFamily = "claude" | "gemini" | "gpt" | "kimi" | "other";

const EFFORTS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseModelString(raw: string): ModelString {
  const s = raw.trim();
  const [path, effort, extra] = s.split(":");
  if (extra !== undefined) throw new Error(`model string has more than one ':' — ${s}`);
  const parts = (path ?? "").split("/");
  if (parts.length !== 2 || !SEGMENT.test(parts[0] ?? "") || !SEGMENT.test(parts[1] ?? "")) {
    throw new Error(`model string must be provider/model[:effort] — got ${JSON.stringify(s)}`);
  }
  if (effort !== undefined && !EFFORTS.has(effort)) {
    throw new Error(`unknown effort ${JSON.stringify(effort)} in ${s}`);
  }
  const out: ModelString = { provider: parts[0] as string, model: parts[1] as string };
  if (effort !== undefined) out.effort = effort as OmpEffort;
  return out;
}

export function parseModelChain(csv: string): ModelString[] {
  const items = csv.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  if (items.length === 0) throw new Error("model chain is empty");
  return items.map(parseModelString);
}

export function formatModelString(m: ModelString): string {
  return `${m.provider}/${m.model}${m.effort ? `:${m.effort}` : ""}`;
}

export function familyOf(m: Pick<ModelString, "model">): ModelFamily {
  const id = m.model.toLowerCase();
  if (id.startsWith("claude")) return "claude";
  if (id.startsWith("gemini")) return "gemini";
  if (id.startsWith("gpt")) return "gpt";
  if (id.startsWith("kimi") || /^k\d/.test(id)) return "kimi";
  return "other";
}
