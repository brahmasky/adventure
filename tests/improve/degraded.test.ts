import { describe, expect, it } from "vitest";
import { evaluateImproveDegraded, judgeTickDate, IMPROVE_DEGRADED_KIND } from "../../src/improve/degraded.js";
import { isRoutedKind, routeOf } from "../../src/run/incident-route.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec 2026-11-07 §7: a failing tick must reach Paco now that the digest's Watch line is gone. Read from improve_ticks rows,
// one judgement per date at its end, in date order; a failed or stuck date pages at once, three no-decision degraded dates
// page once, a healthy date resolves, stopped changes nothing, and an older date never reopens what a newer one resolved.
const ENV = { HOUGE_TELEGRAM_CHAT_ID: "555" };
const at = (date: string) => `${date}T11:00:00.000Z`;
function tick(s: RunStore, date: string, result: "done" | "stopped" | "failed" | "running", detail: Record<string, number> = {}): void {
  s.beginImproveTick(date, at(date));
  if (result !== "running") s.finishImproveTick(date, result, detail, at(date));
}
const evalDate = (s: RunStore, date: string, chatId: string | null = null) => evaluateImproveDegraded({ store: s, now: at(date), env: ENV, chatId }, date);
const open = (s: RunStore) => s.listOpenIncidents().filter((i) => i.kind === IMPROVE_DEGRADED_KIND);
const pages = (s: RunStore) => open(s).map((i) => s.countNotificationsByIdempotencyKey(`incident_opened:${i.incident_id}`));

describe("judgeTickDate", () => {
  const row = (result: "done" | "stopped" | "failed" | "running", detail: Record<string, number> = {}) => ({ local_date: "2026-11-02", started_at: at("2026-11-02"), finished_at: null, result, detail });
  it("failed, a stuck previous date, or no decision with an outage count → bad; done with a decision (or no group) and the embedder up → healthy; stopped → neutral", () => {
    expect(judgeTickDate(row("failed"), undefined)).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 2 }), row("running"))).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 0, groups: 3, deferred_outage: 1 }), undefined)).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 0, groups: 1, record_failed: 1 }), undefined)).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 0, groups: 0, embed_unavailable: 1 }), undefined)).toBe("bad");
    expect(judgeTickDate(row("done", { decided: 1, groups: 2, deferred_outage: 1 }), undefined)).toBe("healthy");
    expect(judgeTickDate(row("done", { decided: 0, groups: 0 }), undefined)).toBe("healthy");
    expect(judgeTickDate(row("done", { decided: 1, embed_unavailable: 1 }), undefined)).toBe("neutral"); // recurrence groups could not form
    expect(judgeTickDate(row("done", { decided: 0, groups: 2 }), undefined)).toBe("neutral"); // deferred for budget, not an outage
    expect(judgeTickDate(row("stopped", { decided: 0, deferred_outage: 5 }), undefined)).toBe("neutral");
  });
});

describe("evaluateImproveDegraded", () => {
  it("routes page", () => { expect(isRoutedKind(IMPROVE_DEGRADED_KIND)).toBe(true); expect(routeOf(IMPROVE_DEGRADED_KIND)).toBe("page"); });
  it("opens at once on a failed date, pages the operator chat once, and does not open twice", () => {
    const s = RunStore.openInMemory();
    tick(s, "2026-11-01", "failed");
    expect(evalDate(s, "2026-11-01")).toBe("opened");
    expect(open(s)).toHaveLength(1); expect(pages(s)).toEqual([1]);
    tick(s, "2026-11-02", "failed");
    expect(evalDate(s, "2026-11-02")).toBe("none");
    expect(open(s)).toHaveLength(1);
  });
  it("opens at once when the previous date's row is still running (a throw out of finishImproveTick)", () => {
    const s = RunStore.openInMemory();
    tick(s, "2026-11-01", "running"); tick(s, "2026-11-02", "done", { decided: 1 });
    expect(evalDate(s, "2026-11-02")).toBe("opened");
  });
  it("three consecutive no-decision degraded dates open once; two do not; stopped in between neither counts nor resets", () => {
    const s = RunStore.openInMemory();
    const bad = { decided: 0, groups: 2, deferred_outage: 2 };
    tick(s, "2026-11-01", "done", bad); expect(evalDate(s, "2026-11-01")).toBe("none");
    tick(s, "2026-11-02", "done", bad); expect(evalDate(s, "2026-11-02")).toBe("none");
    tick(s, "2026-11-03", "stopped", bad); expect(evalDate(s, "2026-11-03")).toBe("none");
    expect(open(s)).toHaveLength(0);
    tick(s, "2026-11-04", "done", bad); expect(evalDate(s, "2026-11-04")).toBe("opened");
    expect(open(s)[0]!.detail_json).toContain('"run":3');
  });
  it("a date that decided something resets the run and resolves an open page; an older bad date evaluated later never reopens it", () => {
    const s = RunStore.openInMemory();
    tick(s, "2026-11-01", "failed"); expect(evalDate(s, "2026-11-01")).toBe("opened");
    tick(s, "2026-11-02", "done", { decided: 1, groups: 1 }); expect(evalDate(s, "2026-11-02")).toBe("resolved");
    expect(open(s)).toHaveLength(0);
    expect(evalDate(s, "2026-11-01")).toBe("none"); // not the newest date: not judged
    expect(open(s)).toHaveLength(0);
    const bad = { decided: 0, groups: 1, deferred_outage: 1 };
    tick(s, "2026-11-03", "done", bad); tick(s, "2026-11-04", "done", bad); expect(evalDate(s, "2026-11-04")).toBe("none"); // the run restarted at 11-03
  });
  it("a healthy date with nothing open is none; no row for the date is none", () => {
    const s = RunStore.openInMemory();
    tick(s, "2026-11-01", "done", { decided: 1 });
    expect(evalDate(s, "2026-11-01")).toBe("none");
    expect(evalDate(s, "2026-11-02")).toBe("none");
  });
});
