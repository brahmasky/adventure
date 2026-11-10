/**
 * Rules: ADR 0035 (docs/decisions/0035-grow-zone-verification.md) G2 one door, G4 the trust rule, G5 the verifier is out of
 * Houge's reach.
 * Changing a rule changes its test in the same commit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTECTED_DIRS } from "../../src/capabilities/self-write-guard.js";
import { DISARM_FLAGS } from "../../src/config/disarm-posture.js";
import { compileTaskContract } from "../../src/contracts/task-contract.js";
import { CARRY_LEVEL, CAUSE_LEVEL } from "../../src/decisions/entries/turn-trust.js";
import { trustAsk } from "../../src/decisions/trust-ask.js";
import { PLAIN_TEXT_ENTRIES } from "../../src/omp/bridge-handler.js";
import { UNTRUSTED_READ_ENTRIES } from "../../src/omp/external-read.js";
import { RunStore } from "../../src/run/run-store.js";
import { TurnTrust } from "../../src/decisions/trust.js";
import { telegramTurnEvent } from "../helpers/events.js";
import { growBody, growFields, growSetup, small } from "../helpers/grow.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { ompWorker } from "../helpers/omp-worker.js";

const root = join(import.meta.dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = join(dir, d.name);
    return d.isDirectory() ? walk(rel) : /\.ts$/.test(d.name) ? [rel] : [];
  });

describe("ADR 0035 G5: the grow machinery is on the protected surface", () => {
  it("lists src/grow in PROTECTED_DIRS, so a self-write cannot edit the gate that checks self-written skills", () => {
    expect(PROTECTED_DIRS).toContain("src/grow");
  });
  it("puts HOUGE_GROW_ENABLED in DISARM_FLAGS, so /disarm can stop submissions", () => {
    expect(DISARM_FLAGS).toContain("HOUGE_GROW_ENABLED");
  });
});

describe("ADR 0035 G2: one door into the zone's repository", () => {
  it("has no caller of writeAndCommit / removeAndCommit outside src/grow/ops.ts", () => {
    const callers = walk("src").filter((p) => /\.(?:writeAndCommit|removeAndCommit)\(/.test(readFileSync(join(root, p), "utf8")));
    expect(callers.filter((p) => p !== join("src", "grow", "ops.ts"))).toEqual([]);
  });
});

describe("ADR 0035 G4: the trust rule", () => {
  it("grow_submit never asks at untrusted (no human gate: the skill is marked born untrusted instead)", () => {
    expect(trustAsk("untrusted", "grow_submit")).toEqual({ ask: false });
  });
  it("grow_read never asks at any level", () => {
    for (const level of ["clean", "untrusted", "hostile"] as const) expect(trustAsk(level, "grow_read")).toEqual({ ask: false });
  });
  it("reading a born-untrusted item is an untrusted cause that carries as untrusted", () => {
    expect(CAUSE_LEVEL.grow_read_untrusted).toBe("untrusted");
    expect(CARRY_LEVEL.grow_read_untrusted).toBe("untrusted");
  });
  it("the grow tools take the plain branch: never quarantined as outside reads, their answer reaches the planner as text", () => {
    for (const t of ["grow_submit", "grow_read"] as const) {
      expect(UNTRUSTED_READ_ENTRIES.has(t)).toBe(false);
      expect(PLAIN_TEXT_ENTRIES.has(t)).toBe(true);
    }
  });
  it("a schedule-born run may read the grow zone but not submit to it (G7 provenance strip)", () => {
    const r = compileTaskContract(telegramTurnEvent({ source: "schedule" }));
    if (!r.ok) throw new Error("compile failed");
    expect(r.contract.allowed_actions).toContain("grow_read");
    expect(r.contract.allowed_actions).not.toContain("grow_submit");
  });
});

describe("ADR 0035 / ADR 0034 §10.4: recurrence gives a hint, never a job", () => {
  const startsJob = /insertImprovementJob\(|startSkillJob\(|enqueueFromRecurrence\(/;
  it("the improve tick and the improvement taps start no skill job: a recurrence or a skill Accept records a grow hint", () => {
    for (const f of [join("src", "improve", "tick.ts"), join("src", "gateway", "improvement-commands.ts")]) {
      const text = readFileSync(join(root, f), "utf8");
      expect([f, startsJob.test(text)]).toEqual([f, false]);
      expect([f, text.includes("recordGrowHint(")]).toEqual([f, true]);
    }
  });
  // switched on when src/core/skill-job.ts is deleted (Task 13): walk("src").filter((f) => startsJob.test(readFileSync(join(root, f), "utf8")) && !f.endsWith("run-store.ts")) is []
  it.todo("no source file inserts an improvement job");
});

describe("ADR 0035 G4 clause a: a hostile turn's grow_submit is refused in the preflight", () => {
  pinOmpEnv();
  const claimed = () => {
    const store = RunStore.openInMemory(); const run_id = createQueuedTurnRun(store);
    const tmp = shortTmp("adr35-");
    const claim = store.claimRun(run_id, `planner:test:${run_id}`, 120);
    if (!claim) throw new Error("claim failed");
    const tools = ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }).buildOmpTools(claim);
    return { store, run_id, tools, done: () => { store.close(); tmp.cleanup(); } };
  };
  const args = { name: "web-notes", description: "taking structured notes on a web page", example: "summarise this page", body: "1. Read the page." };
  it("refuses turn_hostile with a bound getter answering hostile", () => {
    const x = claimed();
    try {
      x.tools.bindTrust(() => "hostile");
      expect(x.tools.preflight("grow_submit", args)).toMatchObject({ refused: { reason: "turn_hostile" } });
    } finally { x.done(); }
  });
  it("refuses turn_hostile with no getter bound when the ledger carries carried_hostile", () => {
    const x = claimed();
    try {
      expect(x.tools.preflight("grow_submit", args)).toBeNull();
      new TurnTrust({ store: x.store, run_id: x.run_id, chat_id: "555", born: "telegram", env: process.env }).carry("hostile");
      expect(x.store.getLedgerEvents(x.run_id).some((e) => (e.payload as { cause?: string } | null)?.cause === "carried_hostile")).toBe(true);
      expect(x.tools.preflight("grow_submit", args)).toMatchObject({ refused: { reason: "turn_hostile" } });
    } finally { x.done(); }
  });
});

describe("ADR 0035 G6: review by size and provenance", () => {
  const ctx = { run_id: "run_1", chat_id: "555", level: "clean" } as const;
  it("a new skill is staged, never live on submit", async () => {
    const s = await growSetup();
    expect((await s.svc.submit(growFields(), ctx)).status).toBe("STAGED");
    expect(s.store.getGrowItem("unit-convert")?.state).not.toBe("live");
  });
  it("a small edit of a live clean skill is live at once", async () => {
    const s = await growSetup(); await s.live(growFields());
    expect((await s.svc.submit(small(growFields()), ctx)).status).toBe("LIVE");
  });
  it("an edit over the size limit is staged", async () => {
    const s = await growSetup(); await s.live(growFields());
    expect((await s.svc.submit(growFields({ body: growBody(40, " (rewritten)") }), ctx)).status).toBe("STAGED");
  });
  it("any edit of a marked (untrusted) skill is staged, however small", async () => {
    const s = await growSetup(); await s.live(growFields(), { ...ctx, level: "untrusted" });
    expect(s.store.isGrowMarked("unit-convert")).toBe(true);
    expect((await s.svc.submit(small(growFields()), ctx)).status).toBe("STAGED");
  });
});
