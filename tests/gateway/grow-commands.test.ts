import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { formatGrowList, growStatusLines, handleGrow } from "../../src/gateway/grow-commands.js";
import type { RunStore } from "../../src/run/run-store.js";
import { CLEAN, growBody, growFields, growSetup } from "../helpers/grow.js";

const NOW = "2026-11-10T12:00:00.000Z";

function growEvent(program: string, key: string, reason?: string) {
  return buildTypedTaskEvent({
    source: "telegram", type: "grow", program, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: key, source_reference: `telegram:update:${key}`,
    ...(reason ? { metadata: { grow_reason: reason } } : {})
  });
}
/** Text of the newest queued `reply` notification. */
function lastReply(store: RunStore): string {
  const rows = (store as unknown as { db: { prepare(s: string): { all(): Array<{ payload_json: string }> } } }).db
    .prepare("SELECT payload_json FROM notification_outbox ORDER BY rowid DESC LIMIT 1").all();
  return (JSON.parse(rows[0]!.payload_json) as { text: string }).text;
}

describe("/grow", () => {
  it("lists live skills with origin and uses, marks the ones from outside content with how to clear them, and shows pending ones", async () => {
    const s = await growSetup();
    await s.live(growFields(), { ...CLEAN, level: "untrusted" });
    await s.svc.submit(growFields({ name: "second-skill", description: "a second skill used for the list test", body: growBody(40, " b") }), CLEAN);
    const text = formatGrowList(s.store, NOW);
    expect(text).toContain("**unit-convert** · from outside content · used 0×");
    expect(text).toContain("/grow trust unit-convert clears the mark");
    expect(text).toContain("**second-skill** · waiting for review");
  });

  it("says so when there is nothing yet", async () => {
    const s = await growSetup();
    expect(formatGrowList(s.store, NOW)).toBe("🌱 **Grow zone**\nNo skills yet.");
  });

  it("renders a Houge-written description as plain text, so it cannot place a link in Paco's chat", async () => {
    const s = await growSetup();
    await s.live(growFields({ description: "see [this](https://evil.example) when converting amounts" }));
    expect(formatGrowList(s.store, NOW)).not.toContain("](");
  });

  it("shows a failed review whatever its code, with the code in brackets", async () => {
    const s = await growSetup();
    await s.svc.submit(growFields(), CLEAN);
    const row = s.store.listGrowStaged("staged")[0]!;
    (s.store as unknown as { db: { prepare(q: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE grow_staged SET state = 'failed', code = 'publish_failed', findings_json = '[]', updated_at = ? WHERE id = ?").run("2026-11-10T11:00:00.000Z", row.id);
    expect(formatGrowList(s.store, NOW)).toContain("**unit-convert** · failed review (publish_failed)");
  });

  it("/grow trust clears the mark at once and says what it did", async () => {
    const s = await growSetup();
    await s.live(growFields(), { ...CLEAN, level: "untrusted" });
    handleGrow(s.store, growEvent("trust unit-convert", "tg:1"), NOW);
    expect(s.store.getGrowItem("unit-convert")?.origin).toBe("clean");
    expect(lastReply(s.store)).toBe("✅ unit-convert now reads as Houge's own. Reading it no longer marks the conversation.");
  });

  it("/grow trust on a skill that is not marked changes nothing and says so", async () => {
    const s = await growSetup();
    await s.live(growFields());
    handleGrow(s.store, growEvent("trust unit-convert", "tg:3"), NOW);
    expect(lastReply(s.store)).toBe("Nothing to clear: unit-convert is not a skill marked as outside content.");
  });

  it("/grow undo queues one request per Telegram update and answers that it is queued", async () => {
    const s = await growSetup();
    await s.live(growFields());
    const ev = growEvent("undo unit-convert", "tg:2", "wrong unit");
    handleGrow(s.store, ev, NOW);
    handleGrow(s.store, ev, "2026-11-10T12:00:05.000Z");
    expect(s.store.dueGrowRequests()).toMatchObject([{ kind: "undo", name: "unit-convert", reason: "wrong unit", chat_id: "555" }]);
    expect(lastReply(s.store)).toBe("⏳ Undoing unit-convert; I will confirm in a moment.");
    expect(await s.svc.runRequests()).toBe(1);
    expect(s.store.getGrowItem("unit-convert")?.state).toBe("removed");
  });

  it("/grow undo of a name that is not live queues nothing", async () => {
    const s = await growSetup();
    handleGrow(s.store, growEvent("undo nothing-here", "tg:4"), NOW);
    expect(s.store.dueGrowRequests()).toEqual([]);
    expect(lastReply(s.store)).toBe("No live skill of that name. /grow lists them.");
  });

  it("warns in /status about a review pending over a day, an orphan, and a paused write door, and is silent otherwise", async () => {
    const s = await growSetup();
    expect(growStatusLines(s.store, NOW)).toEqual([]);
    await s.svc.submit(growFields(), CLEAN);
    expect(growStatusLines(s.store, "2026-11-12T12:00:00.000Z")).toEqual(["Grow zone: 1 review pending over a day · /grow"]);
    s.store.openIncident({ kind: "grow_zone_unavailable", subject: "zone", detail: {}, now: "2026-11-12T12:00:00.000Z" });
    expect(growStatusLines(s.store, "2026-11-12T12:00:00.000Z")).toContain("Grow zone: writing is paused (the zone could not be written)");
  });

  it("a publish failure incident pauses writing whatever its subject", async () => {
    const s = await growSetup();
    s.store.openIncident({ kind: "grow_publish_failed", subject: "publish", detail: {}, now: NOW });
    expect(growStatusLines(s.store, NOW)).toEqual(["Grow zone: writing is paused (the zone could not be written)"]);
  });
});
