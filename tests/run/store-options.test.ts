import { describe, expect, it } from "vitest";
import { createSecretBroker } from "../../src/config/secret-broker.js";
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

  it("a store opened with it holds a recorder that writes a decisions row", () => {
    const store = RunStore.openInMemory(storeOptionsFor(undefined, {}));
    const recorder = (store as unknown as { decisionRecorder: DecisionRecorder }).decisionRecorder;
    const result = decideSync(APPROVAL_BIND, { ok: true }, { run_id: null, recorder, tool_call_id: "tc_store_options" });
    expect(result.decisionId).not.toBeNull();
    const db = (store as unknown as { db: { prepare(q: string): { get(): { n: number } } } }).db;
    expect(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE entry_id = 'approval.bind'`).get().n).toBe(1);
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
