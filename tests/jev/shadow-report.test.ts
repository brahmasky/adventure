import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { JEV_MODEL } from "../../src/jev/jev-client.js";
import { formatShadowReport, isJudgedMatch, isShadowMatched, loadShadowRows, parseShadowReportArgs, summarizeShadow, type ShadowRow } from "../../src/jev/shadow-report.js";
import { RunStore } from "../../src/run/run-store.js";

const START = "2026-09-01T00:00:00.000Z";
const DAY = 86_400_000;
const after = (days: number) => new Date(Date.parse(START) + days * DAY).toISOString();
const row = (i: number, over: Partial<ShadowRow> = {}): ShadowRow => ({
  run_id: `r${i}`, occurred_at: i === 0 ? START : after(1), status: "ok", lang: "zh", llm_intent: "research", llm_parsed: true,
  jev_intent: "research", jev_confidence: 0.9, jev_model: JEV_MODEL, observed_action: "research", source: "telegram", ...over
});
const rows = (n: number, over: Partial<ShadowRow> = {}, from = 0) => Array.from({ length: n }, (_, k) => row(from + k, over));
// A failed shadow row carries no jev_* fields at all (exactOptionalPropertyTypes forbids `jev_intent: undefined`).
const failed = (i: number): ShadowRow => ({
  run_id: `r${i}`, occurred_at: after(1), status: "timeout", lang: "zh", llm_intent: "research", llm_parsed: true,
  jev_error: "timed out after 5000ms", observed_action: "research", source: "telegram"
});

describe("summarizeShadow — the per-language promotion bar", () => {
  it("HOLD below 60 matched turns, even at 100% agreement", () => {
    expect(summarizeShadow(rows(59), 0, after(30)).byLang.zh!.verdict).toBe("HOLD");
  });

  it("HOLD before 28 days, even with plenty of turns", () => {
    expect(summarizeShadow(rows(100), 0, after(27)).byLang.zh!.verdict).toBe("HOLD");
  });

  it("PROMOTE at exactly 90% agreement and full coverage", () => {
    const s = summarizeShadow([...rows(54), ...rows(6, { jev_intent: "answer" }, 54)], 0, after(30));
    expect(s.byLang.zh).toMatchObject({ verdict: "PROMOTE", matched: 60, agreement: 0.9, coverage: 1 });
  });

  it("KILL at 89.9% agreement", () => {
    const s = summarizeShadow([...rows(899), ...rows(101, { jev_intent: "answer" }, 899)], 0, after(30));
    expect(s.byLang.zh!.verdict).toBe("KILL");
  });

  it("KILL at 59% coverage: low-confidence and failed turns count in the denominator", () => {
    const s = summarizeShadow([
      ...rows(65),                                                        // confident + agreeing
      ...rows(35, { jev_confidence: 0.3 }, 65),                            // matched but below 0.7
      ...Array.from({ length: 10 }, (_, k) => failed(100 + k))
    ], 0, after(30));
    expect(s.byLang.zh).toMatchObject({ verdict: "KILL", coverage: 65 / 110 });
  });

  it("per-language verdicts: zh can PROMOTE while en HOLDs", () => {
    const s = summarizeShadow([...rows(80), ...rows(12, { lang: "en" }, 80)], 0, after(30));
    expect(s.byLang.zh!.verdict).toBe("PROMOTE");
    expect(s.byLang.en!.verdict).toBe("HOLD");
  });

  it("matched excludes unparsed classifier replies and non-pinned Jev models", () => {
    expect(isShadowMatched(row(1, { llm_parsed: false }))).toBe(false);
    expect(isShadowMatched(row(1, { jev_model: "jev-1.14.0" }))).toBe(false);
    expect(isShadowMatched(row(1, { status: "error" }))).toBe(false);
    expect(isShadowMatched(row(1))).toBe(true);
  });

  it("isJudgedMatch: the confusion-matrix rows the CLI prints exclude schedule fires like the verdict does (parked follow-up)", () => {
    expect(isJudgedMatch(row(1))).toBe(true);
    expect(isJudgedMatch(row(1, { source: "schedule" }))).toBe(false);
    expect(isJudgedMatch(row(1, { source: "cli" }))).toBe(true);
    expect(isJudgedMatch(row(1, { status: "error" }))).toBe(false);
  });

  it("reports the costly direction and clarify — reported, never gating", () => {
    const s = summarizeShadow([
      ...rows(10),
      ...rows(2, { jev_intent: "answer" }, 10),                             // missed research calls
      ...rows(3, { llm_intent: "clarify", jev_intent: "clarify" }, 12),
      ...rows(4, { llm_intent: "clarify", jev_intent: "answer" }, 15)
    ], 0, after(30));
    expect(s.costly).toEqual({ research: 12, missed: 2 });
    expect(s.clarify).toEqual({ llm: 7, matched: 3 });
  });

  it("tenure is the campaign's age, not the age of the first --since row (Codex B3)", () => {
    // 100 rows in the last day, but the campaign started 30 days ago: not a tenure HOLD.
    const recent = rows(100).map((r) => ({ ...r, occurred_at: after(29) }));
    expect(summarizeShadow(recent, 0, after(30), START).byLang.zh!.verdict).toBe("PROMOTE");
    expect(summarizeShadow(recent, 0, after(30)).byLang.zh!.verdict).toBe("HOLD");
  });

  it("status and model counts are split per language — missingness by language and model (Codex R5)", () => {
    const s = summarizeShadow([...rows(5), ...rows(2, { lang: "en" }, 5), failed(7), row(8, { jev_model: "jev-1.14.0" })], 0, after(30));
    expect(s.byLang.zh!.byStatus).toEqual({ ok: 6, timeout: 1 });
    expect(s.byLang.zh!.byModel).toEqual({ [JEV_MODEL]: 5, "jev-1.14.0": 1 });
    expect(s.byLang.en!.byStatus).toEqual({ ok: 2 });
  });

  it("schedule fires never count in the verdict (spec amendment 13)", () => {
    const s = summarizeShadow([
      ...rows(55),                                                          // telegram, agreeing
      ...rows(10, { jev_intent: "answer" }, 55),                             // telegram, disagreeing → 84.6% agreement
      ...rows(40, { source: "schedule" }, 65)                                // schedule, 100% agreement, must be excluded from the verdict
    ], 0, after(30));
    expect(s.byLang.zh!.verdict).toBe("KILL");
    expect(s.byLang.zh!.rows).toBe(65);
    expect(s.bySource.schedule).toBe(40);
    const text = formatShadowReport(s, []);
    expect(text).toMatch(/By source \(schedule fires never count in the verdict\): \{.*"schedule":40.*\}/);
  });
});

describe("formatShadowReport", () => {
  it("leads with per-language verdicts, then counts, missingness, costly direction, clarify", () => {
    const all = [...rows(80), ...rows(12, { lang: "en" }, 80)];
    const text = formatShadowReport(summarizeShadow(all, 3, after(30)), all.filter(isShadowMatched));
    expect(text).toMatch(/zh: PROMOTE/);
    expect(text).toMatch(/en: HOLD/);
    expect(text).toMatch(/by status \{"ok":80\}/);
    expect(text).toMatch(/missing 3/);
    expect(text).toMatch(/Costly direction/);
    expect(text).toMatch(/Clarify/);
    expect(text).toMatch(/separate spec/);
  });

  it("an empty ledger says so instead of printing a verdict", () => {
    expect(formatShadowReport(summarizeShadow([], 0, after(1)), [])).toMatch(/No intent_shadow rows yet/);
  });

  it("no rows in the requested --since window, but the campaign has started: names the campaign start (M4)", () => {
    const text = formatShadowReport(summarizeShadow([], 0, after(30), START), []);
    expect(text).toMatch(/No intent_shadow rows in the requested window \(campaign started 2026-09-01T00:00:00\.000Z\)/);
  });

  it("no rows anywhere and no campaign start: the original message", () => {
    expect(formatShadowReport(summarizeShadow([], 0, after(1)), [])).toBe("No intent_shadow rows yet — is HOUGE_JEV_SHADOW_ENABLED on, and has the daemon been restarted?");
  });
});

describe("loadShadowRows", () => {
  it("maps stored rows and joins the observed action from loop steps", () => {
    const store = RunStore.openInMemory();
    try {
      const created = store.createOrGet(buildTypedTaskEvent({
        source: "cli", type: "run", program: "research-brief", goal: "g",
        requested_by: { kind: "user", id: "paco" }, notify: { kind: "local" },
        idempotency_key: "k", source_reference: "argv", created_at: START
      }));
      if (created.status !== "created") throw new Error("expected created");
      store.recordIntentShadow(created.run_id, { status: "ok", llm_intent: "research", llm_parsed: true, lang: "en", modality: "text", jev_intent: "research", jev_confidence: 0.8, jev_model: JEV_MODEL, jev_latency_ms: 200, jev_probabilities: {} });
      store.recordLoopStep(created.run_id, { step: 1, action: "tool", capability: "web_search", ok: true, result_digest: "" });
      expect(loadShadowRows(store)).toEqual([expect.objectContaining({
        run_id: created.run_id, status: "ok", lang: "en", llm_intent: "research", llm_parsed: true,
        jev_intent: "research", jev_confidence: 0.8, jev_model: JEV_MODEL, observed_action: "research",
        source: "cli"
      })]);
    } finally {
      store.close();
    }
  });
});

describe("parseShadowReportArgs", () => {
  it("accepts nothing or --since ISO (normalised to UTC); rejects the rest", () => {
    expect(parseShadowReportArgs([])).toEqual({ ok: true });
    expect(parseShadowReportArgs(["--since", "2026-09-01T10:00:00+10:00"])).toEqual({ ok: true, sinceIso: "2026-09-01T00:00:00.000Z" });
    expect(parseShadowReportArgs(["--since", "yesterday"]).ok).toBe(false);
    expect(parseShadowReportArgs(["--limit", "5"]).ok).toBe(false);
  });
});
