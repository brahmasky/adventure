import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import type { MediaIngestedPayload } from "../../src/media/media-config.js";
import { RunStore } from "../../src/run/run-store.js";

function createRun(store: RunStore, key: string): string {
  const created = store.createOrGet(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "[voice message]",
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" },
    idempotency_key: key, source_reference: "telegram:update:1:message:1"
  }));
  if (created.status !== "created") throw new Error("expected created");
  return created.run_id;
}

describe("media_ingested in the ledger (spec 2026-09-29)", () => {
  it("recordMediaIngested writes one run-scoped row with the payload as given", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "m1");
      const payload: MediaIngestedPayload = { kind: "voice", status: "ok", source: "telegram", bytes: 12000, duration_s: 7, provider: "agy-cli", model: "Gemini 3.8 Flash (Low)", latency_ms: 2100, chars_out: 42 };
      store.recordMediaIngested(run, payload);
      const rows = store.getLedgerEvents(run).filter((e) => e.event_type === "media_ingested");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toEqual(payload);
    } finally {
      store.close();
    }
  });

  it("no-bodies guarantee: only count/tag keys are ever present — never a transcript, caption, id, name or path", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "m2");
      store.recordMediaIngested(run, { kind: "photo", status: "download_failed", source: "telegram", bytes: 15_000_000, width: 4000, height: 3000, detail: "http_404" });
      const row = store.getLedgerEvents(run).find((e) => e.event_type === "media_ingested")!;
      const allowed = new Set(["kind", "status", "source", "bytes", "duration_s", "width", "height", "provider", "model", "latency_ms", "chars_out", "detail"]);
      expect(Object.keys(row.payload).every((k) => allowed.has(k))).toBe(true);
      expect(JSON.stringify(row.payload)).not.toMatch(/file_id|file_path|caption|transcript|\/tmp|media\.(ogg|jpg)/);
    } finally {
      store.close();
    }
  });

  it("the required fields are kind, status and source", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "m3");
      expect(() => store.recordMediaIngested(run, { kind: "voice", status: "empty" } as unknown as MediaIngestedPayload)).toThrow(/source/);
    } finally {
      store.close();
    }
  });
});
