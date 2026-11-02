import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import type { ProbeFn, ProbeOutcome } from "../../src/omp/model-probe.js";
import { changeLine, failedLine, runModelRolesTick, shadowLine } from "../../src/omp/model-roles-tick.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.2 tick order and §8 "Probe" + "Retirement": probes run outside the transaction, one at a time; their effects land
// in one transaction with the resolution; a stop mid-probe commits nothing. Every effect is asserted as exact rows (P4).
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const FIX = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();
const PASS: ProbeOutcome = { result: "pass", kind: "ok" };
let catalog: () => CatalogModel[] | null = FIX;
const roles = () => new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog() });
function probeBy(answer: (sel: string) => ProbeOutcome | "aborted", calls: string[] = []): ProbeFn {
  return async (sel) => { calls.push(sel); return answer(sel); };
}
const tiers = () => Object.fromEntries(store.listModelTiers().map((r) => [r.tier, [r.adopted, r.previous, r.rejected_selector]]));
const probes = () => store.getLedgerEvents().filter((e) => e.event_type === "model_probe").map((e) => e.payload);
const resolvedRows = () => store.getLedgerEvents().filter((e) => e.event_type === "model_roles_resolved");
async function tick(r: RoleResolver, probe: ProbeFn | undefined, now: string, notes: string[] = [], signal?: AbortSignal) {
  return runModelRolesTick({ store, roles: r, ...(probe ? { probe } : {}), now, notify: (t) => notes.push(t), ...(signal ? { signal } : {}) });
}
const FIRST_CALLS = ["openai-codex/gpt-6-sol", "google-antigravity/gemini-2.5-flash", "kimi-code/k3.1-pro", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5"];
beforeEach(() => { catalog = FIX; });

describe("the first tick over the 2026-11-02 catalog", () => {
  it("probes each moved head and each missing previous, once, in tier order; passes adopt; one event per probe", async () => {
    const calls: string[] = []; const r = roles();
    expect((await tick(r, probeBy(() => PASS, calls), day(0))).ran).toBe(true);
    expect(calls).toEqual(FIRST_CALLS);
    expect(tiers()).toEqual({
      "codex-sol": ["gpt-6.1-sol", "gpt-6-sol", null], "gemini-flash": ["gemini-3.8-flash", "gemini-2.5-flash", null], "gemini-pro": [null, null, null],
      kimi: ["k3.1-pro", "k3", null], "opus@anthropic": ["claude-opus-5-5", "claude-opus-5", null], "opus@antigravity": ["claude-opus-5-5", null, null],
      "sonnet@anthropic": ["claude-sonnet-5-5", "claude-sonnet-5", null], "sonnet@antigravity": ["claude-sonnet-5-5", null, null]
    });
    expect(probes()).toEqual([
      { tier: "codex-sol", selector: "openai-codex/gpt-6-sol", purpose: "previous", result: "pass", kind: "ok" },
      { tier: "gemini-flash", selector: "google-antigravity/gemini-2.5-flash", purpose: "previous", result: "pass", kind: "ok" },
      { tier: "kimi", selector: "kimi-code/k3.1-pro", purpose: "head", result: "pass", kind: "ok" },
      { tier: "opus@anthropic", selector: "anthropic/claude-opus-5", purpose: "previous", result: "pass", kind: "ok" },
      { tier: "sonnet@anthropic", selector: "anthropic/claude-sonnet-5", purpose: "previous", result: "pass", kind: "ok" }
    ]);
  });
  it("with a baseline, the notice names exactly the keys whose head moved (Kimi's adoption)", async () => {
    const r = roles(); const notes: string[] = [];
    await tick(r, undefined, day(0));                       // baseline, no probe (P26)
    await tick(r, probeBy(() => PASS), day(1), notes);
    const [before, after] = resolvedRows().map((e) => new Map((e.payload as { roles: Array<{ key: string; head: string | null }> }).roles.map((x) => [x.key, x.head])));
    const moved = [...after!.keys()].filter((k) => before!.get(k) !== after!.get(k));
    expect(moved).toEqual(["tiny", "judges:0", "reviewer"]);
    expect(notes).toEqual(moved.map((k) => changeLine(k, before!.get(k) ?? null, after!.get(k) ?? null)));
  });
});

describe("probe outcomes", () => {
  it("model_missing keeps the tier, names it once, and is not probed again for 7 days", async () => {
    const r = roles(); const notes: string[] = []; const calls: string[] = [];
    const answer = (sel: string): ProbeOutcome => (sel === "kimi-code/k3.1-pro" ? { result: "model_missing", kind: "model_missing" } : PASS);
    await tick(r, probeBy(answer, calls), day(0), notes);
    expect(tiers().kimi).toEqual(["k3", null, "kimi-code/k3.1-pro"]);
    expect(notes).toEqual([failedLine("kimi-code/k3.1-pro", "kimi-code/k3")]);
    calls.length = 0;
    await tick(r, probeBy(answer, calls), day(1));
    expect(calls).not.toContain("kimi-code/k3.1-pro");
    await tick(r, probeBy(answer, calls), day(7));
    expect(calls.filter((c) => c === "kimi-code/k3.1-pro")).toHaveLength(1);
  });
  it("inconclusive keeps the tier silently and retries the next day", async () => {
    const r = roles(); const notes: string[] = []; const calls: string[] = [];
    const answer = (sel: string): ProbeOutcome => (sel === "kimi-code/k3.1-pro" ? { result: "inconclusive", kind: "quota" } : PASS);
    await tick(r, probeBy(answer, calls), day(0), notes);
    expect(tiers().kimi).toEqual(["k3", null, null]);
    expect(notes).toEqual([]);
    calls.length = 0;
    await tick(r, probeBy(answer, calls), day(1));
    expect(calls).toContain("kimi-code/k3.1-pro");
  });
  it("a catalog outage probes nothing and changes no tier", async () => {
    catalog = () => null; const calls: string[] = []; const before = store.listModelTiers();
    await tick(roles(), probeBy(() => PASS, calls), day(0));
    expect(calls).toEqual([]);
    expect(store.listModelTiers()).toEqual(before);
  });
  it("a failed read after a good one plans on nothing: the cached catalog is not today's (M38, Decision 4)", async () => {
    // The resolver keeps the last good catalog for resolution; the tick must not probe and adopt against it as if it were fresh.
    const r = roles(); const calls: string[] = [];
    await tick(r, undefined, day(0));                       // a good read, no probe: tiers stay seeded
    const before = store.listModelTiers();
    catalog = () => null;
    await tick(r, probeBy(() => PASS, calls), day(1));
    expect([calls, store.listModelTiers(), probes()]).toEqual([[], before, []]);
    expect(resolvedRows().map((e) => e.payload.catalog_ok)).toEqual([true, false]);
  });
  it("a probe that answers aborted without the stop signal still commits nothing (M39)", async () => {
    const before = store.listModelTiers();
    expect(await tick(roles(), probeBy(() => "aborted"), day(0))).toEqual({ ran: false, changed: [], unresolved: [] });
    expect([probes(), store.listModelTiers(), resolvedRows()]).toEqual([[], before, []]);
  });
  it("a stop mid-probe commits nothing: no probe event, no tier write, no resolution row", async () => {
    const ac = new AbortController(); let n = 0; const before = store.listModelTiers();
    const probe: ProbeFn = async () => { if (++n === 2) { ac.abort(); return "aborted"; } return PASS; };
    expect(await tick(roles(), probe, day(0), [], ac.signal)).toEqual({ ran: false, changed: [], unresolved: [] });
    expect([probes(), store.listModelTiers(), resolvedRows()]).toEqual([[], before, []]);
  });
});

describe("retirement (the regression this slice exists for)", () => {
  it("an adopted judge head leaving the catalog moves the seat to its previous head in one tick", async () => {
    const r = roles();
    store.writeModelTier({ tier: "codex-sol", adopted: "gpt-6.1-sol", previous: "gpt-6-sol", adopted_at: day(-1), rejected_selector: null, rejected_at: null }, day(-1));
    catalog = () => FIX().filter((m) => m.id !== "gpt-6.1-sol");
    const res = await tick(r, probeBy(() => PASS), day(0));
    expect(r.resolveAll().find((x) => x.key === "judges:1")?.head).toBe("openai-codex/gpt-6-sol");
    expect(res.unresolved).toEqual(["judges:2"]);
    expect(tiers()["codex-sol"]).toEqual(["gpt-6-sol", "gpt-5.6-sol", null]);
  });
  it("a seat with no previous head opens role_unresolved", async () => {
    const r = roles();
    catalog = () => FIX().filter((m) => !(m.provider === "kimi-code" && /^k\d/.test(m.id))); // the tier's family gone, the provider still listed
    const res = await tick(r, probeBy(() => PASS), day(0));
    expect(res.unresolved).toEqual(["judges:0", "judges:2"]);
    expect(store.listOpenIncidents().filter((i) => i.kind === "role_unresolved").map((i) => i.subject).sort()).toEqual(["judges:0", "judges:2"]); // listOpenIncidents orders by first_seen_at, incident_id: same-instant rows tie, so compare sorted
  });
});

describe("a partial read (P13, review W1)", () => {
  it("a provider missing from one read changes no tier, probes nothing for it, and recovers with no probe", async () => {
    const r = roles(); const calls: string[] = [];
    await tick(r, probeBy(() => PASS), day(0));                    // kimi adopts k3.1-pro, previous k3
    const kimiBefore = store.getModelTier("kimi");
    catalog = () => FIX().filter((m) => m.provider !== "kimi-code");
    await tick(r, probeBy(() => PASS, calls), day(1));
    expect(store.getModelTier("kimi")).toEqual(kimiBefore);        // unchanged row, updated_at included (writeTiers skips an unchanged tier)
    expect(calls.filter((c) => c.startsWith("kimi-code/"))).toEqual([]);
    catalog = FIX; calls.length = 0;
    await tick(r, probeBy(() => PASS, calls), day(2));
    expect(r.resolveAll().find((x) => x.key === "judges:0")?.head).toBe("kimi-code/k3.1-pro");
    expect(calls.filter((c) => c.startsWith("kimi-code/"))).toEqual([]);
  });
});

describe("a shadowing override", () => {
  it("is named when its tier's head moves", async () => {
    const r = roles(); const notes: string[] = [];
    await tick(r, undefined, day(0));
    store.recordModelRoleOverride({ key: "judges:0", pattern: "k3", actor: "paco" });
    await tick(r, probeBy(() => PASS), day(1), notes);
    const [before, after] = resolvedRows().map((e) => new Map((e.payload as { roles: Array<{ key: string; head: string | null }> }).roles.map((x) => [x.key, x.head])));
    const moved = [...after!.keys()].filter((k) => before!.get(k) !== after!.get(k));
    expect(notes).toEqual([...moved.map((k) => changeLine(k, before!.get(k) ?? null, after!.get(k) ?? null)), shadowLine("judges:0", "kimi-code/k3.1-pro", "k3")]);
    expect(shadowLine("judges:0", "kimi-code/k3.1-pro", "k3")).toBe("ℹ️ Tier head `kimi-code/k3.1-pro` is available; your override `k3` is in place (/models reset judges 0).");
    expect(failedLine("kimi-code/k3.1-pro", null)).toBe("⚠️ `kimi-code/k3.1-pro` failed its check; staying on nothing.");
  });
});

describe("a shadowing override on a retired head (M48)", () => {
  it("is named when retirement moves the head, though the tick's probe was only for the previous", async () => {
    // The head moved before the probe (followRetirement); comparing against the post-retirement state would miss the move.
    const r = roles(); const notes: string[] = [];
    store.writeModelTier({ tier: "codex-sol", adopted: "gpt-6.1-sol", previous: "gpt-6-sol", adopted_at: day(-1), rejected_selector: null, rejected_at: null }, day(-1));
    store.recordModelRoleOverride({ key: "judges:1", pattern: "gpt-5.6-sol", actor: "paco" });
    catalog = () => FIX().filter((m) => m.id !== "gpt-6.1-sol");
    await tick(r, probeBy(() => PASS), day(0), notes);
    expect(notes).toContain(shadowLine("judges:1", "openai-codex/gpt-6-sol", "gpt-5.6-sol"));
  });
});

describe("the ledger takes closed codes only", () => {
  it("a probe label outside the closed set (unavailable) is recorded as other and the tick still commits", async () => {
    const res = await tick(roles(), probeBy(() => ({ result: "inconclusive", kind: "unavailable" })), day(0));
    expect(res.ran).toBe(true);
    expect(probes().map((p) => (p as { kind: string }).kind)).toEqual(Array(5).fill("other"));
  });
});

describe("daemon wiring", () => {
  it("modelRolesTickInput passes the probe and the resolver's catalog (plan P26)", async () => {
    const { modelRolesTickInput } = await import("../../src/telegram/telegram-daemon.js");
    const r = roles();
    const input = modelRolesTickInput(store, r, day(0), () => {}, new AbortController().signal);
    expect(typeof input.probe).toBe("function");
    expect(typeof input.roles.catalog).toBe("function");
  });
});

describe("empty-tier cards (spec §4.4)", () => {
  it("one card a day for gemini-pro, naming judges:2, proposals by price; none once an override fills the seat", async () => {
    const r = roles(); const cards: unknown[] = [];
    const run = (now: string) => runModelRolesTick({ store, roles: r, now, notify: () => {}, card: (c) => cards.push(c) });
    await run(day(0));
    expect(cards).toEqual([{ tier: "gemini-pro", keys: ["judges:2"], proposals: ["gemini-4-argon", "gpt-oss-120b"] }]);
    await run(day(1));
    expect(cards).toHaveLength(2);
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gemini-4-argon", actor: "paco" });
    await run(day(2));
    expect(cards).toHaveLength(2);
  });
  it("an override whose model left the catalog does not fill the seat: the card is still sent (same predicate as the tap)", async () => {
    const r = roles(); const cards: unknown[] = [];
    store.recordModelRoleOverride({ key: "judges:2", pattern: "model-that-was-retired", actor: "paco" });
    await runModelRolesTick({ store, roles: r, now: day(0), notify: () => {}, card: (c) => cards.push(c) });
    expect(cards).toHaveLength(1);
  });
  it("a tier that empties but leaves every key resolved sends no card (P15)", async () => {
    const r = roles(); const cards: unknown[] = [];
    catalog = () => FIX().filter((m) => !(m.provider === "google-antigravity" && m.id === "claude-sonnet-5-5"));
    await runModelRolesTick({ store, roles: r, now: day(0), notify: () => {}, card: (c) => cards.push(c) });
    expect(cards.map((c) => (c as { tier: string }).tier)).toEqual(["gemini-pro"]);
  });
});
