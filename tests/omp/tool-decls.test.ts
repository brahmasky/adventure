import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadToolDeclarations, TOOL_DECLS_DIR, validateInput } from "../../src/omp/tool-decls.js";
import { isToolArmed } from "../../src/omp/tool-arming.js";

describe("tool declarations — data the daemon validates; nothing self-writable runs in the planner (spec §5.1)", () => {
  it("loads all 15 shipped declarations", () => {
    const r = loadToolDeclarations(TOOL_DECLS_DIR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decls.map((d) => d.name).sort()).toEqual([
      "bash", "gmail_read", "google_api", "houge_status", "http_fetch", "lesson_write", "memory_correct", "schedule_task", "self_diagnose",
      "self_write_propose", "skill_author", "to_local_time", "web_search", "wiki_build", "wiki_refine"
    ]);
  });

  const withDecl = (decl: object) => {
    const d = mkdtempSync(join(tmpdir(), "houge-decls-"));
    writeFileSync(join(d, "x.json"), JSON.stringify(decl));
    return loadToolDeclarations(d);
  };

  it("rejects a declaration that tries to choose its own policy class — the map is code-owned (final Codex pass)", () => {
    expect(withDecl({ name: "bash", description: "d", parameters: { type: "object" }, capability: "shell" }).ok).toBe(false);
  });

  it("rejects a declaration whose name has no code-owned capability mapping", () => {
    expect(withDecl({ name: "format_disk", description: "d", parameters: { type: "object" } }).ok).toBe(false);
  });

  it("rejects unsupported schema keywords instead of silently not validating them", () => {
    expect(withDecl({ name: "bash", description: "d", parameters: { type: "object", pattern: ".*" } }).ok).toBe(false);
  });

  it("validates required, additionalProperties, enum, maxLength, integer bounds", () => {
    const s = { type: "object" as const, properties: { q: { type: "string" as const, maxLength: 3 }, n: { type: "integer" as const, minimum: 1, maximum: 2 }, m: { type: "string" as const, enum: ["GET"] } }, required: ["q"], additionalProperties: false };
    expect(validateInput(s, { q: "ab" })).toEqual([]);
    expect(validateInput(s, {})).not.toEqual([]);
    expect(validateInput(s, { q: "abcd" })).not.toEqual([]);
    expect(validateInput(s, { q: "a", x: 1 })).not.toEqual([]);
    expect(validateInput(s, { q: "a", n: 3 })).not.toEqual([]);
    expect(validateInput(s, { q: "a", n: 1.5 })).not.toEqual([]);
    expect(validateInput(s, { q: "a", m: "POST" })).not.toEqual([]);
  });

  it("disarmed tools never reach the model's tool list", () => {
    expect(isToolArmed("schedule_task", {})).toBe(false);
    expect(isToolArmed("schedule_task", { HOUGE_SCHEDULER_ENABLED: "1" })).toBe(true);
    expect(isToolArmed("bash", {})).toBe(true);
  });

  it("houge_status is armed with no flag and takes no parameters (Houge must always be able to see its own runtime)", () => {
    expect(isToolArmed("houge_status", {})).toBe(true);
    const r = loadToolDeclarations(TOOL_DECLS_DIR);
    if (!r.ok) throw new Error(r.error);
    const decl = r.decls.find((d) => d.name === "houge_status")!;
    expect(decl.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(validateInput(decl.parameters, {})).toEqual([]);
    expect(validateInput(decl.parameters, { verbose: true })).not.toEqual([]);
  });

  it("memory_correct is armed with no flag; its schema bounds every field and its text says search first, only on Paco's ask", () => {
    expect(isToolArmed("memory_correct", {})).toBe(true);
    const r = loadToolDeclarations(TOOL_DECLS_DIR);
    if (!r.ok) throw new Error(r.error);
    const decl = r.decls.find((d) => d.name === "memory_correct")!;
    expect(decl.description).toContain("ONLY when Paco asks");
    expect(decl.description).toContain("search");
    expect(decl.description).toContain("Prefer \"correct\"");
    expect(validateInput(decl.parameters, { action: "search", query: "ASML" })).toEqual([]);
    expect(validateInput(decl.parameters, { action: "delete" })).not.toEqual([]);
    expect(validateInput(decl.parameters, { action: "search", query: "x".repeat(201) })).not.toEqual([]);
    expect(validateInput(decl.parameters, { action: "correct", ids: [1], correction: "x".repeat(501) })).not.toEqual([]);
    expect(validateInput(decl.parameters, { action: "retire", ids: [1.5] })).not.toEqual([]);
  });

  it("self_write_propose asks for a VERIFIED cause before the call and leaves room for it (run_79faefea)", () => {
    // Live: a guessed diagnosis sent the writer after the wrong cause for 11 min (empty diff).
    const r = loadToolDeclarations(TOOL_DECLS_DIR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const decl = r.decls.find((d) => d.name === "self_write_propose")!;
    expect(decl.description).toMatch(/confirm the root cause in the code/i);
    expect(decl.description).toMatch(/read and bash/);
    expect(decl.description).not.toMatch(/do NOT need self_diagnose/i);
    expect(decl.description).toMatch(/ENDS this turn/);
    expect(decl.parameters.properties!.focus!.maxLength).toBe(2000);
    expect(validateInput(decl.parameters, { focus: "z".repeat(2000) })).toEqual([]);
    expect(validateInput(decl.parameters, { focus: "z".repeat(2001) }).length).toBeGreaterThan(0);
  });
});

