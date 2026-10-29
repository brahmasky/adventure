import { describe, expect, it } from "vitest";
import { createSecretBroker } from "../../src/config/secret-broker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { decideSync } from "../../src/decisions/decide.js";
import { APPROVAL_BIND } from "../../src/decisions/entries/approval-bind.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { storeOptionsFor } from "../../src/run/store-options.js";

// Stage 4B spec §5: the redactor and the decision recorder travel together, so a store that redacts can also record the
// secret.redact decision from inside itself; a redactor without a recorder must not compile.
describe("storeOptionsFor", () => {
  it("with a broker, carries the broker's redactor and a recorder factory", () => {
    const broker = createSecretBroker({});
    const o = storeOptionsFor(broker, {});
    expect(o.redact).toBe(broker.redact);
    expect(typeof o.decisionRecorder).toBe("function");
  });

  it("without a broker, carries no redactor but still a recorder factory", () => {
    const o = storeOptionsFor(undefined, {});
    expect(o.redact).toBeUndefined();
    expect(typeof o.decisionRecorder).toBe("function");
  });

  it("a store opened with it writes one secret.redact masked row for a masked final report (the boot path's wiring)", () => {
    const secret = "sk-kimiFAKEvalue0123456789abcdefABCDEF";
    const store = RunStore.openInMemory(storeOptionsFor(createSecretBroker({ KIMI_API_KEY: secret } as NodeJS.ProcessEnv), {}));
    const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "hello", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "so:1", source_reference: "telegram:update:1:message:1" }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    store.enqueueFinalReportNotification(r.run_id, { text: `key ${secret}`, report_path: "/tmp/r.md" });
    const db = (store as unknown as { db: { prepare(q: string): { all(): Array<{ verdict: string; reason_code: string }> } } }).db;
    expect(db.prepare(`SELECT verdict, reason_code FROM decisions WHERE entry_id = 'secret.redact'`).all()).toEqual([{ verdict: "masked", reason_code: "final_report" }]);
    store.close();
  });

  it("a bare store has a no-op recorder (no row, no throw)", () => {
    const store = RunStore.openInMemory();
    const recorder = (store as unknown as { decisionRecorder: DecisionRecorder }).decisionRecorder;
    expect(decideSync(APPROVAL_BIND, { ok: true }, { run_id: null, recorder }).decisionId).toBeNull();
    store.close();
  });

  it("type pin: a redactor without a recorder does not compile", () => {
    if (false as boolean) {
      // @ts-expect-error — redact without a recorder must not compile (spec §5, senior B1)
      RunStore.openInMemory({ redact: (s: string) => s });
    }
  });
});
