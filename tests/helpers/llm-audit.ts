import type { LlmAttempt, LlmAuditSink } from "../../src/llm/audit.js";

/** A sink that discards everything — for tests that are not about telemetry. Tests only. */
export const UNAUDITED_TEST_SINK: LlmAuditSink = { record: () => {} };

/** A sink that captures attempts in order — for tests that ARE about telemetry. */
export function recordingSink(): LlmAuditSink & { attempts: LlmAttempt[] } {
  const attempts: LlmAttempt[] = [];
  return { attempts, record: (a) => attempts.push(a) };
}
