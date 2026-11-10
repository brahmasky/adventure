/** Spec 2026-11-03 §4.1 (ADR 0031): every notification names a topic; the topic alone decides chat or the change log. */
export const TOPIC_ROUTE = {
  reply: "chat", run_report: "chat", approval: "chat", memory_card: "chat", rating_ask: "chat",
  urgent: "chat", idea_panel: "chat", self_write: "chat", budget_fuse: "chat", improve_card: "chat", jev_card: "chat", mail_card: "chat",
  model_card: "chat", incident_page: "chat", incident_reminder: "chat", incident_summary: "chat",
  model_change: "log", incident_log: "log", jev_notice: "log", decision_internal: "log", improve_log: "log", standing_log: "log", mail_log: "log", grow_log: "log"
} as const satisfies Record<string, "chat" | "log">;
export type NotificationTopic = keyof typeof TOPIC_ROUTE;
export type ChatTopic = { [K in NotificationTopic]: (typeof TOPIC_ROUTE)[K] extends "chat" ? K : never }[NotificationTopic];
export type LogTopic = Exclude<NotificationTopic, ChatTopic>;
export const isLogTopic = (t: NotificationTopic): t is LogTopic => TOPIC_ROUTE[t] === "log";
