import { describe, expect, it } from "vitest";
import { createSecretBroker, REDACTED_PLACEHOLDER } from "../../src/config/secret-broker.js";
import { stableHash } from "../../src/domain/canonical.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

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
  const store = RunStore.openInMemory(redact ? { redact } : {});
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

/** Today's semantics, written out: redact, THEN trim, THEN cut at 3,900 with the truncation tail. */
const todays = (text: string, redact: (s: string) => string): string => {
  const t = redact(text).trim();
  return t.length <= MAX ? t : `${t.slice(0, MAX)}${TAIL}`;
};

interface OutboxRow { payload_json: string; payload_hash: string; state: string }
const outbox = (f: Fixture, run_id = f.run_id): OutboxRow[] =>
  db(f.store).prepare(`SELECT payload_json, payload_hash, state FROM notification_outbox WHERE run_id = ? AND intent_type = 'final_report'`).all(run_id) as unknown as OutboxRow[];
const chatTurns = (f: Fixture, run_id = f.run_id): string[] =>
  (db(f.store).prepare(`SELECT text FROM chat_turns WHERE run_id = ? AND role = 'assistant'`).all(run_id) as unknown as Array<{ text: string }>).map((r) => r.text);

/** Pins the outbox row (json, hash, state) of one wrapper call against the bytes today's code stores; returns the stored text. */
function pinRow(f: Fixture, w: Wrapper, input: string, redact: (s: string) => string): string {
  const expected = todays(input, redact);
  const rows = outbox(f);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload_json).toBe(JSON.stringify(payloadFor(w, expected)));
  expect(rows[0]!.payload_hash).toBe(stableHash(payloadFor(w, expected))); // the idempotency hash is over the REDACTED bytes
  expect(rows[0]!.state).toBe("queued");
  return expected;
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
/** each maskable value planted: at the start, at the end, twice, and at offset 2,000 of a 3,000-char text */
const plant = (v: string): Array<[string, string]> => [
  ["start", `${v} then some ordinary prose`], ["end", `ordinary prose then ${v}`], ["twice", `first ${v} middle ${v} last`],
  ["offset 2000 of 3000", pad(2000) + v + pad(3000 - 2000 - v.length)]
];

describe.each(WRAPPERS)("%s report — maskable class (firewall armed)", (w) => {
  const redact = fakeBroker().redact;
  it.each(MASKABLE.flatMap((v) => plant(v).map(([where, text]) => [v.slice(0, 8).replace(/\n/g, "\\n"), where, text] as const)))(
    "value %s planted at %s: the stored text holds the whole marker and none of the value",
    (_v, _where, text) => {
      const f = reportFixture(redact);
      const result = send(f, w, text);
      expect(result.status).toBe("queued");
      const stored = pinRow(f, w, text, redact);
      expect(stored).toContain(MARK);
      for (const secret of MASKABLE) expect(stored).not.toContain(secret);
      if (w === "evolution") expect(chatTurns(f)).toEqual([stored]); // the redacted text is what the assistant turn keeps too
      else expect(chatTurns(f)).toEqual([]);
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
    send(f, w, text);
    const stored = pinRow(f, w, text, redact);
    // the premise on the STORED bytes: x*3895 + "«reda" is followed directly by the truncation tail. Anything else is plain truncation and FAILS here.
    expect(stored).toBe(pad(3895) + "«reda" + TAIL);
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
    send(f, w, text);
    const stored = pinRow(f, w, text, redact);
    expect(stored).toBe(text);
    expect(stored).not.toContain(MARK);
    const hits = scan(f.store, [SHORT]);
    expect(hits).toEqual({ "notification_outbox.payload_json": 1, ...(w === "evolution" ? { "chat_turns.text": 1 } : {}) });
  });
});

describe.each(WRAPPERS)("%s report — firewall off", (w) => {
  it.each(MASKABLE.map((v) => [v.slice(0, 8).replace(/\n/g, "\\n"), v] as const))("value %s is stored raw (no redactor injected: byte-identical to the input)", (_n, v) => {
    const text = `before ${v} after`;
    const f = reportFixture();
    send(f, w, text);
    const stored = pinRow(f, w, text, (s) => s);
    expect(stored).toBe(text);
    expect(stored).not.toContain(MARK);
    if (w === "evolution") expect(chatTurns(f)).toEqual([text]);
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
    ["empty", ""], ["whitespace only", " \n\t  "], ["3,899 chars", pad(3899)], ["3,900 chars", pad(3900)], ["3,901 chars", pad(3901)]
  ])("%s: stored exactly as today (trim, then cut past 3,900), no marker", (_n, text) => {
    const f = reportFixture(redact);
    send(f, w, text);
    const stored = pinRow(f, w, text, redact);
    expect(stored).not.toContain(MARK);
    if (text.length === 3901) expect(stored).toBe(pad(3900) + TAIL);
    if (text.length === 3900) expect(stored).toBe(text); // the boundary: exactly 3,900 is NOT cut
    if (text.trim() === "") expect(stored).toBe("");
  });
});

describe("enqueue outcomes — the return value and the rows around the redacted text", () => {
  const redact = fakeBroker().redact;
  it.each(WRAPPERS)("%s: a duplicate re-enqueue of the same masked text returns `duplicate` and leaves one outbox row (and one chat turn)", (w) => {
    const f = reportFixture(redact);
    const text = `answer with ${V.kimi} inside`;
    expect(send(f, w, text).status).toBe("queued");
    const again = send(f, w, text);
    expect(again.status).toBe("duplicate");
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
