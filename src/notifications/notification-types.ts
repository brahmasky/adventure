import type { NotifyTarget } from "../domain/types.js";

export type NotificationIntentType =
  | "progress"
  | "final_report"
  | "approval_prompt"
  | "approval_resolved";

export interface NotificationIntent {
  target: NotifyTarget;
  intent_type: NotificationIntentType;
  idempotency_key: string;
  run_id?: string;
  approval_id?: string;
  correlation_id: string;
  payload: { text: string; [key: string]: unknown };
}
