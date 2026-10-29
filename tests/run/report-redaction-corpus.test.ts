import { describe, expect, it, vi } from "vitest";
import { createSecretBroker, REDACTED_PLACEHOLDER } from "../../src/config/secret-broker.js";
import { stableHash } from "../../src/domain/canonical.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { storeOptionsFor } from "../../src/run/store-options.js";

// Stage 4B Task 1: the report redaction classes, pinned BEFORE redact-then-truncate moves behind `secret.redact` (spec §2.2 R1, §6 item 5).
// The live corpus has zero `«redacted»` rows, so it cannot tell a working redactor from a no-op: these are seeded, with fake values.
const MARK = REDACTED_PLACEHOLDER;
const TAIL = "\n\n… (truncated)";
const MAX = 3900;

const V = {
  telegram: "123456789:AA" + "bcdEFGhijKLMnopQRstuVWxyz0123456".padEnd(33, "x").slice(0, 33),
  kimi: "sk-kimiFAKEvalue0123456789abcdefABCDEF",
  gemini: "AIzaFAKEgeminiValue0123456789abcdefghij",
  gmailRefresh: "1//0gFAKErefreshTokenValue0123456789",
  typesafe: "0123456789abcdef".repeat(4),
  tavily: "tvly-$^*+?.()[]{}|\\-FAKEvalue",
  firecrawl: "kimiFAKEvalue0123", // a substring of the Kimi value (>= 6 chars)
  gmailClientSecret: "short", // 5 chars: below MIN_REDACTABLE_SECRET_LENGTH, must NOT mask
  claudeOauth: "oauthLine1FAKE\noauthLine2FAKE0123"
} as const;
const MASKABLE = [V.telegram, V.kimi, V.gemini, V.gmailRefresh, V.typesafe, V.tavily, V.firecrawl, V.claudeOauth];
const SHORT = V.gmailClientSecret;

/** createSecretBroker over nine fake env values with the shapes of spec §6 item 5. */
function fakeBroker() {
  return createSecretBroker({
    HOUGE_TELEGRAM_BOT_TOKEN: V.telegram, KIMI_API_KEY: V.kimi, GEMINI_API_KEY: V.gemini, HOUGE_GMAIL_REFRESH_TOKEN: V.gmailRefresh,
    TYPESAFE_API_KEY: V.typesafe, TAVILY_API_KEY: V.tavily, FIRECRAWL_API_KEY: V.firecrawl, HOUGE_GMAIL_CLIENT_SECRET: V.gmailClientSecret,
    CLAUDE_CODE_OAUTH_TOKEN: V.claudeOauth
  } as NodeJS.ProcessEnv);
}

let seq = 0;
/** A store (firewall armed when `redact` is given) plus a Telegram-targeted run per call of `newRun`. */
function reportFixture(redact?: (s: string) => string) {
  const store = RunStore.openInMemory(redact ? storeOptionsFor(fakeBroker(), {}) : {}); // armed = the boot wiring: redactor + real recorder
  const newRun = (): string => {
    const n = ++seq;
    const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "hello", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `redact:${n}`, source_reference: `telegram:update:${n}:message:1` }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.run_id;
  };
  return { store, newRun, run_id: newRun() };
}
type Fixture = ReturnType<typeof reportFixture>;
interface Db { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; exec(sql: string): void }
const db = (s: RunStore): Db => s["db"] as unknown as Db;

const WRAPPERS = ["final", "failure", "evolution"] as const;
type Wrapper = (typeof WRAPPERS)[number];
const send = (f: Fixture, w: Wrapper, text: string, run_id = f.run_id) =>
  w === "final" ? f.store.enqueueFinalReportNotification(run_id, { text, report_path: "/tmp/r.md" })
    : w === "failure" ? f.store.enqueueFailureNotification(run_id, text)
    : f.store.enqueueEvolutionReportNotification(run_id, "self_write_propose", { text });
/** What the wrapper puts into the outbox payload for a given stored text (the payload shapes of enqueue*Notification). */
const payloadFor = (w: Wrapper, text: string): Record<string, unknown> => w === "final" ? { text, report_path: "/tmp/r.md" } : { text };

/** Wrapper results with the unstable parts normalised (ids, run id, timestamps), so the whole NotificationQueueResult can be pinned. */
const norm = (v: unknown, run_id: string): unknown =>
  JSON.parse(JSON.stringify(v).split(run_id).join("RUN").replace(/notif_[0-9a-f-]+/g, "NID").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "T"));
const expectedResult = (w: Wrapper, status: "queued" | "duplicate", stored: string): unknown => ({
  status,
  record: {
    notification_id: "NID", target: { kind: "telegram", chat_id: "555" }, target_key: "telegram:555", intent_type: "final_report",
    idempotency_key: w === "evolution" ? "RUN:evolution_report:self_write_propose" : "RUN:final_report", state: "queued", attempt_count: 0, next_attempt_at: "T",
    lease_owner: null, lease_expires_at: null, provider_message_id: null, run_id: "RUN", approval_id: null, correlation_id: "RUN",
    payload: payloadFor(w, stored), payload_hash: stableHash(payloadFor(w, stored)), created_at: "T", updated_at: "T"
  }
});

interface OutboxRow { payload_json: string; payload_hash: string; state: string }
const outbox = (f: Fixture, run_id = f.run_id): OutboxRow[] =>
  db(f.store).prepare(`SELECT payload_json, payload_hash, state FROM notification_outbox WHERE run_id = ? AND intent_type = 'final_report'`).all(run_id) as unknown as OutboxRow[];
const chatTurns = (f: Fixture, run_id = f.run_id): string[] =>
  (db(f.store).prepare(`SELECT text FROM chat_turns WHERE run_id = ? AND role = 'assistant'`).all(run_id) as unknown as Array<{ text: string }>).map((r) => r.text);

/**
 * Pins one wrapper call against bytes the TEST wrote by hand (never derived from the redactor under test): the outbox row (json, hash,
 * state), the full return value (ids normalised) and, for the evolution wrapper, the assistant chat turn.
 */
function pinRow(f: Fixture, w: Wrapper, result: unknown, expected: string): void {
  const rows = outbox(f);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload_json).toBe(JSON.stringify(payloadFor(w, expected)));
  expect(rows[0]!.payload_hash).toBe(stableHash(payloadFor(w, expected))); // the idempotency hash is over the REDACTED bytes
  expect(rows[0]!.state).toBe("queued");
  expect(norm(result, f.run_id)).toEqual(expectedResult(w, "queued", expected));
  expect(chatTurns(f)).toEqual(w === "evolution" ? [expected] : []);
}

/** Counts, over every TEXT column of every table, the rows that contain `needle`; keyed "table.column". */
function scan(store: RunStore, values: readonly string[]): Record<string, number> {
  // payload_json stores the value JSON-escaped (a newline, a backslash): scan for that spelling too, or a leak there would go unseen
  const needles = [...new Set(values.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]))];
  const hits: Record<string, number> = {};
  const tables = db(store).prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as unknown as Array<{ name: string }>;
  for (const { name } of tables) {
    const cols = db(store).prepare(`PRAGMA table_info("${name}")`).all() as unknown as Array<{ name: string; type: string }>;
    for (const c of cols.filter((x) => /TEXT|CHAR|CLOB|^$/i.test(x.type))) {
      for (const needle of needles) {
        const n = (db(store).prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE instr(CAST("${c.name}" AS TEXT), ?) > 0`).get(needle) as { n: number }).n;
        if (n > 0) hits[`${name}.${c.name}`] = (hits[`${name}.${c.name}`] ?? 0) + n;
      }
    }
  }
  return hits;
}

const pad = (n: number, ch = "x"): string => ch.repeat(n);
/** each maskable value planted: at the start, at the end, twice, and at offset 2,000 of a 3,000-char text; the expected bytes are written out by hand */
const plant = (v: string): Array<[string, string, string]> => {
  const rest = pad(3000 - 2000 - v.length);
  return [
    ["start", `${v} then some ordinary prose`, `${MARK} then some ordinary prose`],
    ["end", `ordinary prose then ${v}`, `ordinary prose then ${MARK}`],
    ["twice", `first ${v} middle ${v} last`, `first ${MARK} middle ${MARK} last`],
    ["offset 2000 of 3000", pad(2000) + v + rest, pad(2000) + MARK + rest]
  ];
};

describe.each(WRAPPERS)("%s report — maskable class (firewall armed)", (w) => {
  const redact = fakeBroker().redact;
  it.each(MASKABLE.flatMap((v) => plant(v).map(([where, text, expected]) => [v.slice(0, 8).replace(/\n/g, "\\n"), where, text, expected] as const)))(
    "value %s planted at %s: the stored text holds the whole marker and none of the value",
    (_v, _where, text, expected) => {
      const f = reportFixture(redact);
      pinRow(f, w, send(f, w, text), expected);
      expect(expected).toContain(MARK);
      // a hit here is a real leak in today's code, not a wrong pin: STOP and report the table.column
      expect(scan(f.store, MASKABLE)).toEqual({});
    }
  );
});

describe.each(WRAPPERS)("%s report — cut boundary (marker straddles char 3,900)", (w) => {
  const redact = fakeBroker().redact;
  const text = pad(3895) + V.kimi + " tail"; // no leading whitespace: trim() cannot shift the index
  it("asserts its own premise, then pins the exact stored bytes: the cut SPLITS the marker, as today", () => {
    // premise: after redaction the 10-char marker starts at 3,895, so slice(0, 3900) keeps only its first 5 chars
    const redacted = redact(text);
    expect(redacted.indexOf(MARK)).toBe(3895);
    expect(MARK).toHaveLength(10);
    expect(redacted.trim()).toBe(redacted);
    const f = reportFixture(redact);
    const stored = pad(3895) + "«reda" + TAIL; // written by hand: redact -> trim -> cut at 3,900
    pinRow(f, w, send(f, w, text), stored);
    // the premise on the STORED bytes: x*3895 + "«reda" is followed directly by the truncation tail. Anything else is plain truncation and FAILS here.
    expect(outbox(f).map((r) => (JSON.parse(r.payload_json) as { text: string }).text)).toEqual([stored]);
    expect(stored.startsWith(pad(3895) + "«reda" + "\n\n… (truncated)")).toBe(true);
    expect(stored).not.toContain(MARK); // the whole marker is NOT present: the truncation tore it
    for (const secret of MASKABLE) expect(stored).not.toContain(secret);
    expect(scan(f.store, MASKABLE)).toEqual({});
  });
});

describe.each(WRAPPERS)("%s report — short-value control", (w) => {
  it("a 5-char value is below MIN_REDACTABLE_SECRET_LENGTH: it is NOT masked and is present in the stored text and nowhere else", () => {
    const redact = fakeBroker().redact;
    const text = `the short ${SHORT} value, twice ${SHORT}`;
    const f = reportFixture(redact);
    pinRow(f, w, send(f, w, text), text);
    const hits = scan(f.store, [SHORT]);
    expect(hits).toEqual({ "notification_outbox.payload_json": 1, ...(w === "evolution" ? { "chat_turns.text": 1 } : {}) });
  });
});

describe.each(WRAPPERS)("%s report — firewall off", (w) => {
  it.each(MASKABLE.map((v) => [v.slice(0, 8).replace(/\n/g, "\\n"), v] as const))("value %s is stored raw (no redactor injected: byte-identical to the input)", (_n, v) => {
    const text = `before ${v} after`;
    const f = reportFixture();
    pinRow(f, w, send(f, w, text), text);
  });
  it("the scan sees the planted values (a scan that finds nothing proves nothing): exactly the outbox payload, plus the chat turn on the evolution wrapper", () => {
    const text = `leak ${V.kimi} and ${V.telegram}`;
    const f = reportFixture();
    send(f, w, text);
    const hits = scan(f.store, [V.kimi, V.telegram]);
    // two needles, each in the outbox row; the evolution wrapper's chat turn adds one hit per needle
    expect(hits).toEqual({ "notification_outbox.payload_json": 2, ...(w === "evolution" ? { "chat_turns.text": 2 } : {}) });
  });
});

describe.each(WRAPPERS)("%s report — clean texts", (w) => {
  const redact = fakeBroker().redact;
  it.each([
    ["empty", "", ""], ["whitespace only", " \n\t  ", ""], ["3,899 chars", pad(3899), pad(3899)], ["3,900 chars", pad(3900), pad(3900)],
    ["3,901 chars", pad(3901), pad(3900) + TAIL]
  ])("%s: stored exactly as written by hand (trim, then cut past 3,900), no marker", (_n, text, expected) => {
    const f = reportFixture(redact);
    pinRow(f, w, send(f, w, text), expected);
  });
});

describe("enqueue outcomes — the return value and the rows around the redacted text", () => {
  const redact = fakeBroker().redact;
  it.each(WRAPPERS)("%s: a duplicate re-enqueue of the same masked text returns `duplicate` and leaves one outbox row (and one chat turn)", (w) => {
    const f = reportFixture(redact);
    const text = `answer with ${V.kimi} inside`;
    const expected = `answer with ${MARK} inside`;
    pinRow(f, w, send(f, w, text), expected);
    expect(norm(send(f, w, text), f.run_id)).toEqual(expectedResult(w, "duplicate", expected));
    expect(outbox(f)).toHaveLength(1);
    expect(chatTurns(f)).toHaveLength(w === "evolution" ? 1 : 0);
  });
  it.each(WRAPPERS)("%s: the same key with different text is a `conflict`, and the first row is untouched", (w) => {
    const f = reportFixture(redact);
    expect(send(f, w, `first ${V.kimi}`).status).toBe("queued");
    const before = outbox(f);
    expect(send(f, w, "a different report")).toEqual({ status: "conflict", error: "NOTIFICATION_IDEMPOTENCY_CONFLICT" });
    expect(outbox(f)).toEqual(before);
  });
  it("the masked retry is `duplicate`, not `conflict`: the idempotency hash is over the redacted bytes, so a retry of the same raw text matches", () => {
    const f = reportFixture(redact);
    const text = `value ${V.gemini} here`;
    send(f, "final", text);
    expect(send(f, "final", text).status).toBe("duplicate");
  });
  it.each(WRAPPERS)("%s: an insert failure throws the store's error and writes no outbox row", (w) => {
    const f = reportFixture(redact);
    db(f.store).exec(`CREATE TRIGGER t BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'boom'); END`);
    expect(() => send(f, w, `report ${V.kimi}`)).toThrow(/boom/);
    expect(outbox(f)).toEqual([]);
    expect(chatTurns(f)).toEqual([]);
  });
  it.each(WRAPPERS)("%s: inside a caller's transaction a ROLLBACK removes the outbox row (the wrapper opens no transaction of its own)", (w) => {
    const f = reportFixture(redact);
    db(f.store).exec("BEGIN");
    expect(send(f, w, `report ${V.kimi}`).status).toBe("queued");
    db(f.store).exec("ROLLBACK");
    expect(outbox(f)).toEqual([]);
    expect(chatTurns(f)).toEqual([]);
  });
});

// Stage 4B Task 5: each masking attempt is one secret.redact row; the stored bytes above did not move.
interface RedactRow { verdict: string; reason_code: string | null; run_id: string | null; tool_call_id: string | null; rung: string; armed_mode: string }
const rows = (f: Fixture): RedactRow[] =>
  db(f.store).prepare(`SELECT verdict, reason_code, run_id, tool_call_id, rung, armed_mode FROM decisions WHERE entry_id = 'secret.redact' ORDER BY created_at, decision_id`).all() as unknown as RedactRow[];
const SEAM: Record<Wrapper, string> = { final: "final_report", failure: "failure_report", evolution: "evolution_report" };
const masked = (w: Wrapper, run_id: string): RedactRow => ({ verdict: "masked", reason_code: SEAM[w], run_id, tool_call_id: null, rung: "rule", armed_mode: "on" });

describe.each(WRAPPERS)("%s report — secret.redact decision rows", (w) => {
  const redact = fakeBroker().redact;
  it("a masked report writes exactly one `masked` row: reason = the seam, run_id set, tool_call_id null, and no text", () => {
    const f = reportFixture(redact);
    send(f, w, `answer ${V.kimi} end`);
    expect(rows(f)).toEqual([masked(w, f.run_id)]);
    expect(scan(f.store, MASKABLE)).toEqual({});
  });
  it("a secret masked at the cut boundary still counts: one row", () => {
    const f = reportFixture(redact);
    send(f, w, pad(3895) + V.kimi + " tail");
    expect(rows(f)).toEqual([masked(w, f.run_id)]);
  });
  it("clean text, a below-minimum value and an over-long clean report write no row (clean is the default verdict)", () => {
    const f = reportFixture(redact);
    send(f, w, `the short ${SHORT} value`);
    const g = reportFixture(redact);
    send(g, w, pad(3901));
    expect(rows(f)).toEqual([]);
    expect(rows(g)).toEqual([]);
  });
  it("firewall off: no redactor, no decision, same stored bytes", () => {
    const f = reportFixture();
    send(f, w, `leak ${V.kimi}`);
    expect(rows(f)).toEqual([]);
  });
  it("a duplicate re-enqueue is a second attempt: a second row, still one outbox row", () => {
    const f = reportFixture(redact);
    const text = `answer ${V.kimi}`;
    send(f, w, text);
    expect(send(f, w, text).status).toBe("duplicate");
    expect(rows(f)).toEqual([masked(w, f.run_id), masked(w, f.run_id)]);
    expect(outbox(f)).toHaveLength(1);
  });
  it("a conflict adds a row for its masked text and returns the same conflict", () => {
    const f = reportFixture(redact);
    send(f, w, `first ${V.kimi}`);
    expect(send(f, w, `second ${V.gemini}`)).toEqual({ status: "conflict", error: "NOTIFICATION_IDEMPOTENCY_CONFLICT" });
    expect(rows(f)).toHaveLength(2);
  });
  it("an insert failure keeps the attempt's row and throws the same error", () => {
    const f = reportFixture(redact);
    db(f.store).exec(`CREATE TRIGGER t BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'boom'); END`);
    expect(() => send(f, w, `report ${V.kimi}`)).toThrow(/boom/);
    expect(rows(f)).toEqual([masked(w, f.run_id)]);
    expect(outbox(f)).toEqual([]);
  });
  it("inside a caller's transaction a ROLLBACK removes the decision row with the outbox row", () => {
    const f = reportFixture(redact);
    db(f.store).exec("BEGIN");
    send(f, w, `report ${V.kimi}`);
    db(f.store).exec("ROLLBACK");
    expect(rows(f)).toEqual([]);
    expect(outbox(f)).toEqual([]);
  });
  it("recursion pin: a recorder that cannot insert opens one decision_record_failed incident and the masked report is still enqueued", () => {
    const f = reportFixture(redact);
    db(f.store).exec(`CREATE TRIGGER r BEFORE INSERT ON decisions WHEN NEW.entry_id = 'secret.redact' BEGIN SELECT RAISE(ABORT,'nope'); END`);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const expected = `answer ${MARK} end`;
      pinRow(f, w, send(f, w, `answer ${V.kimi} end`), expected);
      const open = f.store.listOpenIncidents().filter((i) => i.kind === "decision_record_failed");
      expect(open.map((i) => i.subject)).toEqual(["secret.redact"]);
      expect(rows(f)).toEqual([]);
    } finally { err.mockRestore(); }
  });
});
