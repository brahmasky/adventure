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
import { effectiveAsk, trustAsk } from "../../src/decisions/trust-ask.js";
import { PLAIN_TEXT_ENTRIES } from "../../src/omp/bridge-handler.js";
import { UNTRUSTED_READ_ENTRIES } from "../../src/omp/external-read.js";
import { RunStore } from "../../src/run/run-store.js";
import { TurnTrust } from "../../src/decisions/trust.js";
import { telegramTurnEvent } from "../helpers/events.js";
import { EXEMPLAR_NAME } from "../../src/grow/seed.js";
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

describe("ADR 0035 G1: the orchestrator seeds only the exemplar", () => {
  it("grow-seed/skills holds exactly the exemplar, so every other grow-zone item is Houge's own", () => {
    const names = readdirSync(join(root, "grow-seed", "skills"), { withFileTypes: true }).filter((d) => !d.name.startsWith(".")).map((d) => d.name);
    expect(names).toEqual([EXEMPLAR_NAME]);
  });
});

describe("ADR 0035 G3: review is an enforced gate", () => {
  it("a staged item that needs review is not published until a passing review of its exact content exists", async () => {
    const s = await growSetup();
    expect((await s.svc.submit(growFields(), { run_id: "run_1", chat_id: "555", level: "clean" })).status).toBe("STAGED");
    const row = s.store.listGrowStaged("staged")[0]!;
    expect(await s.svc.publishStaged(row.id)).toBe("not_approved");
    expect(s.store.getGrowItem("unit-convert")?.state).not.toBe("live");
    // The review check itself, not the state check: a row that reads `approved` with no passing review is still refused.
    s.store.patchGrowStaged(row.id, { state: "approved" }, "2026-11-10T11:00:00.000Z");
    expect(await s.svc.publishStaged(row.id)).toBe("not_approved");
    expect(s.store.getGrowItem("unit-convert")?.state).not.toBe("live");
  });
});

describe("ADR 0035 G2: one door into the zone's repository", () => {
  it("has no caller of writeAndCommit / removeAndCommit outside src/grow/ops.ts", () => {
    const callers = walk("src").filter((p) => /\.(?:writeAndCommit|removeAndCommit)\(/.test(readFileSync(join(root, p), "utf8")));
    expect(callers.filter((p) => p !== join("src", "grow", "ops.ts"))).toEqual([]);
  });
  it("nothing in src writes the old skills folder", () => {
    const hits = walk("src").filter((f) => /join\([^)]*["']skills["']|\$\{[^}]*\}\/skills\b/.test(readFileSync(join(root, f), "utf8")) && !f.includes("/grow/"));
    expect(hits).toEqual([]);
  });
});

describe("ADR 0035 G5: undo reasons and reviews are append-only", () => {
  it("no source file deletes or updates a grow_undo_reasons or grow_reviews row, so Houge cannot unsay a reason or a verdict", () => {
    const hits = walk("src").filter((p) => /(DELETE\s+FROM|UPDATE|(?:INSERT\s+OR\s+)?REPLACE\s+INTO)\s+grow_(undo_reasons|reviews)\b/i.test(readFileSync(join(root, p), "utf8")));
    expect(hits).toEqual([]);
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
  it("grow_submit asks for no trust at any level, but asks after a Jev-rung send-back like every side effect (settleAsk, ADR 0034 2b-R7); grow_read never asks", () => {
    for (const level of ["clean", "untrusted"] as const) {
      expect(effectiveAsk(level, false, "grow_submit")).toEqual({ ask: false });
      expect(effectiveAsk(level, true, "grow_submit")).toMatchObject({ ask: true });
    }
    for (const settle of [false, true]) for (const level of ["clean", "untrusted", "hostile"] as const) expect(effectiveAsk(level, settle, "grow_read")).toEqual({ ask: false });
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
  const startsJob = /insertImprovementJob\(|startSkillJob\(|enqueueFromRecurrence\(|INSERT\s+(OR\s+\w+\s+)?INTO\s+improvement_jobs/i;
  it("the improve tick and the improvement taps start no skill job: a recurrence or a skill Accept records a grow hint", () => {
    for (const f of [join("src", "improve", "tick.ts"), join("src", "gateway", "improvement-commands.ts")]) {
      const text = readFileSync(join(root, f), "utf8");
      expect([f, startsJob.test(text)]).toEqual([f, false]);
      expect([f, text.includes("recordGrowHint(")]).toEqual([f, true]);
    }
  });
  it("no source file inserts an improvement job", () => {
    const hits = walk("src").filter((f) => startsJob.test(readFileSync(join(root, f), "utf8")));
    expect(hits).toEqual([]);
  });
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

describe("ADR 0035: index stable order", () => {
  it("renders live items in name order whatever the publish order, and a grow_read leaves the block byte-identical", async () => {
    const s = await growSetup();
    await s.live(growFields({ name: "zebra", description: "grooming striped horses before a show", example: "brush the zebra", body: growBody(40, " for zebras") }));
    await s.live(growFields({ name: "alpha", description: "ranking greek letters for a naming scheme", example: "rank alpha beta", body: growBody(40, " for letters") }));
    const block = s.svc.indexBlock() ?? "";
    expect(block.indexOf("- alpha")).toBeGreaterThan(-1);
    expect(block.indexOf("- alpha")).toBeLessThan(block.indexOf("- zebra"));
    // Only zebra is read, twice: an order by recency or by use count would now put it first.
    expect((await s.svc.read("zebra", { run_id: "run_1" })).ok).toBe(true);
    expect((await s.svc.read("zebra", { run_id: "run_2" })).ok).toBe(true);
    expect(s.svc.indexBlock()).toBe(block);
  });
});

describe("ADR 0035: skills leave the prompt", () => {
  it("no source file folds skill bodies into a prompt (the planner reads a skill through grow_read)", () => {
    const hits = walk("src").filter((f) => /readScopeBlock|skillsReader/.test(readFileSync(join(root, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
