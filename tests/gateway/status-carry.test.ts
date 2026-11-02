import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../../src/run/schedule-spec.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2026-11-02 section 6.3: Paco could not see that every shell command asked because of a carry from 19 days earlier.
const localOf = (iso: string): string => { const z = resolveDisplayZone(process.env); return `${formatInstantInZone(iso, z)} (${z.split("/").pop() ?? z})`; };
const NOW = "2026-11-02T10:00:00.000Z";
const AT = "2026-11-01T22:00:00.000Z";
const status = (chat: string, key: string) => buildTypedTaskEvent({ source: "telegram", type: "status",
  requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: chat }, idempotency_key: `telegram:${key}`,
  source_reference: `telegram:update:${key}` });
const carryLines = (store: RunStore, chat: string, key: string): string[] => {
  new Gateway(store).intake(status(chat, key), NOW);
  return String([...drainOutbox(store).values()][0]?.text).split("\n").filter((l) => /^Conversation carries/.test(l));
};

describe("/status carry line", () => {
  it("names the stored level and since when, in the display zone", () => {
    const store = RunStore.openInMemory();
    store.setTranscriptTrust("-1003", "hostile", AT);
    expect(carryLines(store, "-1003", "a")).toEqual([`Conversation carries hostile since ${localOf(AT)} · /fresh clears it`]);
    store.close();
  });
  it("is absent for a clean level", () => {
    const store = RunStore.openInMemory();
    store.setTranscriptTrust("-1003", "hostile", AT);
    store.setTranscriptTrust("-1003", "clean", NOW);
    expect(carryLines(store, "-1003", "b")).toEqual([]);
    store.close();
  });
  it("omits since for a legacy null time", () => {
    const store = RunStore.openInMemory();
    store.setTranscriptTrust("-1003", "untrusted", AT);
    (store as unknown as { db: { prepare(s: string): { run(): void } } }).db.prepare("UPDATE planner_session_state SET transcript_trust_at = NULL").run();
    expect(carryLines(store, "-1003", "c")).toEqual(["Conversation carries untrusted · /fresh clears it"]);
    store.close();
  });
  it("does not show another chat's carry", () => {
    const store = RunStore.openInMemory();
    store.setTranscriptTrust("-1003", "hostile", AT);
    expect(carryLines(store, "222", "d")).toEqual([]);
    store.close();
  });
});
