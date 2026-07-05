import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { createLedgerEvent } from "../../src/run/run-ledger.js";
import { createSecretBroker, REDACTED_PLACEHOLDER } from "../../src/config/secret-broker.js";

const SECRET = "kimi-secret-value-abcdef123456";
function redactor() {
  return createSecretBroker({ KIMI_API_KEY: SECRET } as NodeJS.ProcessEnv).redact;
}

/** Create a run with a Telegram notify target (so the enqueue seams have a target). */
function makeRun(store: RunStore, key: string): string {
  const intake = new Gateway(store).intake(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "hello",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: key,
      source_reference: `telegram:update:${key}`
    })
  );
  if (!intake.ok || intake.status !== "created") throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

describe("RunStore redaction seams (ADR 0015) — firewall ON masks secret VALUES on egress", () => {
  it("masks a secret value in an outbound REPLY (final report notification)", () => {
    const store = RunStore.openInMemory({ redact: redactor() });
    try {
      const run_id = makeRun(store, "t:reply");
      store.enqueueFinalReportNotification(run_id, {
        text: `Here is the answer. (leaked key ${SECRET})`,
        report_path: "/tmp/r.md"
      });
      const note = store.claimNextNotification("test", 30);
      expect(note!.payload.text).not.toContain(SECRET);
      expect(note!.payload.text).toContain(REDACTED_PLACEHOLDER);
    } finally {
      store.close();
    }
  });

  it("masks a secret value in an ERROR reply (failure notification)", () => {
    const store = RunStore.openInMemory({ redact: redactor() });
    try {
      const run_id = makeRun(store, "t:error");
      store.enqueueFailureNotification(run_id, `I hit an error on that one: boom with ${SECRET}`);
      const note = store.claimNextNotification("test", 30);
      expect(note!.payload.text).not.toContain(SECRET);
      expect(note!.payload.text).toContain(REDACTED_PLACEHOLDER);
    } finally {
      store.close();
    }
  });

  it("masks a secret value in a LEDGER payload free-text field (the single append seam)", () => {
    const store = RunStore.openInMemory({ redact: redactor() });
    try {
      const run_id = makeRun(store, "t:ledger");
      store.appendLedgerEvent(
        createLedgerEvent({
          run_id,
          correlation_id: run_id,
          event_type: "web_search_performed",
          actor: "core",
          sequence: 999,
          payload: { query: `search for ${SECRET}`, provider: "tavily", source_urls: [`https://x/${SECRET}`] }
        })
      );
      const events = store.getLedgerEvents(run_id);
      const evt = events.find((e) => e.event_type === "web_search_performed")!;
      expect(evt.payload.query).not.toContain(SECRET);
      expect(evt.payload.query).toContain(REDACTED_PLACEHOLDER);
      // Deep redaction reaches array elements too.
      expect((evt.payload.source_urls as string[])[0]).not.toContain(SECRET);
    } finally {
      store.close();
    }
  });
});

describe("RunStore redaction — firewall OFF is byte-identical (no redactor injected)", () => {
  it("leaves the reply text exactly as written when no redactor is present", () => {
    const store = RunStore.openInMemory(); // no redact option → identity
    try {
      const run_id = makeRun(store, "t:off");
      const text = `answer with a value ${SECRET} that is NOT masked when firewall is OFF`;
      store.enqueueFinalReportNotification(run_id, { text, report_path: "/tmp/r.md" });
      const note = store.claimNextNotification("test", 30);
      expect(note!.payload.text).toBe(text);
    } finally {
      store.close();
    }
  });
});
