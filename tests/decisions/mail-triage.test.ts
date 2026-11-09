import { describe, expect, it } from "vitest";
import { decide } from "../../src/decisions/decide.js";
import {
  jevMailAnswer, MAIL_DOWN_BAR, MAIL_REASONS, MAIL_TRIAGE, MAIL_UP_BAR_P, mailFloors, perItemRouting, type MailTriageState
} from "../../src/decisions/entries/mail-triage.js";
import { ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import { afterStrictRecord, recordStrict } from "../../src/decisions/record.js";
import { entryById, entryProblems } from "../../src/decisions/registry.js";
import type { AnyDecideResult, AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";
import type { MailAsk } from "../../src/jev/mail-ask.js";
import type { JevChoiceAnswer } from "../../src/jev/jev-client.js";
import { HOUGE_GMAIL_ADDRESS, type MailItemState } from "../../src/mail/envelope.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-09 §3.4: floors first (own address, Paco's never/always rule, backfill), then Jev's urgency: ping at p >= 0.6, inbox only
// at p >= 0.85, everything between pings. Any Jev failure pings. ADR 0034 2.6: routing is per item, one call, one page.
const ITEM: MailItemState = { item_id: "mi_1", gmail_message_id: "g1", thread_id: "t1", from_address: "a@example.com", from_name: "A", known_sender: false,
  subject: "Hello", snippet: "hi", labels: [], important: false, received_at: "2026-11-09T10:00:00.000Z", thread_pinged_6h: false, backfill: false };
const st = (o: Partial<MailTriageState> = {}, i: Partial<MailItemState> = {}): MailTriageState => ({ item: { ...ITEM, ...i }, rule: null, ...o });
const choice = (top: string, p: number, rest: string): JevChoiceAnswer => ({ type: "choice", choice: top, probabilities: { [top]: p, [rest]: 1 - p }, confidence: p } as JevChoiceAnswer);
const ask = (top: "now" | "later", p: number, kind?: string): MailAsk => ({ urgency: choice(top, p, top === "now" ? "later" : "now"),
  kind: kind ? choice(kind, 0.9, "noise") : undefined, model: "jev-test" });

describe("the mail.triage entry", () => {
  it("is sound, registered, and in ENTRY_IDS", () => {
    expect(entryProblems(MAIL_TRIAGE as unknown as AnyEntry)).toEqual([]);
    expect(ENTRY_IDS).toContain("mail.triage");
    expect(entryById("mail.triage")).toBe(MAIL_TRIAGE as unknown as AnyEntry);
    expect([MAIL_UP_BAR_P, MAIL_DOWN_BAR]).toEqual([0.6, 0.85]);
    expect(MAIL_REASONS).toHaveLength(7);
  });
});

describe("mailFloors", () => {
  it("own address first: inbox even with an always rule", () => {
    expect(mailFloors(st({ rule: "always" }, { from_address: HOUGE_GMAIL_ADDRESS }))).toMatchObject({ verdict: "inbox", reason: "own_output" });
  });
  it("never -> inbox, always -> ping (over backfill), backfill without a rule -> inbox, else abstain", () => {
    expect(mailFloors(st({ rule: "never" }))).toMatchObject({ verdict: "inbox", reason: "rule_never" });
    expect(mailFloors(st({ rule: "always" }, { backfill: true }))).toMatchObject({ verdict: "ping", reason: "rule_always" });
    expect(mailFloors(st({}, { backfill: true }))).toMatchObject({ verdict: "inbox", reason: "backfill" });
    expect(mailFloors(st())).toEqual({ abstain: true });
  });
});

describe("jevMailAnswer", () => {
  it("now clears 0.6 to ping; below it, ping as unsure", () => {
    expect(jevMailAnswer(ask("now", 0.6))).toMatchObject({ verdict: "ping", reason: "jev_now", p: 0.6 });
    expect(jevMailAnswer(ask("now", 0.59))).toMatchObject({ verdict: "ping", reason: "jev_unsure" });
  });
  it("later needs 0.85 to file to the inbox; 0.84 pings as unsure", () => {
    expect(jevMailAnswer(ask("later", 0.85))).toMatchObject({ verdict: "inbox", reason: "jev_later", p: 0.85 });
    expect(jevMailAnswer(ask("later", 0.84))).toMatchObject({ verdict: "ping", reason: "jev_unsure", p: 0.84 });
  });
  it("carries the kind answer's choice, null when missing, and passes a failure through", () => {
    expect(jevMailAnswer(ask("now", 0.9, "risk"))).toMatchObject({ detail: { kind: "risk" } });
    expect(jevMailAnswer(ask("now", 0.9))).toMatchObject({ detail: { kind: null } });
    expect(jevMailAnswer({ failed: "timeout" })).toEqual({ failed: "timeout" });
  });
});

function capture(): { rec: DecisionRecorder; rows: AnyDecideResult[] } {
  const rows: AnyDecideResult[] = [];
  return { rows, rec: { record: (_e, r) => { rows.push(r); return null; } } };
}

describe("decide(mail.triage)", () => {
  it("an always-rule item records one result on the rule rung", async () => {
    const { rec, rows } = capture();
    const r = await decide(MAIL_TRIAGE, st({ rule: "always" }), { run_id: null, recorder: rec });
    expect(rows).toHaveLength(1);
    expect([r.verdict, r.rung, r.reason]).toEqual(["ping", "rule", "rule_always"]);
  });
  it("a Jev failure pings on the fail rung and names system_one", async () => {
    const { rec } = capture();
    const r = await decide(MAIL_TRIAGE, st(), { run_id: null, recorder: rec, exec: { system_one: async () => jevMailAnswer({ failed: "outage" }) } });
    expect([r.verdict, r.rung, r.fallbackRung]).toEqual(["ping", "fail", "system_one"]);
  });
  it("Jev later at 0.9 files to the inbox on the system_one rung", async () => {
    const { rec } = capture();
    const r = await decide(MAIL_TRIAGE, st(), { run_id: null, recorder: rec, exec: { system_one: async () => jevMailAnswer(ask("later", 0.9)) } });
    expect([r.verdict, r.rung, r.reason]).toEqual(["inbox", "system_one", "jev_later"]);
  });
});

describe("perItemRouting", () => {
  it("accepts ping and inbox for one item, refuses another verdict or an empty id", () => {
    expect(perItemRouting(st(), "ping")).toBe(true);
    expect(perItemRouting(st(), "inbox")).toBe(true);
    expect(perItemRouting(st(), "drop")).toBe(false);
    expect(perItemRouting(st({}, { item_id: "" }), "ping")).toBe(false);
  });
  it("refuses a state that carries more than the one item", () => {
    expect(perItemRouting({ ...st(), items: [ITEM, ITEM] } as unknown as MailTriageState, "inbox")).toBe(false);
    expect(perItemRouting({ ...st(), item: [ITEM] } as unknown as MailTriageState, "inbox")).toBe(false);
  });
});

describe("one call, one page", () => {
  it("three Jev-rung fallbacks within an hour open no decision_fallback incident for mail.triage", () => {
    const store = RunStore.openInMemory();
    const r = { verdict: "ping", rung: "fail", reason: null, fallbackReason: "outage", fallbackRung: "system_one", armedMode: "on", decisionId: null,
      walk: [], latencyMs: 1 } as unknown as AnyDecideResult;
    const e = MAIL_TRIAGE as unknown as AnyEntry;
    for (let k = 0; k < 3; k += 1) {
      const now = `2026-11-09T10:0${k}:00.000Z`;
      store.inTransaction(() => recordStrict(store, e, { ...r, fallbackReason: "outage" }, { run_id: null, tool_call_id: `mi_${k}` }, now));
      afterStrictRecord(store, e, r, now, {});
    }
    expect(store.listOpenIncidents().filter((i) => i.kind === "decision_fallback" && i.subject === "mail.triage")).toEqual([]);
    store.close();
  });
});
