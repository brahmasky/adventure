import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANCHOR_COMMAND, anchorCountsLines, bootJevAnchor, importJevAnchor } from "../../src/decisions/jev-anchor-import.js";
import { stateHash } from "../../src/jev/decide.js";
import { JEV_REQUEST_MODEL } from "../../src/jev/jev-client.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_LABEL_SINCE, treeContextFor, treeQuestions } from "../../src/jev/triage-replay.js";
import { RunStore } from "../../src/run/run-store.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Anchor import (jev version check §2.2). Each test would still pass if the rule it guards were dropped only where noted
// otherwise, so every case asserts the stored outcome (rows, model state, incidents), never just "did not throw".
const MODEL = "jev-x.1";
afterEach(() => vi.useRealTimers());

/** A Telegram run with its user + assistant turns, born after the label epoch; the text is the only thing a test varies. */
function seedTurn(store: RunStore, text: string, minute: number): string {
  vi.setSystemTime(new Date(Date.parse(TREE_LABEL_SINCE) + 40 * 86_400_000 + minute * 60_000));
  const run = createQueuedTurnRun(store, text);
  const done = new Date(Date.now() + 20_000).toISOString();
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text, created_at: done });
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "assistant", text: "好的", intent: "answer", created_at: done });
  return store.userTurnIdForRun(run)!;
}
function world(zh: number, en = 2): { store: RunStore; turns: Array<{ id: string; text: string; lang: string }> } {
  vi.useFakeTimers({ toFake: ["Date"] });
  const store = RunStore.openInMemory();
  const turns = [
    ...Array.from({ length: zh }, (_, i) => ({ text: `以后请记住第${i}条规矩`, lang: "zh" })),
    ...Array.from({ length: en }, (_, i) => ({ text: `please check item number ${i} today`, lang: "en" }))
  ].map((t, i) => ({ ...t, id: seedTurn(store, t.text, i) }));
  vi.useRealTimers();
  return { store, turns };
}
const stateOf = (store: RunStore, id: string): unknown => {
  const t = store.listReplayTurns({ sinceIso: TREE_LABEL_SINCE }).find((x) => x.turn_id === id)!;
  const b = treeContextFor(store, {}, t).built;
  if (!b.ok) throw new Error("state");
  return b.state;
};
/** A replay row as the replay CLI writes it: A under today's hashes, B (key `<turn>:perm`) under the permuted ones. */
function row(store: RunStore, id: string, lang: string, run: "A" | "B", over: Record<string, unknown> = {}, category = "memory"): Record<string, unknown> {
  const qs = treeQuestions(run === "B");
  return { key: run === "B" ? `${id}:perm` : id, turn_id: id, run_id: "r", lang, status: "ok", est_usd: 0, state_hash: stateHash(stateOf(store, id)),
    tools: {}, proxy: null, proxy_rule: "no_tool", pre_judge: "judge", think_harder: false, bare_ack: false, quoted: false, model: MODEL,
    criteria_hashes: Object.fromEntries(qs.map((q) => [q.id, criteriaHash(q)])), answers: treeAnswers({ category, setsRule: 0.95 }), ...over };
}
function files(lines: { A: unknown[]; B: unknown[]; labels?: unknown[] }): string {
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  const w = (f: string, rows: unknown[]): void => writeFileSync(join(dir, f), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  w("replay.jsonl", lines.A); w("replay-permuted.jsonl", lines.B); w("labels.jsonl", lines.labels ?? []);
  return dir;
}
function full(w: ReturnType<typeof world>, o: { labels?: unknown[]; overA?: (id: string) => Record<string, unknown> } = {}): string {
  return files({ A: w.turns.map((t) => row(w.store, t.id, t.lang, "A", o.overA?.(t.id))), B: w.turns.map((t) => row(w.store, t.id, t.lang, "B")),
    labels: o.labels ?? w.turns.slice(0, 5).map((t) => ({ turn_id: t.id, category: "memory", by: "paco", at: "2026-10-09T00:00:00.000Z" })) });
}
const incidents = (s: RunStore) => s.listOpenIncidents();
const kinds = (s: RunStore): string[] => incidents(s).map((i) => i.kind);

describe("importJevAnchor", () => {
  it("imports paired turns, seeds the anchor model trusted and stores the baselines", () => {
    const w = world(100);
    const first = w.turns[0]!.id;
    const dir = files({ A: w.turns.map((t) => row(w.store, t.id, t.lang, "A")),
      B: w.turns.map((t) => row(w.store, t.id, t.lang, "B", t.id === first ? { answers: treeAnswers({ category: "answer" }) } : {})),
      labels: [...w.turns.slice(0, 5).map((t) => ({ turn_id: t.id, category: "memory", by: "paco", at: "2026-10-09T00:00:00.000Z" })),
        { turn_id: w.turns[5]!.id, category: "answer", by: "paco", at: "2026-10-09T00:00:00.000Z" }] });
    const r = importJevAnchor(w.store, dir, { env: {} });
    expect(r.status).toBe("imported");
    expect(w.store.listAnchorTurns()).toHaveLength(102);
    expect(w.store.anchorAnswers("A")).toHaveLength(102 * 6);
    expect(w.store.anchorAnswers("B")).toHaveLength(102 * 6);
    expect(w.store.anchorLabels()).toHaveLength(6);
    expect(w.store.getJevModel(MODEL)?.state).toBe("trusted");
    const meta = JSON.parse(w.store.getAnchorMeta("baseline")!);
    expect(meta.turns).toEqual({ zh: 100, en: 2 });
    expect(meta.agreement.category).toEqual({ agree: 101, n: 102 }); // one turn's B run answers another category
    expect(meta.agreement.route.n).toBe(102);
    // 5 labelled memory turns plus one labelled answer that A routes to memory (a wrong route); B loses the differing turn
    expect(meta.lanes.A.memory).toEqual({ wrong: 1, recall: 5, labelled: 5 });
    expect(meta.lanes.B.memory.recall).toBe(4);
    expect(kinds(w.store)).toEqual([]);
  });

  it("the trusted seed wins when discovery already noted the model as checking", () => {
    const w = world(100);
    w.store.noteJevModel(MODEL, "2026-10-01T00:00:00.000Z");
    expect(w.store.getJevModel(MODEL)?.state).toBe("checking");
    importJevAnchor(w.store, full(w), { env: {} });
    expect(w.store.getJevModel(MODEL)?.state).toBe("trusted");
  });

  it("a second import with a non-empty anchor is a no-op", () => {
    const w = world(100);
    const dir = full(w);
    importJevAnchor(w.store, dir, { env: {} });
    const before = w.store.anchorAnswers("A").length;
    const again = importJevAnchor(w.store, dir, { env: {} });
    expect(again.status).toBe("noop");
    expect(again.message).toMatch(/already imported/);
    expect(w.store.anchorAnswers("A")).toHaveLength(before);
  });

  it("--replace (Paco-run, final fix C3) clears the anchor and re-imports in one transaction; a failed replace keeps the old anchor", () => {
    const w = world(100);
    importJevAnchor(w.store, full(w), { env: {} });
    w.store.setAnchorMeta("anchor_model", JSON.stringify({ model: "jev-accepted" }));
    const relabelled = full(w, { labels: [{ turn_id: w.turns[0]!.id, category: "answer", by: "paco", at: "2026-10-23T00:00:00.000Z" }],
      overA: () => ({ answers: treeAnswers({ category: "answer" }) }) });
    const r = importJevAnchor(w.store, relabelled, { env: {}, replace: true });
    expect(r.status).toBe("imported");
    expect(w.store.anchorLabels()).toEqual([{ turn_id: w.turns[0]!.id, category: "answer", by: "paco", at: "2026-10-23T00:00:00.000Z" }]);
    expect(new Set(w.store.anchorAnswers("A").filter((a) => a.question_id === "category").map((a) => JSON.parse(a.answer_json).choice))).toEqual(new Set(["answer"]));
    expect(w.store.anchorAnswers("A")).toHaveLength(102 * 6);
    expect(w.store.getAnchorMeta("anchor_model")).toBeUndefined();
    const before = w.store.anchorAnswers("A");
    const empty = files({ A: [], B: [] });
    expect(importJevAnchor(w.store, empty, { env: {}, replace: true }).status).toBe("insufficient");
    expect(w.store.anchorAnswers("A")).toEqual(before); // nothing usable: the old anchor stays
  });

  it("the latest line per key wins and only ok lines count", () => {
    const w = world(101);
    const [first, second] = w.turns as [typeof w.turns[number], typeof w.turns[number]];
    const dir = full(w, { overA: () => ({}) });
    // an older line with other answers is overridden; a LATER failed line re-opens the key and drops that turn
    const stale = row(w.store, first.id, "zh", "A", { answers: treeAnswers({ category: "answer" }) });
    writeFileSync(join(dir, "replay.jsonl"), `${JSON.stringify(stale)}\n${readFileSync(join(dir, "replay.jsonl"), "utf8")}`);
    appendFileSync(join(dir, "replay.jsonl"), `${JSON.stringify({ key: second.id, status: "jev_failed" })}\n`);
    const r = importJevAnchor(w.store, dir, { env: {} });
    expect(r.counts?.dropped).toEqual({ no_a: 1 });
    const a = w.store.anchorAnswers("A").find((x) => x.turn_id === first.id && x.question_id === "category")!;
    expect(JSON.parse(a.answer_json).choice).toBe("memory");
    expect(w.store.listAnchorTurns()).not.toContain(second.id);
  });

  it("drops a turn whose A row carries other criteria hashes, or whose B row carries the canonical ones", () => {
    const w = world(102);
    const [a, b, c] = w.turns as [typeof w.turns[number], typeof w.turns[number], typeof w.turns[number]];
    const dir = full(w, { overA: (id) => (id === a.id ? { criteria_hashes: { category: "old" } } : {}) });
    const canon = Object.fromEntries(treeQuestions(false).map((q) => [q.id, criteriaHash(q)]));
    appendFileSync(join(dir, "replay-permuted.jsonl"), `${JSON.stringify(row(w.store, b.id, "zh", "B", { criteria_hashes: canon }))}\n`);
    const r = importJevAnchor(w.store, dir, { env: {} });
    expect(r.counts?.dropped).toEqual({ invalid_a: 1, invalid_b: 1 });
    expect(w.store.listAnchorTurns()).toContain(c.id);
    expect(w.store.listAnchorTurns()).not.toContain(a.id);
    expect(w.store.listAnchorTurns()).not.toContain(b.id);
  });

  it("keeps a turn only with both runs, and drops one whose rebuilt state hash differs", () => {
    const w = world(102);
    const [noB, wrongHash] = w.turns as [typeof w.turns[number], typeof w.turns[number]];
    const dir = files({
      A: w.turns.map((t) => row(w.store, t.id, t.lang, "A", t.id === wrongHash.id ? { state_hash: "0".repeat(64) } : {})),
      B: w.turns.filter((t) => t.id !== noB.id).map((t) => row(w.store, t.id, t.lang, "B")) });
    const r = importJevAnchor(w.store, dir, { env: {} });
    expect(r.counts?.dropped).toEqual({ no_b: 1, state_mismatch: 1 });
    expect(r.status).toBe("imported");
  });

  it("stores the state through the live redactor, so a secret never reaches the anchor", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory({ redact: (t) => t.replaceAll("hunter2-secret", "‹secret›") });
    const ids = Array.from({ length: 100 }, (_, i) => seedTurn(store, `以后密码是 hunter2-secret 第${i}条`, i));
    vi.useRealTimers();
    const dir = files({ A: ids.map((id) => row(store, id, "zh", "A")), B: ids.map((id) => row(store, id, "zh", "B")) });
    expect(importJevAnchor(store, dir, { env: {} }).status).toBe("imported");
    const stored = store.anchorStates();
    expect(stored.every((s) => !s.state_json.includes("hunter2-secret") && s.state_json.includes("‹secret›"))).toBe(true);
    expect(stored[0]!.state_hash).toBe(stateHash(JSON.parse(stored[0]!.state_json)));
  });

  it("rows of two models seed nothing and open one incident naming the command", () => {
    const w = world(100);
    const dir = full(w, { overA: (id) => (id === w.turns[0]!.id ? { model: "jev-x.2" } : {}) });
    const r = importJevAnchor(w.store, dir, { env: {} });
    expect(r.status).toBe("mixed_models");
    expect(w.store.anchorEmpty()).toBe(true);
    expect(w.store.getJevModel(MODEL)).toBeUndefined();
    expect(incidents(w.store).map((i) => [i.kind, i.detail_json])).toEqual([["jev_anchor_mixed_models", expect.stringContaining(ANCHOR_COMMAND)]]);
  });

  it("fewer than 100 zh turns (mixed and en not counted) mark the model insufficient, import nothing and open one incident", () => {
    const w = world(99, 30);
    const r = importJevAnchor(w.store, full(w), { env: {} });
    expect(r.status).toBe("insufficient");
    expect(w.store.anchorEmpty()).toBe(true);
    expect(w.store.getJevModel(MODEL)?.state).toBe("insufficient");
    expect(kinds(w.store)).toEqual(["jev_anchor_insufficient"]);
    expect(incidents(w.store)[0]!.detail_json).toContain(ANCHOR_COMMAND);
  });

  it("no kept turn at all is insufficient, never mixed_models", () => {
    const w = world(3);
    const dir = files({ A: [], B: [] });
    expect(importJevAnchor(w.store, dir, { env: {} }).status).toBe("insufficient");
    expect(kinds(w.store)).toEqual(["jev_anchor_insufficient"]);
  });

  it("the request alias is not a model: rows reporting it import nothing and arm nothing", () => {
    const w = world(100);
    const dir = files({ A: w.turns.map((t) => row(w.store, t.id, t.lang, "A", { model: JEV_REQUEST_MODEL })), B: w.turns.map((t) => row(w.store, t.id, t.lang, "B", { model: JEV_REQUEST_MODEL })) });
    const r = importJevAnchor(w.store, dir, { env: {} });
    expect(r.status).not.toBe("imported");
    expect(w.store.anchorEmpty()).toBe(true);
    expect(w.store.getJevModel(JEV_REQUEST_MODEL)).toBeUndefined();
  });

  // Final fix F2 (security Minor): an anchor row is checked like a Jev response. A malformed model id or answer is a drop,
  // never a throw (a raw stack at the CLI, a silent boot failure) and never NaN stored as Paco's reference.
  it("an anchor model id that is not a Jev model id (JEV_MODEL_ID) drops the turn as invalid", () => {
    const w = world(101);
    const [bad] = w.turns;
    const dir = full(w, { overA: (id) => (id === bad!.id ? { model: "jev x.1\n**bold**" } : {}) });
    const r = importJevAnchor(w.store, dir, { env: {} });
    expect(r.status).toBe("imported");
    expect(r.counts?.dropped).toEqual({ invalid_a: 1 });
    expect(w.store.listAnchorTurns()).not.toContain(bad!.id);
  });

  it("a malformed answer (a choice without probabilities, a noul that is not a number) is an invalid drop, not a throw", () => {
    const w = world(102);
    const [a, b] = w.turns;
    const noProbs = { ...treeAnswers({ category: "memory" }), category: { type: "choice", choice: "memory", confidence: 0.9 } };
    const nanNoul = { ...treeAnswers({ category: "memory" }), sets_rule: { type: "noul", noul: "high" } };
    const dir = files({ A: w.turns.map((t) => row(w.store, t.id, t.lang, "A", t.id === a!.id ? { answers: noProbs } : {})),
      B: w.turns.map((t) => row(w.store, t.id, t.lang, "B", t.id === b!.id ? { answers: nanNoul } : {})) });
    let r: ReturnType<typeof importJevAnchor> | undefined;
    expect(() => { r = importJevAnchor(w.store, dir, { env: {} }); }).not.toThrow();
    expect(r?.counts?.dropped).toEqual({ invalid_a: 1, invalid_b: 1 });
    expect(r?.status).toBe("imported");
  });

  it("a successful import resolves the earlier missing / insufficient anchor incidents", () => {
    const w = world(100);
    importJevAnchor(w.store, join(mkdtempSync(join(tmpdir(), "anchor-")), "nope"), { env: {} });
    expect(kinds(w.store)).toEqual(["jev_anchor_missing"]);
    expect(importJevAnchor(w.store, full(w), { env: {} }).status).toBe("imported");
    expect(kinds(w.store)).toEqual([]);
  });

  it("a throw inside the transaction leaves every anchor table empty", () => {
    const w = world(100);
    const state = (turn_id: string) => ({ turn_id, lang: "zh", state_json: "{}", state_hash: "h" });
    expect(() => w.store.importAnchor({ rows: [], states: [state("t"), state("t")], labels: [], meta: { baseline: "{}" }, trustedModel: MODEL, now: "n" })).toThrow();
    expect([w.store.anchorEmpty(), w.store.anchorStates(), w.store.anchorLabels(), w.store.getAnchorMeta("baseline"), w.store.getJevModel(MODEL)])
      .toEqual([true, [], [], undefined, undefined]);
  });
});

describe("the import's printed counts (final fix F5)", () => {
  it("label the stored baselines informational: the check recomputes its own from the stored anchor", () => {
    const w = world(100);
    const lines = anchorCountsLines(importJevAnchor(w.store, full(w), { env: {} }).counts!);
    expect(lines[0]).toMatch(/"model":"jev-x\.1"/);
    expect(lines[1]).toMatch(/^baselines \(informational: each check recomputes them over the turns it compared\): \{"agreement"/);
  });
});

describe("bootJevAnchor", () => {
  it("missing files with an empty anchor open ONE incident naming the command and the paths, however often boot runs", () => {
    const store = RunStore.openInMemory();
    const dir = join(mkdtempSync(join(tmpdir(), "anchor-")), "nope");
    const logs: string[] = [];
    bootJevAnchor(store, dir, (l) => logs.push(l)); bootJevAnchor(store, dir, (l) => logs.push(l));
    const open = incidents(store);
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("jev_anchor_missing");
    const text = open[0]!.detail_json;
    expect(text).toContain(ANCHOR_COMMAND);
    // final fix F3: the page leaves the host, so it names the files relative to the project root, never an absolute path
    expect(JSON.parse(text).files).toEqual([".houge/jev-tree/replay.jsonl", ".houge/jev-tree/replay-permuted.jsonl", ".houge/jev-tree/labels.jsonl"]);
    expect(text).not.toContain(dir);
    expect(text).not.toContain(tmpdir());
    expect(store.anchorEmpty()).toBe(true);
  });

  it("imports when the files exist, and does nothing (no incident) once the anchor is there", () => {
    const w = world(100);
    const dir = full(w);
    expect(bootJevAnchor(w.store, dir, () => undefined)?.status).toBe("imported");
    expect(bootJevAnchor(w.store, dir, () => undefined)).toBeUndefined();
    expect(kinds(w.store)).toEqual([]);
  });

  it("a failing import is logged by code and boot continues", () => {
    const w = world(100);
    const dir = full(w);
    writeFileSync(join(dir, "labels.jsonl"), "not json\n");
    const logs: string[] = [];
    expect(() => bootJevAnchor(w.store, dir, (l) => logs.push(l))).not.toThrow();
    expect(logs.join("\n")).toMatch(/boot import failed/);
    expect(logs.join("\n")).not.toMatch(/not json|labels: line/);
  });
});
