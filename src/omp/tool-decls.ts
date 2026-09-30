import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_MAP } from "./capability-map.js";

export type JsonSchema = {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[];
  additionalProperties?: boolean; maxLength?: number; items?: JsonSchema; minimum?: number; maximum?: number; description?: string;
};
export interface ToolDeclaration {
  name: string; description: string; parameters: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export const TOOL_DECLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "tools");
const DECL_KEYS = new Set(["name", "description", "parameters", "annotations"]);
const SCHEMA_KEYS = new Set(["type", "properties", "required", "enum", "additionalProperties", "maxLength", "items", "minimum", "maximum", "description"]);

function schemaProblem(s: unknown, at: string): string | null {
  if (typeof s !== "object" || s === null) return `${at}: not an object`;
  for (const k of Object.keys(s)) if (!SCHEMA_KEYS.has(k)) return `${at}: unsupported keyword ${k}`;
  const o = s as JsonSchema;
  for (const [k, v] of Object.entries(o.properties ?? {})) { const p = schemaProblem(v, `${at}.${k}`); if (p) return p; }
  return o.items ? schemaProblem(o.items, `${at}[]`) : null;
}

function checkDecl(raw: unknown, file: string): ToolDeclaration | string {
  if (typeof raw !== "object" || raw === null) return `${file}: not an object`;
  for (const k of Object.keys(raw)) if (!DECL_KEYS.has(k)) return `${file}: unknown key ${k}`;
  const d = raw as ToolDeclaration;
  if (typeof d.name !== "string" || !CAPABILITY_MAP.has(d.name)) return `${file}: no capability mapping for ${String(d.name)}`;
  if (typeof d.description !== "string" || d.description.length === 0) return `${file}: description required`;
  return schemaProblem(d.parameters, `${file}.parameters`) ?? d;
}

export function loadToolDeclarations(dir: string): { ok: true; decls: ToolDeclaration[] } | { ok: false; error: string } {
  const decls: ToolDeclaration[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch (e) { return { ok: false, error: `${f}: ${(e as Error).message}` }; }
    const d = checkDecl(raw, f);
    if (typeof d === "string") return { ok: false, error: d };
    if (decls.some((x) => x.name === d.name)) return { ok: false, error: `${f}: duplicate ${d.name}` };
    decls.push(d);
  }
  return { ok: true, decls };
}

export function validateInput(s: JsonSchema, v: unknown, at = "input"): string[] {
  const errs: string[] = [];
  const typeOk = s.type === "integer" ? Number.isInteger(v) : s.type === "array" ? Array.isArray(v)
    : s.type === "object" ? typeof v === "object" && v !== null && !Array.isArray(v) : typeof v === s.type;
  if (!typeOk) return [`${at}: expected ${s.type}`];
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: not one of ${JSON.stringify(s.enum)}`);
  if (typeof v === "string" && s.maxLength !== undefined && v.length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
  if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) errs.push(`${at}: below ${s.minimum}`);
  if (typeof v === "number" && s.maximum !== undefined && v > s.maximum) errs.push(`${at}: above ${s.maximum}`);
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...validateInput(s.items as JsonSchema, x, `${at}[${i}]`)));
  if (s.type === "object") errs.push(...objectErrors(s, v as Record<string, unknown>, at));
  return errs;
}

function objectErrors(s: JsonSchema, o: Record<string, unknown>, at: string): string[] {
  const errs: string[] = [];
  for (const r of s.required ?? []) if (!(r in o)) errs.push(`${at}.${r}: required`);
  for (const [k, v] of Object.entries(o)) {
    const p = s.properties?.[k];
    if (p) errs.push(...validateInput(p, v, `${at}.${k}`));
    else if (s.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
  }
  return errs;
}
