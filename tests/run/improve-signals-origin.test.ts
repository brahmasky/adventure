import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-07 §3.1: the inbox row names its producer. Only memlane_fix rows may ever auto-apply, so the column is
// additive (old rows null), CHECK-bound (a stray word cannot pass as Paco's words) and comes back after a rebuild.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const cols = (s: RunStore) => (db(s).prepare("PRAGMA table_info(improve_signals)").all() as Array<{ name: string }>).map((c) => c.name);
const row = (origin: "memlane_fix" | "dig_deeper" | "escalation" | "rating" | null | undefined) => ({ signal: "correction" as const, value: "answer", run_id: "run_b", chat_id: "555", about_run_id: "run_a", ...(origin === undefined ? {} : { origin }) });

describe("improve_signals.origin", () => {
  it("is stored and read back; an omitted origin is null (mirrored outcomes, old producers)", () => {
    const s = RunStore.openInMemory();
    expect(s.insertImproveSignal(row("memlane_fix"))).toBeGreaterThan(0);
    expect(s.insertImproveSignal({ ...row(undefined), run_id: "run_c" })).toBeGreaterThan(0);
    expect(s.listUnconsumedSignals(5).map((r) => r.origin)).toEqual(["memlane_fix", null]);
  });
  it("refuses a word outside the four origins before the insert (INSERT OR IGNORE would otherwise drop it silently); the CHECK is the backstop", () => {
    const s = RunStore.openInMemory();
    expect(() => s.insertImproveSignal({ ...row(undefined), origin: "paco_said_so" as "rating" })).toThrow("invalid_origin");
    expect(s.listUnconsumedSignals(5)).toEqual([]);
    expect(() => db(s).prepare("INSERT INTO improve_signals (signal, value, run_id, chat_id, about_run_id, created_at, origin) VALUES ('correction', 'answer', 'run_b', '555', 'run_a', '2026-10-01T00:00:00.000Z', 'paco_said_so')").run()).toThrow(/CHECK/);
  });
  it("the migration adds the column to a table an older build created and keeps the old rows null", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-origin-")); dirs.push(dir);
    const path = join(dir, "houge.sqlite");
    const first = RunStore.open(path);
    expect(cols(first)).toContain("origin");
    db(first).exec("ALTER TABLE improve_signals DROP COLUMN origin"); // the table as the 2026-10-21 build left it
    db(first).prepare("INSERT INTO improve_signals (signal, value, run_id, chat_id, about_run_id, created_at) VALUES ('correction', 'answer', 'run_b', '555', 'run_a', '2026-10-01T00:00:00.000Z')").run();
    first.close();
    const second = RunStore.open(path);
    try {
      expect(cols(second)).toContain("origin");
      expect(second.listUnconsumedSignals(5).map((r) => r.origin)).toEqual([null]);
    } finally { second.close(); }
  });
});
