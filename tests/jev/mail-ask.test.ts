import { describe, expect, it, vi } from "vitest";
import { askMail, MAIL_THRESHOLD_VERSION } from "../../src/jev/mail-ask.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";

const state = { from_name: "Ann", from_address: "ann@example.com", known_sender: true, subject: "Security alert", snippet: "new sign-in", labels: ["INBOX"], important: true };
const choice = (c: string) => ({ type: "choice" as const, choice: c, probabilities: { [c]: 1 }, confidence: 0.9 });
const answering = () => vi.fn(async (_req: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.14.0", input_tokens: 5, latency_ms: 5,
  answers: { mail_urgency: choice("now"), mail_kind: choice("risk") } }));

describe("askMail", () => {
  it("returns both answers and sends the seven-key state with both questions", async () => {
    const client = answering();
    const r = await askMail({ state, client, store: RunStore.openInMemory() });
    expect(r).toMatchObject({ urgency: { choice: "now" }, kind: { choice: "risk" }, model: "jev-1.14.0" });
    const req = client.mock.calls[0]![0];
    expect(Object.keys(req.state as object).sort()).toEqual(Object.keys(state).sort());
    expect(Object.keys(req.questions)).toEqual(["mail_urgency", "mail_kind"]);
  });
  it("an outage is a named failure", async () => {
    const r = await askMail({ state, client: async () => ({ ok: false, reason: "error", detail: "x", error_kind: "transport" }), store: RunStore.openInMemory() });
    expect(r).toMatchObject({ failed: "outage" });
  });
  it("writes no jev_decisions row", async () => {
    const store = RunStore.openInMemory();
    await askMail({ state, client: answering(), store });
    const n = (store as any).db.prepare("SELECT COUNT(*) AS n FROM jev_decisions").get().n;
    expect(n).toBe(0);
  });
  it("the threshold version is pinned", () => { expect(MAIL_THRESHOLD_VERSION).toBe("2026-11-09.1"); });
});
