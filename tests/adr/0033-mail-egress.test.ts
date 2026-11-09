/**
 * Rule: ADR 0033 D2 as amended 2026-11-09 (spec 2026-11-09 §8.2, Paco's D3): the mail egress class for Jev is `MailJevState` and
 * nothing more — redacted sender name, sender address, known flag, redacted subject and snippet, labels, importance. Through the
 * real seam (`triageOne` → `askMail` → the Jev client) the request's state has exactly those seven keys, a planted code and link
 * token are absent from the serialised request, and mail writes no `jev_decisions` row (the `decisions` row carries the p).
 * Changing this rule changes this test in the same commit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { askMail } from "../../src/jev/mail-ask.js";
import type { GmailMetadata, MailJevState } from "../../src/mail/envelope.js";
import { triageOne, type TriageDeps } from "../../src/mail/triage.js";
import { RunStore } from "../../src/run/run-store.js";

const NOW = new Date("2026-11-09T02:00:00.000Z");
const CODE = "482913";
const LINK_TOKEN = "abcdef123456";
/** The seven keys of `MailJevState`, written out: a type alone cannot pin a runtime key set. */
const JEV_KEYS: ReadonlyArray<keyof MailJevState> = ["from_address", "from_name", "important", "known_sender", "labels", "snippet", "subject"];
const choice = (c: string) => ({ type: "choice" as const, choice: c, probabilities: { [c]: 0.9, other: 0.1 }, confidence: 0.9 });

const planted: GmailMetadata = { id: "m1", threadId: "t1", labelIds: ["INBOX", "IMPORTANT"], internalDate: String(NOW.getTime() - 60_000),
  snippet: `verify at https://example.com/v?t=${LINK_TOKEN} with ${CODE}`,
  payload: { headers: [{ name: "From", value: `Zed ${CODE} <zed@example.com>` }, { name: "Subject", value: `Your code is ${CODE}` }] } };

function capture(): { requests: JevRequest[]; client: (r: JevRequest) => Promise<JevResult> } {
  const requests: JevRequest[] = [];
  return { requests, client: async (r) => { requests.push(r); return { ok: true, model: "jev-1.14.0", answers: { mail_urgency: choice("now"), mail_kind: choice("action") }, input_tokens: 10, latency_ms: 5 }; } };
}

describe("ADR 0033 D2 (2026-11-09): the mail egress class is MailJevState", () => {
  it("the request a mail tick sends has exactly the seven keys, with the planted code and link token masked", async () => {
    const store = RunStore.openInMemory();
    const c = capture();
    const d: TriageDeps = { store, chatId: "555", pacoAddress: "paco@example.com", env: { HOUGE_TELEGRAM_CHAT_ID: "555" }, now: () => NOW, brokerRedact: (s) => s,
      ask: (state) => askMail({ state, client: c.client, store }) };
    expect(await triageOne(d, planted, { known_sender: false, backfill: false })).toMatchObject({ stored: true, lane: "ping", reason: "jev_now" });
    expect(c.requests).toHaveLength(1);
    const req = c.requests[0]!;
    expect(Object.keys(req.state as object).sort()).toEqual([...JEV_KEYS].sort());
    expect(Object.keys(req.questions).sort()).toEqual(["mail_kind", "mail_urgency"]);
    const wire = JSON.stringify(req);
    expect(wire).not.toContain(CODE);
    expect(wire).not.toContain(LINK_TOKEN);
    expect(wire).toContain("zed@example.com"); // D3 approves the sender address: the rule key
    expect(wire).not.toMatch(/thread|received_at|item_id|backfill/); // no time, presence, thread or id field
    expect((store as any).db.prepare("SELECT COUNT(*) AS n FROM jev_decisions").get().n).toBe(0);
    store.close();
  });
});

const adr = readFileSync(join(import.meta.dirname, "..", "..", "docs", "decisions", "0033-jev-system-one-consolidated.md"), "utf8");
describe("ADR 0033 names the rule the code pins", () => {
  it("D2 names MailJevState as the mail egress class; K says lane 4 is mail.triage; the outage wording names the mail_jev_failing sweep check", () => {
    const d2 = adr.slice(adr.indexOf("- **D2.**"), adr.indexOf("\n### E."));
    expect(d2).toMatch(/MailJevState/);
    const k = adr.slice(adr.indexOf("### K."), adr.indexOf("\n### L."));
    expect(k).toMatch(/mail\.triage/);
    expect(adr).toMatch(/mail_jev_failing/);
  });
});
