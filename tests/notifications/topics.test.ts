import { describe, expect, it } from "vitest";
import { TOPIC_ROUTE, isLogTopic } from "../../src/notifications/topics.js";

describe("TOPIC_ROUTE (spec 2026-11-03 §4.1)", () => {
  it("routes exactly the background topics to the log", () => {
    const log = Object.entries(TOPIC_ROUTE).filter(([, r]) => r === "log").map(([t]) => t).sort();
    expect(log).toEqual(["decision_internal", "improve_log", "incident_log", "jev_notice", "mail_log", "model_change", "standing_log"]);
  });
  it("has no digest topic", () => {
    expect("digest" in TOPIC_ROUTE).toBe(false); // spec 2026-11-07: no digest topic
  });
  it("keeps every reply, report, approval, card and the storm summary in chat", () => {
    for (const t of ["reply", "run_report", "approval", "memory_card", "rating_ask", "urgent", "idea_panel", "self_write",
      "budget_fuse", "improve_job", "improve_card", "jev_card", "mail_card", "model_card", "incident_page", "incident_reminder", "incident_summary", "skill_reverify"] as const) {
      expect(TOPIC_ROUTE[t]).toBe("chat");
      expect(isLogTopic(t)).toBe(false);
    }
  });
});
