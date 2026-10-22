import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { acceptJevModelCli, formatJevModels, requestJevCheck } from "../../src/decisions/jev-version-controls.js";
import { RunStore } from "../../src/run/run-store.js";

// Jev version check spec §2.6: Paco's CLI controls. Requests always name the alias, so a check can only test the model
// the alias serves now: asking to check another one must refuse with a message, never queue a check that cannot run.
const NOW = "2026-10-22T05:00:00.000Z";

function withAttempts(models: string[]): RunStore {
  const path = join(mkdtempSync(join(tmpdir(), "hjvc-")), "h.sqlite");
  RunStore.open(path).close();
  const db = new DatabaseSync(path);
  models.forEach((model, k) => db.prepare(`INSERT INTO ledger_events (event_id, run_id, correlation_id, event_type, occurred_at, actor, sequence, payload_json)
    VALUES (?, NULL, 'c', 'llm_attempt', ?, 'capability_runner', 1, ?)`).run(`e${k}`, NOW, JSON.stringify({ provider: "jev", model, outcome: "ok" })));
  db.close();
  return RunStore.open(path);
}

describe("houge jev check [model]", () => {
  it("refuses a model the alias does not serve now, naming the one it does", () => {
    const s = withAttempts(["jev-a", "jev-b"]);
    s.noteJevModel("jev-a", NOW);
    const r = requestJevCheck(s, "jev-a", NOW);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("jev-b");
    expect(r.message).toContain(`as of ${NOW}`); // the served model is the newest ledger row: say how old
    expect(s.getJevModel("jev-a")?.state).toBe("checking"); // untouched
    s.close();
  });

  it("with no model: queues the served model; a terminal state moves back to checking with its detail cleared", () => {
    const s = withAttempts(["jev-b"]);
    s.noteJevModel("jev-b", NOW);
    s.setJevModelState("jev-b", "checking", "drifted", JSON.stringify({ failed_questions: ["category"], route_failed: false, lanes_disarmed: [] }), NOW);
    const r = requestJevCheck(s, undefined, NOW);
    expect(r).toMatchObject({ ok: true });
    expect(s.getJevModel("jev-b")).toMatchObject({ state: "checking", detail_json: "{}" });
    s.close();
  });

  it("refuses when no Jev answer was ever recorded", () => {
    const s = withAttempts([]);
    expect(requestJevCheck(s, undefined, NOW).ok).toBe(false);
    s.close();
  });
});

describe("houge jev accept <model> and houge jev models", () => {
  it("accepts a drifted model and lists every model with its state", () => {
    const s = withAttempts([]);
    s.noteJevModel("jev-b", NOW);
    s.setJevModelState("jev-b", "checking", "drifted", JSON.stringify({ failed_questions: [], route_failed: true, lanes_disarmed: [], margins: { route: { a: null, b: -0.1 } } }), NOW);
    expect(formatJevModels(s)).toMatch(/jev-b\s+drifted/);
    expect(formatJevModels(s)).toMatch(/n\/a/); // a null margin renders as n/a
    expect(acceptJevModelCli(s, "jev-b", NOW).ok).toBe(true);
    expect(s.getJevModel("jev-b")?.state).toBe("accepted");
    expect(acceptJevModelCli(s, "jev-unknown", NOW).ok).toBe(false);
    s.close();
  });
});
