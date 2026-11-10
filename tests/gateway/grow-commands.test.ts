import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { formatGrowList, growStatusLines, handleGrow } from "../../src/gateway/grow-commands.js";
import type { RunStore } from "../../src/run/run-store.js";
import { GROW_ITEMS_MAX } from "../../src/grow/service.js";
import { markdownToTelegramHtml } from "../../src/telegram/markdown-to-telegram-html.js";
import { CLEAN, growBody, growFields, growSetup, outboxTexts, PASS } from "../helpers/grow.js";

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

  it("renders every description as one inline-code span: no link, command or mention in it can be tapped", async () => {
    const s = await growSetup();
    const desc = "see [a](https://evil.example) then https://evil.example/x or evil.example, run /kill, ping @x, tag #x";
    await s.live(growFields({ description: desc }));
    const text = formatGrowList(s.store, NOW);
    const html = markdownToTelegramHtml(text);
    expect(html).not.toContain("<a ");
    const spans = [...html.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1]!);
    const mine = spans.find((c) => c.includes("evil"))!;
    expect(mine).toBeDefined();
    expect(html.replace(mine, "")).not.toContain("/kill");
    // the adapter resends plain text on a send error, and plain text auto-links: the text itself must be link-free
    for (const bad of ["://", "evil.example", "/kill", "@x", "#x"]) { expect(text).not.toContain(bad); expect(html).not.toContain(bad); }
  });

  it("stops at whole entries under the message bound and says how many it left out", async () => {
    const s = await growSetup();
    for (let i = 0; i < 200; i++) {
      s.store.upsertGrowItem({ name: `skill-${i}`, state: "live", origin: "clean", description: `d${i} ${"x".repeat(190)}`, example: "x", head_commit: null, content_hash: "h", body_hash: "b" }, NOW);
    }
    const text = formatGrowList(s.store, NOW);
    const m = /… and (\d+) more — run houge grow list on the Mac/.exec(text);
    expect(m).not.toBeNull();
    const shown = (text.match(/\*\*skill-\d+\*\*/g) ?? []).length;
    expect(shown + Number(m![1])).toBe(200);
    expect(shown).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(3800 + 120);
    for (const line of text.split("\n")) expect((line.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it("lists a row being published as publishing, not as waiting for review", async () => {
    const s = await growSetup();
    await s.svc.submit(growFields(), CLEAN);
    s.store.patchGrowStaged(s.store.listGrowStaged("staged")[0]!.id, { state: "publishing" }, NOW);
    const text = formatGrowList(s.store, NOW);
    expect(text).toContain("**unit-convert** · publishing");
    expect(text).not.toContain("waiting for review");
  });

  it("labels and hints by the mark, not by the stored origin", async () => {
    const s = await growSetup();
    await s.live(growFields());
    s.store.markGrowName("unit-convert", NOW);                                   // marked while its origin still reads clean
    let text = formatGrowList(s.store, NOW);
    expect(text).toContain("**unit-convert** · from outside content");
    expect(text).toContain("/grow trust unit-convert clears the mark");
    s.store.unmarkGrowName("unit-convert");
    s.store.setGrowItemOrigin("unit-convert", "untrusted", NOW);                 // origin says untrusted, no mark: reading it taints nothing
    text = formatGrowList(s.store, NOW);
    expect(text).toContain("**unit-convert** · written by Houge");
    expect(text).not.toContain("/grow trust");
  });

  it("lists a failed row whatever its code (zone_full), and a review failure with its findings", async () => {
    const s = await growSetup();
    const fill = (i: number) => s.store.upsertGrowItem({ name: `filler-${i}`, state: "live", origin: "clean", description: `filler number ${i} for the cap test`, example: "an example", head_commit: null, content_hash: `h${i}`, body_hash: `b${i}` }, "2026-11-10T09:00:00.000Z");
    for (let i = 0; i < GROW_ITEMS_MAX - 1; i++) fill(i);
    await s.svc.submit(growFields({ name: "cap-victim", description: "a skill that loses the race for the last slot" }), CLEAN);
    await s.svc.submit(growFields({ name: "bad-steps", description: "a skill whose steps the reviewer rejects", body: growBody(40, " c") }), CLEAN);
    const idOf = (name: string) => s.store.listGrowStaged("staged").find((r) => r.name === name)!.id;
    s.svc.recordReview(idOf("bad-steps"), { ...PASS, pass: false, code: "review_failed", findings: [{ step: "3", problem: "says to [click](https://evil.example)" }] });
    s.svc.recordReview(idOf("cap-victim"), PASS);
    fill(GROW_ITEMS_MAX - 1);                                                    // the zone fills while the approved row waits
    expect(await s.svc.publishStaged(s.store.listGrowStaged("approved")[0]!.id)).toBe("failed");
    const text = formatGrowList(s.store, NOW);
    expect(text).toContain("**cap-victim** · failed (zone_full)");
    expect(text).toContain("**bad-steps** · failed (review_failed)\n`step 3: says to [click](https:∕∕evil․example)`");   // defanged: link-free in plain text too
    expect(text).not.toContain("failed review");
  });

  it("does not list a superseded row, and drops a failed row after 14 days", async () => {
    const s = await growSetup();
    await s.svc.submit(growFields(), CLEAN);
    await s.svc.submit(growFields({ body: growBody(40, " newer") }), CLEAN);       // the first row is now failed/superseded
    expect(s.store.listGrowStaged("failed").map((r) => r.code)).toEqual(["superseded"]);
    expect(formatGrowList(s.store, NOW)).not.toContain("superseded");
    s.svc.recordReview(s.store.listGrowStaged("staged")[0]!.id, { ...PASS, pass: false, code: "review_failed", findings: [] });
    expect(formatGrowList(s.store, "2026-11-23T12:00:00.000Z")).toContain("failed (review_failed)");
    expect(formatGrowList(s.store, "2026-11-25T12:00:00.000Z")).not.toContain("failed (review_failed)");
  });

  it("shows an approved row as waiting for review, and an orphan with its adopt command", async () => {
    const s = await growSetup();
    await s.svc.submit(growFields(), CLEAN);
    s.svc.recordReview(s.store.listGrowStaged("staged")[0]!.id, PASS);
    expect(s.store.listGrowStaged("approved")).toHaveLength(1);
    s.store.upsertGrowItem({ name: "stray-skill", state: "orphan", origin: "clean", description: "left in the repository", example: "x", head_commit: null, content_hash: "h", body_hash: "b" }, NOW);
    const text = formatGrowList(s.store, NOW);
    expect(text).toContain("**unit-convert** · waiting for review");
    expect(text).toContain("**stray-skill** · in the repository but unknown to me · `houge grow adopt stray-skill`");
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

  it("a dropped publish says so and does not claim that writing is paused", async () => {
    const s = await growSetup();
    s.store.openIncident({ kind: "grow_publish_failed", subject: "publish", detail: {}, now: NOW });
    expect(growStatusLines(s.store, NOW)).toEqual(["Grow zone: a finished skill was dropped after repeated write failures; writing continues"]);
  });

  it("a write that landed but could not be recorded is not a paused zone", async () => {
    const s = await growSetup();
    s.store.openIncident({ kind: "grow_zone_unavailable", subject: "apply", detail: {}, now: NOW });
    expect(growStatusLines(s.store, NOW)).toEqual(["Grow zone: a skill write finished but I could not record it yet; writing continues"]);
  });

  it("a zone incident pauses writing whatever its subject", async () => {
    const s = await growSetup();
    s.store.openIncident({ kind: "grow_zone_unavailable", subject: "something-else", detail: {}, now: NOW });
    expect(growStatusLines(s.store, NOW)).toEqual(["Grow zone: writing is paused (the zone could not be written)"]);
  });

  it("a review is pending over a day only after 24 hours, counted from when it was staged (not from its last touch)", async () => {
    const s = await growSetup();
    await s.svc.submit(growFields(), CLEAN);                                     // created 2026-11-10T10:00:0x
    const id = s.store.listGrowStaged("staged")[0]!.id;
    expect(growStatusLines(s.store, "2026-11-11T09:00:00.000Z")).toEqual([]);      // ~23 h
    s.store.patchGrowStaged(id, { claimed_at: null }, "2026-11-11T10:59:00.000Z"); // touched a minute ago: updated_at moves, created_at does not
    expect(growStatusLines(s.store, "2026-11-11T11:00:00.000Z")).toEqual(["Grow zone: 1 review pending over a day · /grow"]);   // ~25 h
  });

  it("an orphan skill is reported as unknown to me", async () => {
    const s = await growSetup();
    s.store.upsertGrowItem({ name: "stray-skill", state: "orphan", origin: "clean", description: "left in the repository", example: "x", head_commit: null, content_hash: "h", body_hash: "b" }, NOW);
    expect(growStatusLines(s.store, NOW)).toEqual(["Grow zone: 1 skill in the repository unknown to me · /grow"]);
  });

  it("redelivering a /grow trust after the name was marked again changes nothing and repeats the recorded reply", async () => {
    const s = await growSetup();
    await s.live(growFields(), { ...CLEAN, level: "untrusted" });
    const ev = growEvent("trust unit-convert", "tg:replay");
    handleGrow(s.store, ev, NOW);
    expect(s.store.isGrowMarked("unit-convert")).toBe(false);
    s.store.markGrowName("unit-convert", NOW);                                   // a later untrusted turn marks it again
    const again = handleGrow(s.store, ev, "2026-11-10T12:00:05.000Z");           // Telegram redelivers the same update
    expect(again).toEqual({ ok: true, status: "grow_returned", run_id: "" });
    expect(s.store.isGrowMarked("unit-convert")).toBe(true);                     // the trust was not applied a second time
    expect(outboxTexts(s.store, "tg:replay:grow")).toEqual(["✅ unit-convert now reads as Houge's own. Reading it no longer marks the conversation."]);
  });

  it("the same idempotency key carrying a different command is a conflict, and does nothing", async () => {
    const s = await growSetup();
    await s.live(growFields());
    handleGrow(s.store, growEvent("trust unit-convert", "tg:clash"), NOW);
    const r = handleGrow(s.store, growEvent("undo unit-convert", "tg:clash"), NOW);
    expect(r).toMatchObject({ ok: false, error: { code: "TRIGGER_IDEMPOTENCY_CONFLICT" } });
    expect(s.store.dueGrowRequests()).toEqual([]);
  });
});
