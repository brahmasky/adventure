import { describe, expect, it } from "vitest";
import { buildItemState, jevStateOf, parseFrom, type GmailMetadata } from "../../src/mail/envelope.js";
import { HEADER_FIELD_CAP } from "../../src/capabilities/gmail-read.js";

const id = (s: string) => s;
const meta = (o: Partial<GmailMetadata> & { from?: string; subject?: string } = {}): GmailMetadata => ({
  id: "m1", threadId: "t1", ...(o.snippet !== undefined ? { snippet: o.snippet } : {}), ...(o.labelIds ? { labelIds: o.labelIds } : {}), internalDate: o.internalDate ?? "1762646400000",
  payload: { headers: [{ name: "From", value: o.from ?? "Ann <ann@example.com>" }, { name: "Subject", value: o.subject ?? "hello" }] }
});
const x = { item_id: "i1", known_sender: false, thread_pinged_6h: false, backfill: false, brokerRedact: id };

describe("parseFrom", () => {
  it("lower-cases the address and unquotes the name", () => {
    expect(parseFrom('"Ann Lee" <Ann.Lee@Example.com>')).toEqual({ address: "ann.lee@example.com", name: "Ann Lee" });
    expect(parseFrom("bob@example.com")).toEqual({ address: "bob@example.com", name: null });
  });
  it("an address failing the allowlist is invalid", () => {
    expect(parseFrom("x <a b@example.com>").address).toBe("invalid");
    expect(parseFrom("x <a@b@example.com>").address).toBe("invalid");
  });
});

describe("buildItemState", () => {
  it("masks codes and link tokens in subject, snippet and sender name", () => {
    const s = buildItemState(meta({ subject: "Your code is 482913", snippet: "go https://example.com/verify?token=abcdef123456 now", from: "Zed 482913 <z@example.com>" }), x);
    for (const t of [s.subject, s.snippet, s.from_name]) { expect(t).not.toContain("482913"); expect(t).not.toContain("abcdef123456"); }
  });
  it("caps a long subject at the shared header cap", () => {
    expect(HEADER_FIELD_CAP).toBe(200);
    const s = buildItemState(meta({ subject: "word ".repeat(100) }), x);
    expect(s.subject!.length).toBeLessThanOrEqual(210);
  });
  it("important iff IMPORTANT label; received_at is ISO from internalDate", () => {
    expect(buildItemState(meta({ labelIds: ["INBOX", "IMPORTANT"] }), x).important).toBe(true);
    expect(buildItemState(meta({ labelIds: ["INBOX"] }), x).important).toBe(false);
    expect(buildItemState(meta(), x).received_at).toBe(new Date(1762646400000).toISOString());
  });
});

describe("jevStateOf", () => {
  it("exposes exactly the seven keys", () => {
    const keys = Object.keys(jevStateOf(buildItemState(meta(), x))).sort();
    expect(keys).toEqual(["from_name", "from_address", "known_sender", "subject", "snippet", "labels", "important"].sort());
  });
});
