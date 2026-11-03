import type { ChatIntent, LogIntent } from "../../src/notifications/notification-types.js";

export const chatIntent = (p: Partial<ChatIntent> = {}): ChatIntent => ({ topic: "reply", target: { kind: "telegram", chat_id: "1" },
  intent_type: "progress", idempotency_key: "k", correlation_id: "c", payload: { text: "t" }, ...p });
export const logIntent = (p: Partial<LogIntent> = {}): LogIntent => ({ topic: "model_change", idempotency_key: "k", correlation_id: "c", text: "t", ...p });
