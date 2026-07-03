import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

/**
 * ⓪·2c U2 — the self-write reload marker: a single-row record of the last green merge,
 * written just before the restart and consumed exactly once by the next daemon boot.
 */
describe("RunStore reload marker", () => {
  it("write → consume returns the marker (with a stamped merged_at)", () => {
    const store = RunStore.openInMemory();
    try {
      store.writeReloadMarker({ sha: "abc1234def", subject: "fix clock", branch: "houge/selfwrite/run_1" });
      const marker = store.consumeReloadMarker();
      expect(marker).toMatchObject({
        sha: "abc1234def",
        subject: "fix clock",
        branch: "houge/selfwrite/run_1"
      });
      expect(marker!.merged_at).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("consume DELETES the marker — a second consume (second restart) is null/silent", () => {
    const store = RunStore.openInMemory();
    try {
      store.writeReloadMarker({ sha: "abc1234", subject: "s", branch: "b" });
      expect(store.consumeReloadMarker()).not.toBeNull();
      expect(store.consumeReloadMarker()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("returns null when no merge ever wrote a marker", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.consumeReloadMarker()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("is single-row: a newer merge overwrites an unconsumed marker", () => {
    const store = RunStore.openInMemory();
    try {
      store.writeReloadMarker({ sha: "old0000", subject: "first", branch: "b1", merged_at: "2026-07-01T00:00:00Z" });
      store.writeReloadMarker({ sha: "new1111", subject: "second", branch: "b2", merged_at: "2026-07-02T00:00:00Z" });
      const marker = store.consumeReloadMarker();
      expect(marker).toEqual({
        sha: "new1111",
        subject: "second",
        branch: "b2",
        merged_at: "2026-07-02T00:00:00Z"
      });
      expect(store.consumeReloadMarker()).toBeNull();
    } finally {
      store.close();
    }
  });
});
