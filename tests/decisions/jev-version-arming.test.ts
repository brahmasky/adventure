import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSelfWriteDiff, parseDiffRaw } from "../../src/capabilities/self-write-guard.js";
import { NOT_ARMED, treeArmed, treeArmingFor, type JevDriftDetail } from "../../src/decisions/jev-version-check.js";
import { CALIBRATED_ROWS } from "../../src/jev/calibration.js";
import type { Lang } from "../../src/jev/intent-question.js";
import { JEV_REQUEST_MODEL } from "../../src/jev/jev-client.js";
import { TREE_QUESTIONS } from "../../src/jev/questions/tree.js";
import * as treePolicy from "../../src/jev/tree-policy.js";
import type { Armed } from "../../src/jev/tree-policy.js";
import { RunStore, type JevModelState } from "../../src/run/run-store.js";

// Jev version check Task 3 (spec §2.3, §2.5 d): the triage tree arms on a call only when the model Jev REPORTED for that
// call has a check state that allows it. A wrong arm lets an unchecked model's answers route Paco's turns into a no-planner
// lane, so every state but trusted / accepted (and a drift's untouched questions) must leave the tree unarmed.
const NEW = "jev-test-new";
const ALL: Armed = { category: true, status: true, memory: true, gear: true, rule: true, answer: true, lookup: true };
const NONE: Armed = { category: false, status: false, memory: false, gear: false, rule: false, answer: false, lookup: false };
const NO_OFF = new Set<never>();

function storeWith(model: string, state: JevModelState, detail: JevDriftDetail | string = "{}"): RunStore {
  const store = RunStore.openInMemory();
  store.noteJevModel(model, "2026-10-22T00:00:00Z");
  if (state !== "checking") store.setJevModelState(model, "checking", state, typeof detail === "string" ? detail : JSON.stringify(detail), "2026-10-22T00:01:00Z");
  return store;
}
const armedFor = (store: RunStore, model: string, lang: Lang = "zh"): Armed =>
  treeArmed(lang, CALIBRATED_ROWS, NO_OFF, treeArmingFor(store, { model }, lang));
const drift = (o: Partial<JevDriftDetail>): JevDriftDetail => ({ failed_questions: [], route_failed: false, lanes_disarmed: [], ...o });

afterEach(() => { vi.restoreAllMocks(); });

describe("treeArmingFor: the reported model's check state arms the tree", () => {
  it("a model with no jev_models row (unchecked) arms nothing", () => {
    expect(armedFor(RunStore.openInMemory(), NEW)).toEqual(NONE);
  });
  it.each(["trusted", "accepted"] as const)("%s arms every tree decision", (state) => {
    expect(armedFor(storeWith(NEW, state), NEW)).toEqual(ALL);
  });
  it.each(["checking", "deferred", "insufficient"] as const)("%s arms nothing", (state) => {
    expect(armedFor(storeWith(NEW, state), NEW)).toEqual(NONE);
  });
  // Only the reported id counts: another model's trusted row never arms this call.
  it("a trusted row for another model does not arm this one", () => {
    expect(armedFor(storeWith("jev-other", "trusted"), NEW)).toEqual(NONE);
  });
  // A row naming the moving alias would keep arming after TypeSafe moves it: exactly the silent change the check must catch.
  it("the request alias arms nothing, even when a row names it trusted", () => {
    expect(armedFor(storeWith(JEV_REQUEST_MODEL, "trusted"), JEV_REQUEST_MODEL)).toEqual(NONE);
    expect(armedFor(storeWith("", "trusted"), "")).toEqual(NONE);
  });
  // en (30 anchor turns) and mixed inherit zh's verdict (spec §2.3, §7): the state is the model's, one for every language.
  it("mixed and en follow zh's state", () => {
    for (const state of ["trusted", "checking"] as const) {
      const s = storeWith(NEW, state);
      expect(armedFor(s, NEW, "mixed")).toEqual(armedFor(s, NEW, "zh"));
      expect(armedFor(s, NEW, "en")).toEqual(armedFor(s, NEW, "zh"));
    }
    const d = storeWith(NEW, "drifted", drift({ failed_questions: ["breadth"] }));
    expect(armedFor(d, NEW, "en")).toEqual(armedFor(d, NEW, "zh"));
    expect(armedFor(d, NEW, "mixed")).toEqual(armedFor(d, NEW, "zh"));
  });
});

describe("treeArmingFor: a drifted model arms only what did not drift, with dependencies (spec §2.3)", () => {
  it("category failing disarms category, memory, status, answer, lookup; rule and gear stay", () => {
    expect(armedFor(storeWith(NEW, "drifted", drift({ failed_questions: ["category"] })), NEW))
      .toEqual({ ...NONE, rule: true, gear: true });
  });
  it.each(["sets_rule", "rule_scope"])("%s failing disarms rule, status, answer, lookup; category, memory and gear stay", (q) => {
    expect(armedFor(storeWith(NEW, "drifted", drift({ failed_questions: [q] })), NEW))
      .toEqual({ ...NONE, category: true, memory: true, gear: true });
  });
  it.each(["breadth", "reasoning", "actions"])("%s failing disarms gear, answer, lookup; category, memory, rule, status stay", (q) => {
    expect(armedFor(storeWith(NEW, "drifted", drift({ failed_questions: [q] })), NEW))
      .toEqual({ ...NONE, category: true, memory: true, rule: true, status: true });
  });
  // §2.5 d: a route drift cannot be tied to one question's dependents, so it disarms the whole tree.
  it("route_failed disarms the whole tree, whatever else passed", () => {
    expect(armedFor(storeWith(NEW, "drifted", drift({ route_failed: true })), NEW)).toEqual(NONE);
  });
  // §2.5 c: a lane whose wrong routes grew disarms that lane only.
  it("lanes_disarmed disarms the named lanes only", () => {
    expect(armedFor(storeWith(NEW, "drifted", drift({ lanes_disarmed: ["memory", "lookup"] })), NEW))
      .toEqual({ ...ALL, memory: false, lookup: false });
  });
  it("an unreadable drift detail fails closed: nothing armed, one line naming no detail text", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(armedFor(storeWith("jev-bad-a", "drifted", "not json"), "jev-bad-a")).toEqual(NONE);
    expect(armedFor(storeWith("jev-bad-b", "drifted", JSON.stringify({ failed_questions: "category" })), "jev-bad-b")).toEqual(NONE);
    expect(err).toHaveBeenCalledTimes(2);
    expect(String(err.mock.calls[0]![0])).not.toContain("not json");
  });
  // Every turn reads the arming: an unreadable row would otherwise write one stderr line per turn until a new check.
  it("the unreadable-detail line is written once per model, not once per turn", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = storeWith("jev-bad-memo", "drifted", "not json");
    for (let i = 0; i < 5; i += 1) expect(armedFor(store, "jev-bad-memo")).toEqual(NONE);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain("jev-bad-memo");
  });
});

describe("treeArmingFor: a store error", () => {
  it("leaves the tree unarmed and logs the error code, never the message", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = Object.assign(new Error("database is locked at /secret/path"), { code: "SQLITE_BUSY" });
    const store = { getJevModel: () => { throw boom; } };
    expect(treeArmingFor(store, { model: NEW }, "zh")).toEqual(NOT_ARMED);
    expect(treeArmed("zh", CALIBRATED_ROWS, NO_OFF, treeArmingFor(store, { model: NEW }, "zh"))).toEqual(NONE);
    const line = String(err.mock.calls[0]![0]);
    expect(line).toContain("SQLITE_BUSY");
    expect(line).not.toContain("/secret/path");
  });
});

describe("treeArmed: the status lane also needs category (named behaviour change, spec §2.3 / §7)", () => {
  it("rows for everything but category: status is unarmed with category", () => {
    const rows = CALIBRATED_ROWS.filter((r) => r.question_id !== "category");
    expect(treeArmed("zh", rows, NO_OFF, treeArmingFor(storeWith(NEW, "trusted"), { model: NEW }, "zh"))).toMatchObject({ category: false, status: false });
  });
  it("a trusted model with every row arms status", () => {
    expect(armedFor(storeWith(NEW, "trusted"), NEW).status).toBe(true);
  });
});

// Residual named in spec §2.3: the caller is not protected and could skip the gate. The turn path must read it.
describe("the live turn path reads the gate", () => {
  it("core-worker's planAnswered computes treeArmingFor and planTree passes it to the protected treeArmed", () => {
    const src = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "src", f), "utf8");
    expect(src("core/core-worker.ts")).toMatch(/treeArmingFor\(this\.runStore, d, lang\)/);
    expect(src("core/turn-handler-ladder.ts")).toMatch(/treeArmed\(i\.lang, i\.rows, i\.lanesOff, i\.arming\)/);
    expect(src("core/turn-handler-ladder.ts")).toMatch(/import \{[^}]*\btreeArmed\b[^}]*\} from "\.\.\/decisions\/jev-version-check\.js"/);
  });
  it("every tree question is covered by the arming set", () => {
    const trusted = treeArmingFor(storeWith(NEW, "trusted"), { model: NEW }, "zh");
    for (const q of TREE_QUESTIONS) expect(trusted.questions.has(q.id)).toBe(true);
  });
});

// Spec §2.7 as Paco decided it (2026-10-22, the middle path): the arming (check state, calibration rows, lane dependencies)
// is computed only in the protected module, so a self-write that arms an unchecked model must be refused; the routing
// policy in tree-policy.ts only consumes the result and stays self-writable.
describe("self-write guard — the arming read", () => {
  it("hard-denies a self-write touching the arming module or calibration.ts", () => {
    for (const f of ["src/decisions/jev-version-check.ts", "src/jev/calibration.ts"]) {
      expect(checkSelfWriteDiff(parseDiffRaw(`:100644 100644 7898192 422c2b7 M\t${f}`)).allowed).toBe(false);
    }
  });
  it("every write of a model's check state or of the anchor lives under the protected src/decisions/ (final fix F1)", () => {
    const root = join(import.meta.dirname, "..", "..", "src");
    const writers = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && f !== join("run", "run-store.ts"))
      .filter((f) => /\.(importAnchor|setJevModelState|replaceAnchorAnswer|setJevModelProgress|noteJevModel|bumpJevModelGeneration)\(/.test(readFileSync(join(root, f), "utf8")));
    expect(writers.length).toBeGreaterThan(0);
    for (const f of writers) expect(f.startsWith(`decisions${sep}`), f).toBe(true);
    expect(checkSelfWriteDiff(parseDiffRaw(":100644 100644 7898192 422c2b7 M\tsrc/decisions/jev-anchor-import.ts")).allowed).toBe(false);
  });
  it("allows a self-write to the routing policy, tree-policy.ts", () => {
    expect(checkSelfWriteDiff(parseDiffRaw(":100644 100644 7898192 422c2b7 M\tsrc/jev/tree-policy.ts")).allowed).toBe(true);
  });
  it("tree-policy.ts computes no arming: no treeArmed, no calibration rows, no check state", () => {
    expect("treeArmed" in treePolicy).toBe(false);
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "jev", "tree-policy.ts"), "utf8");
    expect(src).not.toMatch(/calibration\.js|calibratedLang|jev-version-check\.js|ModelArming|_ARM_ID/);
  });
});
