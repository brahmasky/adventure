import { describe, expect, it, vi } from "vitest";
import type { MailAsk } from "../../src/jev/mail-ask.js";
import type { GmailMetadata } from "../../src/mail/envelope.js";
import { triageOne, type TriageDeps } from "../../src/mail/triage.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §3.4: `perItemRouting` is a runtime gate with a call site. When it refuses (it should never), the item is stored
// `inbox`/`routing_refused`, its decision row is kept, no card goes out, and one decision_internal line is logged — inside the
// same transaction as the item. The gate is mocked here because no real state can make it refuse (its own file pins that).
vi.mock("../../src/decisions/entries/mail-triage.js", async (orig) => ({ ...(await orig<typeof import("../../src/decisions/entries/mail-triage.js")>()), perItemRouting: () => false }));

const NOW = new Date("2026-11-09T02:00:00.000Z");
const ask = async (): Promise<MailAsk> => ({ urgency: { type: "choice", choice: "now", probabilities: { now: 0.9 }, confidence: 0.9 }, kind: undefined, model: "jev-1.14.0" });
const m: GmailMetadata = { id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: String(NOW.getTime()), payload: { headers: [{ name: "From", value: "ann@example.com" }, { name: "Subject", value: "Hi" }] } };

describe("triageOne: routing refused", () => {
  it("stores inbox/routing_refused with its decision row, no card, one decision_internal log line", async () => {
    const store = RunStore.openInMemory();
    const d: TriageDeps = { store, chatId: "555", pacoAddress: "paco@example.com", env: {}, now: () => NOW, brokerRedact: (s) => s, ask };
    expect(await triageOne(d, m, { known_sender: true, backfill: false })).toEqual({ stored: true, lane: "inbox", reason: "routing_refused", notified: false });
    const row = (store as any).db.prepare("SELECT lane, reason_code, decision_id FROM mail_items").get();
    expect(row).toMatchObject({ lane: "inbox", reason_code: "routing_refused" });
    expect(row.decision_id).toMatch(/^dec_/);
    expect(drainOutbox(store).size).toBe(0);
    expect(store.listChangeLog("1970-01-01T00:00:00.000Z", 10).map((r) => [r.topic, r.text])).toEqual([["decision_internal", "mail.triage: routing refused for one item"]]);
    store.close();
  });
});
