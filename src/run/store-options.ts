import type { SecretBroker } from "../config/secret-broker.js";
import { storeRecorder } from "../decisions/record.js";
import type { RunStore, StoreOptions } from "./run-store.js";
export type { StoreOptions } from "./run-store.js";

/**
 * The one place the boot wiring builds a store's options (ADR 0015 + ADR 0030, Stage 4B spec §5): with the firewall armed
 * the redactor and the decision recorder travel together; cli.ts, the live gate and the rollback check all call this.
 */
export function storeOptionsFor(broker?: SecretBroker, env: NodeJS.ProcessEnv = process.env): StoreOptions {
  const decisionRecorder = (s: RunStore): ReturnType<typeof storeRecorder> => storeRecorder(s, { env });
  return broker ? { redact: broker.redact, decisionRecorder } : { decisionRecorder };
}
