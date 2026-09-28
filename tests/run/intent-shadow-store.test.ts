import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";
import type { IntentShadowPayload } from "../../src/jev/shadow.js";

function createRun(store: RunStore, key: string): string {
  const created = store.createOrGet(buildTypedTaskEvent({
    source: "cli", type: "run", program: "research-brief", goal: key,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "local" },
    idempotency_key: key, source_reference: "argv", created_at: "2026-09-01T00:00:00.000Z"
  }));
  if (created.status !== "created") throw new Error("expected created");
  return created.run_id;
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const payload = (over: Partial<IntentShadowPayload> = {}): IntentShadowPayload => ({
  status: "ok", llm_intent: "research", llm_parsed: true, lang: "en", modality: "text",
  jev_intent: "research", jev_confidence: 0.9, jev_probabilities: { research: 0.9, answer: 0.1 }, jev_model: "jev-1.13.0", jev_latency_ms: 250, ...over
});
const classifyOk = (store: RunStore, run_id: string) =>
  store.llmAuditSink({ run_id, role: "classify" }).record({ provider: "pi", role: "", outcome: "ok", model: "m", latency_ms: 1 });

afterEach(() => vi.useRealTimers());

describe("intent_shadow in the ledger", () => {
  it("recordIntentShadow writes one run-scoped row with the payload as given", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "a");
      store.recordIntentShadow(run, payload());
      const rows = store.getLedgerEvents(run).filter((e) => e.event_type === "intent_shadow");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ status: "ok", llm_intent: "research", llm_parsed: true, lang: "en" });
    } finally {
      store.close();
    }
  });

  it("no-bodies guarantee: the row carries only label/number/tag keys — never message text", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "b");
      store.recordIntentShadow(run, payload({ status: "timeout", jev_error: "timed out after 5000ms" }));
      const row = store.getLedgerEvents(run).find((e) => e.event_type === "intent_shadow")!;
      const allowed = new Set(["status", "llm_intent", "llm_parsed", "lang", "modality", "jev_intent", "jev_confidence", "jev_probabilities", "jev_model", "jev_latency_ms", "jev_error"]);
      expect(Object.keys(row.payload).every((k) => allowed.has(k))).toBe(true);
      // `modality: "text"` is a legitimate value, so the probe looks for body-shaped keys, not the word "text".
      expect(JSON.stringify(row.payload)).not.toMatch(/prompt|question|message|content|system/i);
    } finally {
      store.close();
    }
  });

  it("llm_parsed=false is a valid value, not a missing required field", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "c");
      expect(() => store.recordIntentShadow(run, payload({ llm_parsed: false, llm_intent: "answer" }))).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("listIntentShadows: oldest first, honours since", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      at("2026-09-01T00:00:00.000Z");
      const r1 = createRun(store, "d1");
      store.recordIntentShadow(r1, payload({ lang: "zh" }));
      at("2026-09-02T00:00:00.000Z");
      const r2 = createRun(store, "d2");
      store.recordIntentShadow(r2, payload({ lang: "en" }));
      expect(store.listIntentShadows().map((r) => r.payload.lang)).toEqual(["zh", "en"]);
      expect(store.listIntentShadows("2026-09-01T12:00:00.000Z").map((r) => r.run_id)).toEqual([r2]);
    } finally {
      store.close();
    }
  });

  it("countClassifiedRunsWithoutShadow: ok-classified runs with no shadow row, inside the window only", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      at("2026-09-10T00:00:00.000Z");
      const shadowed = createRun(store, "e1");
      classifyOk(store, shadowed);
      store.recordIntentShadow(shadowed, payload());
      at("2026-09-11T00:00:00.000Z");
      const lost = createRun(store, "e2");
      classifyOk(store, lost);                                   // shutdown mid-shadow: counted
      const failedClassifier = createRun(store, "e3");
      store.llmAuditSink({ run_id: failedClassifier, role: "classify" })
        .record({ provider: "pi", role: "", outcome: "error", error_kind: "timeout", latency_ms: 1 }); // no label: not eligible
      at("2026-09-20T00:00:00.000Z");
      const afterWindow = createRun(store, "e4");
      classifyOk(store, afterWindow);                            // flag off later: outside [first,last]
      expect(store.countClassifiedRunsWithoutShadow("2026-09-10T00:00:00.000Z", "2026-09-12T00:00:00.000Z")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("firstIntentShadowAt: the campaign start — the oldest intent_shadow row, independent of any --since (Codex B3)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      expect(store.firstIntentShadowAt()).toBeUndefined();
      at("2026-09-01T00:00:00.000Z");
      store.recordIntentShadow(createRun(store, "f1"), payload());
      at("2026-09-05T00:00:00.000Z");
      store.recordIntentShadow(createRun(store, "f2"), payload());
      expect(store.firstIntentShadowAt()).toBe("2026-09-01T00:00:00.000Z");
    } finally {
      store.close();
    }
  });
});
