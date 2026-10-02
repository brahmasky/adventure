import { describe, expect, it } from "vitest";
import {
  buildReconcileQuestion,
  parseReconcileTheme,
  parseReconcileVerdict,
  RECONCILE_DISCIPLINE,
  reconcileLesson
} from "../../src/capabilities/reconcile.js";
import { LESSON_THEMES } from "../../src/run/lesson-themes.js";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-07-03T00:00:00.000Z";

describe("parseReconcileVerdict (tolerant — ANY failure defaults to ADD)", () => {
  const ids = [3, 7];

  it("parses the four verdicts", () => {
    expect(parseReconcileVerdict('{"verdict":"ADD"}', ids)).toEqual({ verdict: "ADD" });
    expect(parseReconcileVerdict('{"verdict":"DROP"}', ids)).toEqual({ verdict: "DROP" });
    expect(parseReconcileVerdict('{"verdict":"SUPERSEDE","id":3}', ids)).toEqual({ verdict: "SUPERSEDE", id: 3 });
    expect(parseReconcileVerdict('{"verdict":"UPDATE","id":7,"text":"merged rule"}', ids)).toEqual({
      verdict: "UPDATE",
      id: 7,
      text: "merged rule"
    });
  });

  it("tolerates surrounding prose / code fences and lowercase verdicts", () => {
    expect(parseReconcileVerdict('Sure:\n```json\n{"verdict":"supersede","id":3}\n```', ids)).toEqual({
      verdict: "SUPERSEDE",
      id: 3
    });
  });

  it("an UPDATE without a merged text keeps the verdict (the store falls back to the candidate)", () => {
    expect(parseReconcileVerdict('{"verdict":"UPDATE","id":3}', ids)).toEqual({ verdict: "UPDATE", id: 3 });
    expect(parseReconcileVerdict('{"verdict":"UPDATE","id":3,"text":"  "}', ids)).toEqual({ verdict: "UPDATE", id: 3 });
  });

  it("garbage / missing JSON / bad verdict / non-integer id → ADD", () => {
    expect(parseReconcileVerdict("no json here", ids)).toEqual({ verdict: "ADD" });
    expect(parseReconcileVerdict("{not valid}", ids)).toEqual({ verdict: "ADD" });
    expect(parseReconcileVerdict('{"verdict":"DELETE","id":3}', ids)).toEqual({ verdict: "ADD" });
    expect(parseReconcileVerdict('{"verdict":"SUPERSEDE","id":"3"}', ids)).toEqual({ verdict: "ADD" });
    expect(parseReconcileVerdict('{"verdict":"SUPERSEDE"}', ids)).toEqual({ verdict: "ADD" });
    expect(parseReconcileVerdict("", ids)).toEqual({ verdict: "ADD" });
  });

  it("a SUPERSEDE/UPDATE naming an id that is NOT among the existing lessons → ADD", () => {
    expect(parseReconcileVerdict('{"verdict":"SUPERSEDE","id":99}', ids)).toEqual({ verdict: "ADD" });
    expect(parseReconcileVerdict('{"verdict":"UPDATE","id":99,"text":"x"}', ids)).toEqual({ verdict: "ADD" });
  });
});

describe("buildReconcileQuestion (the DATA channel)", () => {
  it("lists existing lessons WITH their ids (and AVOID lines) plus the candidate", () => {
    const q = buildReconcileQuestion(
      { scope: "ask", text: "use the Melbourne timezone", avoid: "assuming Sydney" },
      [
        { id: 3, text: "use the Sydney timezone", avoid: "quoting UTC times" },
        { id: 7, text: "be concise", avoid: null }
      ]
    );
    expect(q).toContain("Scope of the NEW preference: ask");
    expect(q).toContain("#3: use the Sydney timezone");
    expect(q).toContain("AVOID: quoting UTC times");
    expect(q).toContain("#7: be concise");
    expect(q).toContain("use the Melbourne timezone");
    expect(q).toContain("AVOID: assuming Sydney");
    expect(q).toContain("reference data");
  });
});

describe("reconcileLesson (the one LLM compare)", () => {
  it("an empty scope still asks once (for the theme), but the verdict is always ADD", async () => {
    let called = 0;
    const r = await reconcileLesson({
      candidate: { scope: "ask", text: "be concise" },
      existing: [],
      llm: async () => { called += 1; return { ok: true, answer: '{"verdict":"DROP","theme":"format"}' }; }
    });
    expect(r).toEqual({ verdict: { verdict: "ADD" }, theme: "format", themeKnown: true });
    expect(called).toBe(1);
  });

  it("runs under RECONCILE_DISCIPLINE and returns the parsed verdict", async () => {
    const calls: Array<{ question: string; system: string }> = [];
    const verdict = await reconcileLesson({
      candidate: { scope: "ask", text: "use the Melbourne timezone" },
      existing: [{ id: 3, text: "use the Sydney timezone" }],
      llm: async (input) => {
        calls.push(input);
        return { ok: true, answer: '{"verdict":"SUPERSEDE","id":3}' };
      }
    });
    expect(verdict.verdict).toEqual({ verdict: "SUPERSEDE", id: 3 });
    expect(calls[0]!.system).toBe(RECONCILE_DISCIPLINE);
    expect(calls[0]!.question).toContain("#3: use the Sydney timezone");
  });

  it("a chain failure or a throw defaults to ADD (never blocks a lesson)", async () => {
    const failed = await reconcileLesson({
      candidate: { scope: "ask", text: "x" },
      existing: [{ id: 1, text: "y" }],
      llm: async () => ({ ok: false })
    });
    expect(failed).toEqual({ verdict: { verdict: "ADD" }, theme: "unthemed", themeKnown: false });

    const threw = await reconcileLesson({
      candidate: { scope: "ask", text: "x" },
      existing: [{ id: 1, text: "y" }],
      llm: async () => {
        throw new Error("chain down");
      }
    });
    expect(threw).toEqual({ verdict: { verdict: "ADD" }, theme: "unthemed", themeKnown: false });
  });

  it("duplicate-timezone-shaped case: the second timezone lesson SUPERSEDES the first (store applied)", async () => {
    // The ready-made live case from the ask block: two near-duplicate timezone lessons
    // must collapse into one supersede chain instead of coexisting.
    const store = RunStore.openInMemory();
    try {
      const first = store.addLesson({
        scope: "ask",
        text: "convert times to the Australia/Sydney timezone",
        source: "migration",
        created_at: NOW
      });
      const candidate = { scope: "ask", text: "always answer times in Sydney local time (AEST)" };
      const verdict = await reconcileLesson({
        candidate,
        existing: store.getActiveLessons("ask"),
        llm: async () => ({ ok: true, answer: `{"verdict":"SUPERSEDE","id":${first}}` })
      });
      const saved = store.saveReconciledLesson(candidate, verdict.verdict, "user_feedback", NOW);

      expect(saved).toMatchObject({ verb: "supersede", supersededId: first });
      expect(store.getActiveLessons("ask")).toHaveLength(1);
      expect(store.getActiveLessons("ask")[0]!.text).toBe(candidate.text);
      expect(store.lessonLineage(first).map((l) => l.id)).toEqual([first, saved.id]);
    } finally {
      store.close();
    }
  });
});

describe("parseReconcileTheme (closed list; anything else is unthemed)", () => {
  it("reads a listed theme, case-insensitively", () => {
    expect(parseReconcileTheme('{"verdict":"ADD","theme":"Format"}')).toEqual({ theme: "format", known: true });
  });
  it("an unknown, missing or garbled theme is unthemed and not known", () => {
    expect(parseReconcileTheme('{"verdict":"ADD","theme":"poetry"}')).toEqual({ theme: "unthemed", known: false });
    expect(parseReconcileTheme('{"verdict":"ADD"}')).toEqual({ theme: "unthemed", known: false });
    expect(parseReconcileTheme("no json")).toEqual({ theme: "unthemed", known: false });
  });
  it("the discipline names every theme so the model can choose", () => {
    for (const t of LESSON_THEMES) expect(RECONCILE_DISCIPLINE).toContain(t);
  });
});
