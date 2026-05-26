import { createHash } from "node:crypto";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(input).sort()) {
      const child = input[key];
      if (child !== undefined) output[key] = normalize(child);
    }
    return output;
  }
  throw new Error(`Unsupported value in canonical JSON: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
