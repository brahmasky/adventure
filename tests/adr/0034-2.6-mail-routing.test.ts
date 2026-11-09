/**
 * Rule: ADR 0034 rule 2.6 (spec 2026-11-09 §8.1): over tool input, `mail.triage`'s Jev rung may route one untrusted mail between two
 * code-owned lanes that both deliver it to Paco (a card now, or a listing in /inbox) — and nothing wider. The rule is behaviour, not
 * shape: (a) an `inbox` item is listed by /inbox with its "should have pinged" tap; (b) Paco's `always` rule beats a Jev `later`;
 * (c) a Jev `ping` writes the same outbox row as no Jev at all (so the only difference the rung can cause is `inbox`, a reversible,
 * listed delay of the item's own delivery); (d) `perItemRouting` refuses a state carrying a second item; (e) `entryProblems` passes
 * `mail.triage` and fails the three mutants the rule names. Rev 1.1: no mail text in `decisions`, `ledger_events` or `change_log`.
 * Changing this rule changes this test in the same commit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAIL_DOWN_BAR, MAIL_TRIAGE, MAIL_UP_BAR_P, perItemRouting, type MailTriageState } from "../../src/decisions/entries/mail-triage.js";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry } from "../../src/decisions/types.js";
import type { MailAsk } from "../../src/jev/mail-ask.js";
import { buildItemState, type GmailMetadata } from "../../src/mail/envelope.js";
import { inboxView } from "../../src/mail/inbox.js";
import { triageOne, type TriageDeps } from "../../src/mail/triage.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

const NOW = new Date("2026-11-09T02:00:00.000Z"); // 13:00 Sydney: not quiet hours
const EPOCH = "1970-01-01T00:00:00.000Z";
const SUBJECT = "Planted-Subject-QX7";
const FROM = "zed-planted@example.com";
const choice = (c: string, p: number) => ({ type: "choice" as const, choice: c, probabilities: { [c]: p }, confidence: p });
/** `kind` left undefined on purpose: the Jev-absent card has no kind either, so (c) compares like with like. */
const answer = (c: "now" | "later", p: number): MailAsk => ({ urgency: choice(c, p), kind: undefined, model: "jev-1.14.0" });
const DOWN: MailAsk = { failed: "outage", reason: "error" };

function meta(id = "m1"): GmailMetadata {
  return { id, threadId: `t-${id}`, snippet: "snippet text", labelIds: ["INBOX"], internalDate: String(NOW.getTime() - 60_000),
    payload: { headers: [{ name: "From", value: `Zed Planted <${FROM}>` }, { name: "Subject", value: SUBJECT }] } };
}
function deps(store: RunStore, ask: MailAsk | TriageDeps["ask"]): TriageDeps {
  return { store, chatId: "555", pacoAddress: "paco@example.com", env: { HOUGE_TELEGRAM_CHAT_ID: "555" }, now: () => NOW, brokerRedact: (s) => s,
    ask: typeof ask === "function" ? ask : async () => ask };
}
const items = (store: RunStore): { item_id: string; lane: string; reason_code: string }[] =>
  (store as any).db.prepare("SELECT item_id, lane, reason_code FROM mail_items ORDER BY gmail_message_id").all();
const realState = (): MailTriageState => ({ item: buildItemState(meta(), { item_id: "mi_1", known_sender: false, thread_pinged_6h: false, backfill: false, brokerRedact: (s) => s, now: NOW }), rule: null });
/** Item ids are random per store; the card's tap data carries one. */
const withoutIds = (payload: unknown): string => JSON.stringify(payload).replace(/mi_[0-9a-f-]+/g, "<item>");

describe("ADR 0034 rule 2.6: the two lanes both deliver to Paco", () => {
  it("(a) a Jev `later` item is listed by /inbox with its should-have-pinged tap", async () => {
    const store = RunStore.openInMemory();
    expect(await triageOne(deps(store, answer("later", 0.9)), meta(), { known_sender: false, backfill: false })).toMatchObject({ lane: "inbox", reason: "jev_later" });
    const [row] = items(store);
    const view = inboxView(store, 1, NOW);
    expect(view.text).toContain("Planted");
    expect(JSON.stringify(view.button_rows)).toContain(`mail:shp:${row!.item_id}`);
    expect(drainOutbox(store).size).toBe(0); // listed, never pushed
    store.close();
  });
  it("(b) Paco's `always` rule outranks a confident Jev `later`: stored ping, reason rule_always, Jev never asked", async () => {
    const store = RunStore.openInMemory();
    const ask = vi.fn(async () => answer("later", 0.99));
    store.upsertSenderRule({ rule_id: "r1", address: FROM, action: "always", source_item_id: null, created_at: NOW.toISOString() });
    expect(await triageOne(deps(store, ask), meta(), { known_sender: true, backfill: false })).toMatchObject({ lane: "ping", reason: "rule_always", notified: true });
    expect(items(store)[0]).toMatchObject({ lane: "ping", reason_code: "rule_always" });
    expect(ask).not.toHaveBeenCalled();
    expect([...drainOutbox(store).keys()]).toEqual(["mail:m1"]);
    store.close();
  });
  it("(c) a Jev `ping` writes the outbox row Jev-absent writes, apart from the `(Jev unavailable)` line", async () => {
    const jev = RunStore.openInMemory();
    const none = RunStore.openInMemory();
    expect(await triageOne(deps(jev, answer("now", 0.9)), meta(), { known_sender: false, backfill: false })).toMatchObject({ lane: "ping", reason: "jev_now" });
    expect(await triageOne(deps(none, DOWN), meta(), { known_sender: false, backfill: false })).toMatchObject({ lane: "ping", reason: "jev_unavailable" });
    const a = drainOutbox(jev).get("mail:m1") as { text: string };
    const b = drainOutbox(none).get("mail:m1") as { text: string };
    expect(b.text).toContain("\n(Jev unavailable)");
    expect(withoutIds({ ...b, text: b.text.replace("\n(Jev unavailable)", "") })).toBe(withoutIds(a));
    jev.close();
    none.close();
  });
  it("the bars the rule names: up at 0.6, down at 0.85", () => {
    expect(MAIL_UP_BAR_P).toBe(0.6);
    expect(MAIL_DOWN_BAR).toBe(0.85);
  });
});

describe("ADR 0034 rule 2.6 (d): perItemRouting is one item, two lanes", () => {
  it("accepts one item's state with a lane verdict", () => {
    expect(perItemRouting(realState(), "ping")).toBe(true);
    expect(perItemRouting(realState(), "inbox")).toBe(true);
  });
  it("refuses a state carrying a second item, an item with no id, and a verdict outside the two lanes", () => {
    const two = { ...realState(), items: [realState().item, { ...realState().item, item_id: "mi_2" }] } as unknown as MailTriageState;
    expect(perItemRouting(two, "ping")).toBe(false);
    expect(perItemRouting({ ...realState(), item: { ...realState().item, item_id: "" } }, "ping")).toBe(false);
    expect(perItemRouting(realState(), "drop")).toBe(false);
  });
});

describe("ADR 0034 rule 2.6 (e) and 2.5: the entryProblems arm", () => {
  const real = MAIL_TRIAGE as unknown as AnyEntry;
  const copy = (over: Record<string, unknown>): AnyEntry => ({ ...real, ...over }) as unknown as AnyEntry;
  it("passes mail.triage as registered", () => {
    expect(entryProblems(real)).toEqual([]);
  });
  it("fails a copy without the predicate, one with a third verdict, and one whose default and fail are the inbox lane", () => {
    expect(entryProblems(copy({ perItemRouting: undefined })).length).toBeGreaterThan(0);
    const effects = real.effects as Record<string, unknown>;
    expect(entryProblems(copy({ verdicts: ["ping", "inbox", "drop"], effects: { ...effects, drop: effects["inbox"] } })).length).toBeGreaterThan(0);
    expect(entryProblems(copy({ defaultVerdict: "inbox", fail: "inbox" })).length).toBeGreaterThan(0);
  });
});

describe("ADR 0034 rule 2.6: codes only outside mail_* tables (Rev 1.1)", () => {
  it("a planted subject and sender reach no decisions, ledger_events or change_log row", async () => {
    const store = RunStore.openInMemory();
    await triageOne(deps(store, answer("later", 0.9)), meta("m1"), { known_sender: false, backfill: false });
    await triageOne(deps(store, DOWN), meta("m2"), { known_sender: false, backfill: false });
    const db = (store as any).db;
    const decisions = JSON.stringify(store.listDecisionsBetween(EPOCH, "2999-01-01T00:00:00.000Z"));
    const ledger = JSON.stringify(db.prepare("SELECT event_type, payload_json, correlation_id FROM ledger_events").all());
    const log = JSON.stringify(store.listChangeLog(EPOCH, 50));
    expect(items(store)).toHaveLength(2);
    for (const planted of [SUBJECT, FROM, "Planted", "snippet text"]) {
      expect(decisions).not.toContain(planted);
      expect(ledger).not.toContain(planted);
      expect(log).not.toContain(planted);
    }
    store.close();
  });
});

const adr = readFileSync(join(import.meta.dirname, "..", "..", "docs", "decisions", "0034-decision-ladder-consolidated.md"), "utf8");
const rule = (id: string): string => { const at = adr.indexOf(`- ${id} `); expect(at).toBeGreaterThan(-1); const end = adr.indexOf("\n- ", at + 1); return adr.slice(at, end === -1 ? undefined : end); };
describe("ADR 0034 names the rule the code pins", () => {
  it("2.6 names perItemRouting, the inbox lane, both bars and the mail_jev_failing sweep check; 2.5 names both predicates; 6.1 names 2.6; the stage list has inbound", () => {
    expect(rule("2.6")).toMatch(/perItemRouting/); expect(rule("2.6")).toMatch(/`inbox`/); expect(rule("2.6")).toMatch(/0\.85/); expect(rule("2.6")).toMatch(/0\.6\b/);
    expect(rule("2.6")).toMatch(/mail_jev_failing/);
    expect(rule("2.5")).toMatch(/pacoWordsOnly/); expect(rule("2.5")).toMatch(/perItemRouting/);
    expect(rule("6.1")).toMatch(/2\.6/);
    expect(rule("1.1")).toMatch(/`inbound`/);
    expect(adr).toMatch(/\| `mail\.triage` \| `inbound` · `tool` \|[^\n]*\| 2\.6[^\n]*\|$/m);
  });
});
