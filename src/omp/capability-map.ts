import { classifyCommand } from "./command-matcher.js";

export type RegistryEntry =
  | "shell" | "shell_external" | "shell_destructive" | "fs_read" | "fs_write"
  | "web_search" | "http_fetch" | "to_local_time" | "lesson_write" | "schedule_task" | "wiki_build" | "wiki_refine"
  | "self_diagnose" | "self_write_propose" | "skill_author" | "gmail_read" | "google_api" | "houge_status" | "memory_correct";

const same = (e: RegistryEntry) => () => e;
const ONE_TO_ONE: RegistryEntry[] = ["web_search", "http_fetch", "to_local_time", "lesson_write", "schedule_task",
  "wiki_build", "wiki_refine", "self_diagnose", "self_write_propose", "skill_author", "gmail_read", "google_api", "houge_status", "memory_correct"];

export const CAPABILITY_MAP: ReadonlyMap<string, (input: Record<string, unknown>) => RegistryEntry> = new Map([
  ["bash", (input: Record<string, unknown>): RegistryEntry => {
    const c = classifyCommand(typeof input.command === "string" ? input.command : "");
    return c.kind === "destructive" ? "shell_destructive" : c.kind === "external_write" ? "shell_external" : "shell";
  }],
  ...ONE_TO_ONE.map((e): [string, () => RegistryEntry] => [e, same(e)])
]);

export function capabilityFor(tool: string, input: Record<string, unknown>): RegistryEntry | null {
  return CAPABILITY_MAP.get(tool)?.(input) ?? null;
}

export const BUILTIN_CAPABILITY = Object.freeze({ read: "fs_read", edit: "fs_write", write: "fs_write" } as const);
