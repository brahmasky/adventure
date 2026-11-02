import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { TAP_HANDLED_TEXT } from "../../src/gateway/improvement-commands.js";
import { enqueueTierCard, TAP_NO_CATALOG_TEXT, TAP_STATIC_TEXT, tierCallbackData, tierCardText, tierModelHash } from "../../src/gateway/model-tier-commands.js";
import type { ProbeFn, ProbeOutcome } from "../../src/omp/model-probe.js";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { parseModelTierCallback } from "../../src/triggers/telegram-command-parser.js";

// Spec §4.4: an empty tier asks Paco instead of failing quietly for three weeks. A tap probes first and only a pass writes
// the override (the same row `/models set judges 2 <id>` writes) in the probe event's transaction: code never adopts a
// codename without a tap, and a model the subscription cannot reach is never adopted at all.
let store: RunStore; let cb = 0;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
const FIX = (): CatalogModel[] => parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
const CARD = { tier: "gemini-pro" as const, keys: ["judges:2"], proposals: ["gemini-4-argon", "gpt-oss-120b"] };
const outbox = () => (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
  .prepare("SELECT idempotency_key, payload_json FROM notification_outbox ORDER BY created_at, rowid").all() as Array<{ idempotency_key: string; payload_json: string }>;
const texts = () => outbox().map((r) => (JSON.parse(r.payload_json) as { text: string }).text);
const tap = (data: string, callback = `cb${++cb}`) => {
  const p = parseModelTierCallback(data)!;
  return buildTypedTaskEvent({ source: "telegram", type: "model_tier_tap", requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "-1003" },
    idempotency_key: `telegram:1:callback:${callback}`, source_reference: `telegram:update:1:callback:${callback}`,
    metadata: { telegram_update_id: 1, telegram_callback_id: callback, tier: p.tier, ...(p.hash ? { model_hash: p.hash } : {}) } });
};
async function gateway(answer: ProbeOutcome, calls: string[] = []) {
  const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => FIX() });
  await roles.refreshCatalog();
  const probe: ProbeFn = async (sel) => { calls.push(sel); return answer; };
  return { gw: new Gateway(store, undefined, undefined, undefined, undefined, { roles, modelProbe: probe }), roles };
}
const probeRows = () => store.getLedgerEvents().filter((e) => e.event_type === "model_probe").map((e) => e.payload);

describe("the card", () => {
  it("is spec §4.4's text with Use buttons per proposal and Not now; one per tier per day", () => {
    expect(tierCardText(CARD)).toBe("Judges:2 has no model: Google's pro tier is empty. Use `gemini-4-argon`?");
    enqueueTierCard(store, "-1003", "2026-11-02T09:00:00.000Z", CARD);
    enqueueTierCard(store, "-1003", "2026-11-02T21:00:00.000Z", CARD);
    enqueueTierCard(store, "-1003", "2026-11-03T09:00:00.000Z", CARD);
    expect(outbox().map((r) => r.idempotency_key)).toEqual(["model_tier_card:gemini-pro:2026-11-02", "model_tier_card:gemini-pro:2026-11-03"]); // Sydney days: 09:00Z → 11-02 20:00; 21:00Z → 11-03 08:00; next 09:00Z → 11-03 20:00
    expect((JSON.parse(outbox()[0]!.payload_json) as { button_rows: unknown }).button_rows).toEqual([[
      { text: "Use gemini-4-argon", data: tierCallbackData("gemini-pro", "gemini-4-argon") },
      { text: "Use gpt-oss-120b", data: tierCallbackData("gemini-pro", "gpt-oss-120b") },
      { text: "Not now", data: "mt:gemini-pro:no" }]]);
  });
  it("callback data fits Telegram's 64 bytes and round-trips through the parser", () => {
    const d = tierCallbackData("sonnet@antigravity", "a-very-long-model-id-that-would-not-fit-in-callback-data-at-all");
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    expect(parseModelTierCallback(d)).toEqual({ tier: "sonnet@antigravity", hash: tierModelHash("a-very-long-model-id-that-would-not-fit-in-callback-data-at-all") });
    expect(parseModelTierCallback("mt:gemini-pro:no")).toEqual({ tier: "gemini-pro", hash: null });
    expect(parseModelTierCallback("mt:gemini-pro:zz:use")).toBeNull();
  });
  it("with no proposal, names the /models set form and offers no button", () => {
    enqueueTierCard(store, "-1003", "2026-11-02T09:00:00.000Z", { ...CARD, proposals: [] });
    expect(JSON.parse(outbox()[0]!.payload_json)).not.toHaveProperty("button_rows");
    expect(tierCardText({ ...CARD, proposals: [] })).toBe("Judges:2 has no model: Google's pro tier is empty. The catalog offers no other google-antigravity model; /models set judges 2 <pattern> fills it.");
  });
});

describe("a tap", () => {
  it("on a passing model: probe, then the override + probe event in one transaction; judges:2 resolves; role_unresolved closes", async () => {
    const { gw, roles } = await gateway({ result: "pass", kind: "ok" });
    store.openIncident({ kind: "role_unresolved", subject: "judges:2", detail: { role: "judges:2" } });
    expect(gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon")))).toMatchObject({ ok: true, status: "model_tier_tapped" });
    await gw.whenTierTapsSettled();
    expect(store.latestModelRoleOverrides().get("judges:2")).toBe("gemini-4-argon");
    expect(probeRows()).toEqual([{ tier: "gemini-pro", selector: "google-antigravity/gemini-4-argon", purpose: "tap", result: "pass", kind: "ok" }]);
    expect(roles.resolveAll().find((r) => r.key === "judges:2")?.head).toBe("google-antigravity/gemini-4-argon");
    expect(store.listOpenIncidents().filter((i) => i.kind === "role_unresolved")).toEqual([]);
    expect(texts()).toEqual(["🔎 Checking `gemini-4-argon` with one short prompt…",
      "✅ `gemini-4-argon` passed its check; judges:2 now uses it (an override: /models reset judges 2 undoes it)."]);
  });
  it("on a failing or inconclusive model writes no override and says so", async () => {
    for (const [answer, line] of [[{ result: "model_missing", kind: "model_missing" }, "❌ `gemini-4-argon` failed its check (not available on this subscription); nothing changed."],
      [{ result: "inconclusive", kind: "quota" }, "⏳ `gemini-4-argon` could not be checked right now (quota); nothing changed. Tap again later."]] as const) {
      store.close(); store = RunStore.openInMemory();
      const { gw } = await gateway(answer);
      gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon"))); await gw.whenTierTapsSettled();
      expect(store.latestModelRoleOverrides().has("judges:2")).toBe(false);
      expect(probeRows()).toEqual([{ tier: "gemini-pro", selector: "google-antigravity/gemini-4-argon", purpose: "tap", result: answer.result, kind: answer.kind }]);
      expect(texts()[1]).toBe(line);
    }
  });
  it("a stale hash, a filled seat, or a redelivered callback never probes twice", async () => {
    const calls: string[] = []; const { gw } = await gateway({ result: "pass", kind: "ok" }, calls);
    gw.intake(tap("mt:gemini-pro:000000000000:use")); await gw.whenTierTapsSettled();
    expect([calls, texts()]).toEqual([[], [TAP_HANDLED_TEXT]]);
    const ev = tap(tierCallbackData("gemini-pro", "gemini-4-argon"), "same");
    gw.intake(ev); gw.intake(ev); await gw.whenTierTapsSettled();
    expect(calls).toEqual(["google-antigravity/gemini-4-argon"]);
    gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon"))); await gw.whenTierTapsSettled();
    expect(calls).toHaveLength(1);
    expect(texts().at(-1)).toBe(TAP_HANDLED_TEXT);
  });
  it("an override whose model left the catalog still needs a model: the card's predicate admits the tap and the pass replaces the dead override", async () => {
    const { gw, roles } = await gateway({ result: "pass", kind: "ok" });
    store.recordModelRoleOverride({ key: "judges:2", pattern: "model-that-was-retired", actor: "paco" });
    expect(roles.resolveAll().find((r) => r.key === "judges:2")?.head).toBeNull();
    gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon"))); await gw.whenTierTapsSettled();
    expect(store.latestModelRoleOverrides().get("judges:2")).toBe("gemini-4-argon");
  });
  it("a /models set that lands while the probe is pending is not overwritten by the older tap (review round 1)", async () => {
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => FIX() }); await roles.refreshCatalog();
    let release!: (o: ProbeOutcome) => void;
    const probe: ProbeFn = () => new Promise((r) => { release = r; });
    const gw = new Gateway(store, undefined, undefined, undefined, undefined, { roles, modelProbe: probe });
    gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon")));
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gpt-oss-120b", actor: "paco" });
    release({ result: "pass", kind: "ok" }); await gw.whenTierTapsSettled();
    expect(store.latestModelRoleOverrides().get("judges:2")).toBe("gpt-oss-120b");
    expect(texts().at(-1)).toBe("ℹ️ `gemini-4-argon` passed its check, but judges:2 got a model meanwhile; nothing changed.");
  });
  it("during a catalog outage, or in static mode, says why nothing changed instead of 'Already handled.' (final review Minor 2)", async () => {
    // Paco taps the morning card after the catalog read failed: "Already handled." would tell him judges:2 is filled while it stays empty.
    const calls: string[] = [];
    const down = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => null }); await down.refreshCatalog();
    const probe: ProbeFn = async (sel) => { calls.push(sel); return { result: "pass", kind: "ok" }; };
    const gw = new Gateway(store, undefined, undefined, undefined, undefined, { roles: down, modelProbe: probe });
    gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon"))); await gw.whenTierTapsSettled();
    vi.stubEnv("HOUGE_MODEL_ROLES", "static"); // a catalog in hand, but static applies no override: writing one would be a silent no-op
    const { gw: gw2 } = await gateway({ result: "pass", kind: "ok" }, calls);
    gw2.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon"))); await gw2.whenTierTapsSettled();
    expect([calls, texts(), store.latestModelRoleOverrides().has("judges:2")]).toEqual([[], [TAP_NO_CATALOG_TEXT, TAP_STATIC_TEXT], false]);
  });
  it("Not now only answers", async () => {
    const calls: string[] = []; const { gw } = await gateway({ result: "pass", kind: "ok" }, calls);
    gw.intake(tap("mt:gemini-pro:no")); await gw.whenTierTapsSettled();
    expect([calls, texts()]).toEqual([[], ["👍 Not now: judges:2 stays empty; the daily reminder lists it until it is filled."]]);
  });
  it("a daemon stop aborts the tap's probe: nothing is written, only the 'Checking' reply exists (review W5)", async () => {
    const ac = new AbortController(); let seen: AbortSignal | undefined;
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => FIX() }); await roles.refreshCatalog();
    const probe: ProbeFn = (_sel, signal) => { seen = signal; return new Promise((r) => signal?.addEventListener("abort", () => r("aborted"), { once: true })); };
    const gw = new Gateway(store, undefined, undefined, undefined, undefined, { roles, modelProbe: probe, stopSignal: ac.signal });
    gw.intake(tap(tierCallbackData("gemini-pro", "gemini-4-argon")));
    ac.abort(); await gw.whenTierTapsSettled();
    expect(seen).toBe(ac.signal);
    expect([probeRows(), store.latestModelRoleOverrides().has("judges:2"), texts()]).toEqual([[], false, ["🔎 Checking `gemini-4-argon` with one short prompt…"]]);
  });
  it("is exempt from the per-chat rate limit, like the other card taps", async () => {
    const { gw } = await gateway({ result: "pass", kind: "ok" });
    for (let n = 0; n < 7; n++) expect(gw.intake(tap("mt:gemini-pro:no")).ok).toBe(true);
  });
});
