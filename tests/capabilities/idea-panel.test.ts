import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChairInput,
  buildJudgeDiscipline,
  buildPanelDigest,
  CHAIR_FALLBACK_RATIONALE,
  meanScoreFallback,
  PANEL_CHAIR_DISCIPLINE,
  PANEL_DATA_FRAMING,
  PANEL_INPUT_CAP,
  PANEL_JUDGE_LENSES,
  parseChairAnswer,
  parseJudgeAnswer,
  renderPanelProposals,
  resolvePanelEnabled,
  runIdeaPanelTick,
  SHORTLIST_SIZE,
  type PanelSeat,
  type PanelTickInput,
  type ScoredCard
} from "../../src/capabilities/idea-panel.js";
import type { RadarLlm } from "../../src/capabilities/idea-radar.js";
import { RunStore, type IdeaRow } from "../../src/run/run-store.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

/** Friday 2026-07-24 22:00 Sydney → ISO week 2026-W30 in the panel tz. */
const NOW = "2026-07-24T12:00:00.000Z";
const WEEK = "2026-W30";
const ENABLED: NodeJS.ProcessEnv = { HOUGE_RADAR_PANEL_ENABLED: "1" };

let stores: RunStore[] = [];
let tmpDirs: string[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function openStore(): RunStore {
  const store = RunStore.openInMemory();
  stores.push(store);
  return store;
}

function tmpRoot(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "idea-panel-"));
  tmpDirs.push(dir);
  return dir;
}

/** momentum = itemCount × 1 source; sources carry REAL https URLs (the no-URL probe). */
function seedCard(store: RunStore, slug: string, itemCount: number, now = "2026-07-20T10:00:00.000Z") {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    id: `hn_front:${slug}-${i}`,
    url: `https://news.ycombinator.com/item?id=${slug}-${i}`,
    title: `item ${slug}-${i}`
  }));
  return store.insertIdeaCard({
    slug,
    title: `Idea ${slug}`,
    summary: `summary of ${slug}`,
    sources: { hn_front: items },
    now
  });
}

/** Board of 3 with distinct momenta → digest order a(1) > b(2) > c(3). */
function seedBoard(store: RunStore): { a: number; b: number; c: number } {
  return {
    a: seedCard(store, "a", 3).id,
    b: seedCard(store, "b", 2).id,
    c: seedCard(store, "c", 1).id
  };
}

function judgeLlm(answer: string, calls?: string[]): RadarLlm {
  return async ({ question }) => {
    calls?.push(question);
    return { ok: true, answer };
  };
}
const failingLlm: RadarLlm = async () => ({ ok: false });
const throwingLlm: RadarLlm = async () => {
  throw new Error("boom");
};

function seat(answer: string, calls?: string[]): PanelSeat {
  return async ({ digest }) => {
    calls?.push(digest);
    return { ok: true, answer };
  };
}
const failSeat: PanelSeat = async () => ({ ok: false });
const throwingSeat: PanelSeat = async () => {
  throw new Error("boom");
};

/** All-cards uniform judge verdict. */
function scoresAnswer(n: number, score: (index: number) => number): string {
  return JSON.stringify({
    scores: Array.from({ length: n }, (_, i) => ({ card: i + 1, score: score(i + 1), reason: `r${i + 1}` }))
  });
}

function tick(store: RunStore, overrides: Partial<PanelTickInput> = {}) {
  const input: PanelTickInput = {
    store,
    judges: {
      kimi: judgeLlm(scoresAnswer(3, () => 5)),
      gemini: judgeLlm(scoresAnswer(3, () => 5))
    },
    codexJudge: seat(scoresAnswer(3, () => 5)),
    chair: failSeat,
    env: ENABLED,
    now: NOW,
    chatId: "chat-1",
    projectRoot: null,
    ...overrides
  };
  return runIdeaPanelTick(input);
}

function panelEvents(store: RunStore) {
  return store.getLedgerEvents().filter((e) => e.event_type === "idea_panel_tick");
}

function byId(store: RunStore, id: number): IdeaRow {
  const row = store.getIdeaById(id);
  if (!row) throw new Error(`missing idea ${id}`);
  return row;
}

// --- resolvers -------------------------------------------------------------------

describe("resolvePanelEnabled", () => {
  it("enables only on canonical truthy values", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(resolvePanelEnabled({ HOUGE_RADAR_PANEL_ENABLED: v })).toBe(true);
    }
    for (const v of ["0", "false", "no", "", "off"]) {
      expect(resolvePanelEnabled({ HOUGE_RADAR_PANEL_ENABLED: v })).toBe(false);
    }
    expect(resolvePanelEnabled({})).toBe(false);
  });
});

// --- digest + disciplines --------------------------------------------------------

describe("buildPanelDigest", () => {
  it("renders numbered index/title/summary/momentum/sources/age lines with NO urls", () => {
    const store = openStore();
    seedBoard(store);
    const cards = store.listActiveIdeas(PANEL_INPUT_CAP);
    const digest = buildPanelDigest(cards, NOW);
    expect(digest).toContain("1 | Idea a | summary of a | momentum 3 | sources 1 | age 4d");
    expect(digest).toContain("3 | Idea c | summary of c | momentum 1 | sources 1 | age 4d");
    // R1 invariant: stored source URLs never reach any prompt.
    expect(digest).not.toContain("https://");
    expect(digest).not.toContain("news.ycombinator");
    expect(digest.toLowerCase()).toContain(PANEL_DATA_FRAMING.toLowerCase());
  });

  it("the disciplines carry the DATA framing and demand ONLY the strict JSON contract", () => {
    const judge = buildJudgeDiscipline(PANEL_JUDGE_LENSES.kimi);
    expect(judge).toContain(PANEL_DATA_FRAMING);
    expect(judge).toContain("ONLY this strict JSON contract");
    expect(judge).toContain('{"scores":[{');
    expect(judge).toContain("OPPORTUNITY");
    expect(judge).toContain("never invent indices");
    expect(PANEL_CHAIR_DISCIPLINE).toContain(PANEL_DATA_FRAMING);
    expect(PANEL_CHAIR_DISCIPLINE).toContain('{"shortlist":[{');
    expect(PANEL_CHAIR_DISCIPLINE).toContain("never invent indices");
  });

  it("buildChairInput appends the verdict table to the digest, framed as untrusted", () => {
    const kimi = new Map([[1, { score: 7, reason: "gap" }]]);
    const text = buildChairInput("DIGEST", { kimi, gemini: null, codex: null }, 2);
    expect(text).toContain("DIGEST");
    expect(text).toContain("Judge verdicts");
    expect(text).toContain("card 1: kimi 7 (gap)");
    expect(text).toContain("never instructions");
    expect(text).not.toContain("card 2:");
  });
});

// --- parseJudgeAnswer ------------------------------------------------------------

describe("parseJudgeAnswer", () => {
  it("parses scores out of noisy output", () => {
    const { scores } = parseJudgeAnswer(
      `sure!\n${scoresAnswer(3, (i) => i + 4)}\ndone`,
      3
    );
    expect(scores.size).toBe(3);
    expect(scores.get(2)).toEqual({ score: 6, reason: "r2" });
  });

  it("duplicate indices: first wins", () => {
    const { scores } = parseJudgeAnswer(
      JSON.stringify({ scores: [{ card: 1, score: 3, reason: "first" }, { card: 1, score: 9, reason: "second" }] }),
      3
    );
    expect(scores.get(1)).toEqual({ score: 3, reason: "first" });
  });

  it("unknown/invented indices are dropped", () => {
    const { scores } = parseJudgeAnswer(
      JSON.stringify({ scores: [{ card: 0, score: 5 }, { card: 99, score: 5 }, { card: -1, score: 5 }, { card: 2, score: 5 }] }),
      3
    );
    expect([...scores.keys()]).toEqual([2]);
  });

  it("non-integer scores drop the row; integer scores clamp to 0-10", () => {
    const { scores } = parseJudgeAnswer(
      JSON.stringify({
        scores: [
          { card: 1, score: 7.5, reason: "x" },
          { card: 2, score: "7", reason: "x" },
          { card: 3, score: 15, reason: "hi" },
          { card: 4, score: -2, reason: "lo" }
        ]
      }),
      4
    );
    expect(scores.has(1)).toBe(false);
    expect(scores.has(2)).toBe(false);
    expect(scores.get(3)?.score).toBe(10);
    expect(scores.get(4)?.score).toBe(0);
  });

  it("reasons pass the cleanText floor: hostile chars stripped, line breaks flattened, 200-cap", () => {
    const hostile = "evil\u202E\u0007 rea\nson " + "x".repeat(500);
    const { scores } = parseJudgeAnswer(
      JSON.stringify({ scores: [{ card: 1, score: 5, reason: hostile }] }),
      1
    );
    const reason = scores.get(1)?.reason ?? "";
    expect(reason).not.toContain("\u202E");
    expect(reason).not.toContain("\u0007");
    expect(reason).not.toContain("\n");
    expect(reason).toContain("evil rea son");
    expect(Array.from(reason).length).toBeLessThanOrEqual(200);
    // A missing reason keeps the score with an empty reason.
    const { scores: bare } = parseJudgeAnswer(JSON.stringify({ scores: [{ card: 1, score: 5 }] }), 1);
    expect(bare.get(1)).toEqual({ score: 5, reason: "" });
  });

  it("malformed output → empty map", () => {
    for (const bad of ["", "not json", "[]", JSON.stringify({ scores: "nope" }), JSON.stringify({})]) {
      expect(parseJudgeAnswer(bad, 3).scores.size).toBe(0);
    }
  });
});

// --- parseChairAnswer ------------------------------------------------------------

describe("parseChairAnswer", () => {
  const valid = new Set([1, 2, 3, 4]);

  it("keeps order, drops dup/unknown, caps at SHORTLIST_SIZE", () => {
    const picks = parseChairAnswer(
      JSON.stringify({
        shortlist: [
          { card: 3, rationale: "best" },
          { card: 3, rationale: "dup" },
          { card: 99, rationale: "invented" },
          { card: 1, rationale: "second" },
          { card: 2, rationale: "third" },
          { card: 4, rationale: "fourth" }
        ]
      }),
      valid
    );
    expect(picks.map((p) => p.card)).toEqual([3, 1, 2]);
    expect(picks.length).toBe(SHORTLIST_SIZE);
    expect(picks[0]?.rationale).toBe("best");
  });

  it("rationale passes the cleanText floor (hostile strip + 400 code-point cap)", () => {
    const picks = parseChairAnswer(
      JSON.stringify({ shortlist: [{ card: 1, rationale: "why\u202E\u0000 so " + "y".repeat(900) }] }),
      valid
    );
    const rationale = picks[0]?.rationale ?? "";
    expect(rationale).not.toContain("\u202E");
    expect(rationale).not.toContain("\u0000");
    expect(Array.from(rationale).length).toBeLessThanOrEqual(400);
  });

  it("malformed output → []", () => {
    for (const bad of ["", "prose only", JSON.stringify({ shortlist: {} }), JSON.stringify({ scores: [] })]) {
      expect(parseChairAnswer(bad, valid)).toEqual([]);
    }
  });
});

// --- meanScoreFallback -----------------------------------------------------------

describe("meanScoreFallback", () => {
  function scoredStub(index: number, meanScore: number, momentum: number, firstSeen: string): ScoredCard {
    return {
      index,
      meanScore,
      judges: {},
      card: {
        id: index,
        slug: `s${index}`,
        title: `t${index}`,
        summary: "s",
        status: "seen",
        sources: {},
        distinct_items: momentum,
        distinct_sources: 1,
        scores_json: null,
        first_seen: firstSeen,
        last_seen: firstSeen,
        archived_at: null,
        momentum
      }
    };
  }

  it("top-3 by mean; ties break to higher momentum, then older first_seen", () => {
    const picked = meanScoreFallback([
      scoredStub(1, 5, 2, "2026-07-01T00:00:00.000Z"),
      scoredStub(2, 8, 1, "2026-07-02T00:00:00.000Z"),
      scoredStub(3, 5, 4, "2026-07-03T00:00:00.000Z"), // momentum beats index 1
      scoredStub(4, 5, 2, "2026-06-01T00:00:00.000Z"), // same mean+momentum as 1, older wins
      scoredStub(5, 1, 9, "2026-07-01T00:00:00.000Z")
    ]);
    expect(picked.map((p) => p.index)).toEqual([2, 3, 4]);
  });
});

// --- runIdeaPanelTick ------------------------------------------------------------

describe("runIdeaPanelTick", () => {
  it("flag OFF → disabled: no seat calls, no latch, no writes", async () => {
    const store = openStore();
    seedBoard(store);
    const calls: string[] = [];
    const result = await tick(store, {
      env: {},
      judges: { kimi: judgeLlm(scoresAnswer(3, () => 5), calls), gemini: judgeLlm(scoresAnswer(3, () => 5), calls) }
    });
    expect(result).toEqual({ ran: false, status: "disabled" });
    expect(calls).toEqual([]);
    expect(store.getPanelLastRun()).toBeNull();
    expect(panelEvents(store)).toEqual([]);
  });

  it("HOUGE_RADAR_PANEL_AT=off → the panel never fires (no interval fallback)", async () => {
    const store = openStore();
    seedBoard(store);
    const result = await tick(store, { env: { ...ENABLED, HOUGE_RADAR_PANEL_AT: "off" } });
    expect(result).toEqual({ ran: false, status: "off" });
    expect(store.getPanelLastRun()).toBeNull();
  });

  it("thin board (<3 active cards): skipped trace with zeroed counts, NO seat calls", async () => {
    const store = openStore();
    seedCard(store, "solo", 2);
    seedCard(store, "duo", 1);
    const calls: string[] = [];
    const result = await tick(store, {
      judges: { kimi: judgeLlm(scoresAnswer(2, () => 5), calls), gemini: judgeLlm(scoresAnswer(2, () => 5), calls) },
      codexJudge: seat(scoresAnswer(2, () => 5), calls),
      chair: seat("{}", calls)
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("thin_board");
    expect(calls).toEqual([]);
    const [event] = panelEvents(store);
    expect(event?.payload).toMatchObject({
      result: "skipped",
      reason: "thin_board",
      judges_ok: [],
      judges_failed: [],
      chair_used: false,
      cards_scored: 0,
      shortlist_ids: [],
      week_key: WEEK,
      brief_written: false
    });
  });

  it("first-arm happy path with chair: scores, statuses, snapshot, ledger, per-fire push", async () => {
    const store = openStore();
    const ids = seedBoard(store);
    const chairCalls: string[] = [];
    const result = await tick(store, {
      judges: { kimi: judgeLlm(scoresAnswer(3, (i) => i + 3)), gemini: judgeLlm(scoresAnswer(3, () => 5)) },
      codexJudge: seat(scoresAnswer(3, () => 7)),
      chair: seat(
        JSON.stringify({ shortlist: [{ card: 2, rationale: "sharpest wedge" }, { card: 1, rationale: "big gap" }] }),
        chairCalls
      )
    });

    expect(result.status).toBe("ok");
    expect(result.chairUsed).toBe(true);
    expect(result.judgesOk).toEqual(["kimi", "gemini", "codex"]);
    expect(result.cardsScored).toBe(3);
    expect(result.shortlist?.map((s) => s.idea_id)).toEqual([ids.b, ids.a]);

    // The chair saw the digest + the framed verdict table.
    expect(chairCalls[0]).toContain("Judge verdicts");
    expect(chairCalls[0]).toContain("card 1: kimi 4");

    // scores_json: full overwrite — week, per-judge verdicts, chair_rank (null off-shortlist).
    const a = byId(store, ids.a);
    const parsedA = JSON.parse(a.scores_json ?? "{}") as {
      panel: { week: string; judges: Record<string, { score: number; reason: string }>; chair_rank: number | null };
    };
    expect(parsedA.panel.week).toBe(WEEK);
    expect(parsedA.panel.judges.kimi).toEqual({ score: 4, reason: "r1" });
    expect(parsedA.panel.judges.codex).toEqual({ score: 7, reason: "r1" });
    expect(parsedA.panel.chair_rank).toBe(2);
    const parsedC = JSON.parse(byId(store, ids.c).scores_json ?? "{}") as { panel: { chair_rank: number | null } };
    expect(parsedC.panel.chair_rank).toBeNull();

    // Statuses: shortlisted cards seen→shortlisted; the unranked one untouched.
    expect(byId(store, ids.a).status).toBe("shortlisted");
    expect(byId(store, ids.b).status).toBe("shortlisted");
    expect(byId(store, ids.c).status).toBe("seen");

    // Snapshot: frozen ranks in chair order with mean scores + rationales.
    const snapshot = store.getLatestShortlist();
    expect(snapshot?.week_key).toBe(WEEK);
    expect(snapshot?.cards.map((c) => [c.rank, c.idea_id, c.chair_rationale])).toEqual([
      [1, ids.b, "sharpest wedge"],
      [2, ids.a, "big gap"]
    ]);
    expect(snapshot?.cards[0]?.mean_score).toBe(5.7);

    // Ledger: ONE ok event with names + ids.
    const [event] = panelEvents(store);
    expect(event?.payload).toMatchObject({
      result: "ok",
      judges_ok: ["kimi", "gemini", "codex"],
      judges_failed: [],
      chair_used: true,
      cards_scored: 3,
      shortlist_ids: [ids.b, ids.a],
      week_key: WEEK,
      brief_written: false
    });

    // Push: per-fire dedupe key, /idea render + fixed footer.
    expect(result.pushed).toBe(true);
    expect(store.countNotificationsByIdempotencyKey(`idea-panel:${WEEK}:${NOW}`)).toBe(1);
  });

  it("M3: the weekly latch is stamped BEFORE any seat call — all-throwing judges still cost the week", async () => {
    const store = openStore();
    seedBoard(store);
    const result = await tick(store, {
      judges: { kimi: throwingLlm, gemini: throwingLlm },
      codexJudge: throwingSeat
    });
    expect(store.getPanelLastRun()).toBe(NOW);
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("quorum");
  });

  it("quorum abort (1 judge ok): NO writes, no snapshot, no push — only latch + one trace", async () => {
    const store = openStore();
    const ids = seedBoard(store);
    const ideasBefore = JSON.stringify(store.listActiveIdeas(1000));
    const result = await tick(store, {
      judges: { kimi: judgeLlm(scoresAnswer(3, () => 8)), gemini: failingLlm },
      codexJudge: failSeat,
      chair: seat(JSON.stringify({ shortlist: [{ card: 1, rationale: "x" }] }))
    });
    expect(result.status).toBe("aborted");
    expect(JSON.stringify(store.listActiveIdeas(1000))).toBe(ideasBefore);
    expect(byId(store, ids.a).scores_json).toBeNull();
    expect(store.getLatestShortlist()).toBeNull();
    expect(store.countNotificationsByIdempotencyKey(`idea-panel:${WEEK}:${NOW}`)).toBe(0);
    const [event] = panelEvents(store);
    expect(event?.payload).toMatchObject({
      result: "aborted",
      reason: "quorum",
      judges_ok: ["kimi"],
      judges_failed: ["gemini", "codex"],
      chair_used: false,
      cards_scored: 0,
      shortlist_ids: [],
      week_key: WEEK,
      brief_written: false
    });
  });

  it("one judge fails → proceeds on 2: scores carry only the voting judges", async () => {
    const store = openStore();
    const ids = seedBoard(store);
    const result = await tick(store, {
      judges: { kimi: judgeLlm(scoresAnswer(3, () => 6)), gemini: failingLlm },
      codexJudge: seat(scoresAnswer(3, () => 8))
    });
    expect(result.status).toBe("ok");
    expect(result.judgesOk).toEqual(["kimi", "codex"]);
    expect(result.judgesFailed).toEqual(["gemini"]);
    const parsed = JSON.parse(byId(store, ids.a).scores_json ?? "{}") as {
      panel: { judges: Record<string, unknown> };
    };
    expect(Object.keys(parsed.panel.judges)).toEqual(["kimi", "codex"]);
    expect(store.getLatestShortlist()?.cards[0]?.mean_score).toBe(7);
  });

  it("chair failure → deterministic mean-score fallback with the fallback rationale", async () => {
    const store = openStore();
    const ids = seedBoard(store);
    // Means: a=4, b=9, c=6 → fallback order b, c, a.
    const perCard = (i: number) => [4, 9, 6][i - 1] ?? 0;
    const result = await tick(store, {
      judges: { kimi: judgeLlm(scoresAnswer(3, perCard)), gemini: judgeLlm(scoresAnswer(3, perCard)) },
      codexJudge: seat(scoresAnswer(3, perCard)),
      chair: failSeat
    });
    expect(result.status).toBe("ok");
    expect(result.chairUsed).toBe(false);
    expect(result.shortlist?.map((s) => s.idea_id)).toEqual([ids.b, ids.c, ids.a]);
    expect(result.shortlist?.every((s) => s.chair_rationale === CHAIR_FALLBACK_RATIONALE)).toBe(true);
    const [event] = panelEvents(store);
    expect(event?.payload).toMatchObject({ chair_used: false });
  });

  it("a chair answer naming only unknown indices parses empty → fallback", async () => {
    const store = openStore();
    seedBoard(store);
    const result = await tick(store, {
      chair: seat(JSON.stringify({ shortlist: [{ card: 42, rationale: "invented" }] }))
    });
    expect(result.status).toBe("ok");
    expect(result.chairUsed).toBe(false);
    expect(result.shortlist?.length).toBe(3);
  });

  it("a picked card ranked by the chair: scores written, status untouched, kept in the snapshot", async () => {
    const store = openStore();
    const ids = seedBoard(store);
    store.setIdeaStatus({ id: ids.c, status: "shortlisted", now: NOW });
    store.setIdeaStatus({ id: ids.c, status: "picked", now: NOW });
    // picked pins to digest index 1 (status priority ordering).
    const result = await tick(store, {
      chair: seat(JSON.stringify({ shortlist: [{ card: 1, rationale: "still the one" }] }))
    });
    expect(result.status).toBe("ok");
    expect(byId(store, ids.c).status).toBe("picked");
    expect(store.getPickedIdea()?.id).toBe(ids.c);
    expect(JSON.parse(byId(store, ids.c).scores_json ?? "{}")).toMatchObject({ panel: { chair_rank: 1 } });
    expect(store.getLatestShortlist()?.cards.map((c) => c.idea_id)).toEqual([ids.c]);
  });

  it("reversion: a previously-shortlisted card not re-shortlisted decays to tracked; a re-shortlisted one stays", async () => {
    const store = openStore();
    const ids = seedBoard(store);
    store.setIdeaStatus({ id: ids.a, status: "shortlisted", now: NOW });
    store.setIdeaStatus({ id: ids.b, status: "shortlisted", now: NOW });
    // shortlisted pin → digest order: a(1), b(2) (momentum), then c(3). Chair keeps only a.
    const result = await tick(store, {
      chair: seat(JSON.stringify({ shortlist: [{ card: 1, rationale: "keep" }] }))
    });
    expect(result.status).toBe("ok");
    expect(byId(store, ids.a).status).toBe("shortlisted");
    expect(byId(store, ids.b).status).toBe("tracked");
    expect(byId(store, ids.c).status).toBe("seen");
  });

  it("scores_json is a full overwrite on the next panel run (history lives in snapshots)", async () => {
    const store = openStore();
    const ids = seedBoard(store);
    await tick(store, { chatId: null });
    const week1 = (JSON.parse(byId(store, ids.a).scores_json ?? "{}") as { panel: { week: string } }).panel.week;
    expect(week1).toBe(WEEK);
    // Next fire: Sunday 09:00 Sydney = 2026-08-01T23:00:00Z → Sydney date Aug 2 → 2026-W31.
    await tick(store, { chatId: null, now: "2026-08-01T23:00:00.000Z" });
    const parsed = JSON.parse(byId(store, ids.a).scores_json ?? "{}") as {
      panel: { week: string; judges: Record<string, unknown> };
    };
    expect(parsed.panel.week).toBe("2026-W31");
    expect(Object.keys(parsed).length).toBe(1);
  });

  it("weekly due-check (sun 09:00 Sydney): not due / due / latched trio", async () => {
    const store = openStore();
    seedBoard(store);
    store.markPanelRan("2026-07-26T00:00:00.000Z"); // Sun 10:00 Sydney → next due Sun Aug 2 09:00 = 2026-08-01T23:00:00Z
    const notDue = await tick(store, { now: "2026-07-30T00:00:00.000Z" });
    expect(notDue).toEqual({ ran: false, status: "not_due" });
    const due = await tick(store, { now: "2026-08-01T23:00:00.000Z" });
    expect(due.status).toBe("ok");
    const again = await tick(store, { now: "2026-08-01T23:00:01.000Z" });
    expect(again).toEqual({ ran: false, status: "not_due" });
  });

  it("first-arm → Sunday sequence in ONE ISO week: one snapshot row, two distinct push keys", async () => {
    const store = openStore();
    seedBoard(store);
    const firstArm = "2026-07-28T09:00:00.000Z"; // Tue Sydney, W31 — last===null fires immediately
    const sunday = "2026-08-01T23:00:00.000Z"; // Sun 09:00 Sydney, still W31
    const first = await tick(store, { now: firstArm });
    expect(first.status).toBe("ok");
    expect(first.weekKey).toBe("2026-W31");
    const snapshotId = store.getLatestShortlist()?.id;
    const second = await tick(store, { now: sunday });
    expect(second.status).toBe("ok");
    expect(second.weekKey).toBe("2026-W31");
    // Snapshot: idempotent per week — the upsert replaced the same row.
    expect(store.getLatestShortlist()?.id).toBe(snapshotId);
    // Push: per-fire keys — the Sunday digest is NOT suppressed by the same-week dedupe.
    expect(store.countNotificationsByIdempotencyKey(`idea-panel:2026-W31:${firstArm}`)).toBe(1);
    expect(store.countNotificationsByIdempotencyKey(`idea-panel:2026-W31:${sunday}`)).toBe(1);
  });

  it("dryRun: bypasses flag+latch, calls the REAL seats, takes ZERO write paths, returns the shortlist", async () => {
    const store = openStore();
    const ids = seedBoard(store);
    const before = JSON.stringify({
      ideas: store.listActiveIdeas(1000),
      latest: store.getLatestShortlist(),
      last_run: store.getPanelLastRun(),
      ledger: store.getLedgerEvents().length
    });
    const judgeCalls: string[] = [];
    const chairCalls: string[] = [];
    const result = await tick(store, {
      env: {}, // flag unset — dryRun runs anyway (B2)
      dryRun: true,
      projectRoot: tmpRoot(),
      judges: {
        kimi: judgeLlm(scoresAnswer(3, () => 6), judgeCalls),
        gemini: judgeLlm(scoresAnswer(3, () => 6), judgeCalls)
      },
      codexJudge: seat(scoresAnswer(3, () => 6), judgeCalls),
      chair: seat(JSON.stringify({ shortlist: [{ card: 1, rationale: "top" }] }), chairCalls)
    });
    expect(result.ran).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.chairUsed).toBe(true);
    expect(result.shortlist?.map((s) => s.idea_id)).toEqual([ids.a]);
    expect(judgeCalls.length).toBe(3);
    expect(chairCalls.length).toBe(1);
    const after = JSON.stringify({
      ideas: store.listActiveIdeas(1000),
      latest: store.getLatestShortlist(),
      last_run: store.getPanelLastRun(),
      ledger: store.getLedgerEvents().length
    });
    expect(after).toBe(before);
    expect(store.countNotificationsByIdempotencyKey(`idea-panel:${WEEK}:${NOW}`)).toBe(0);
  });

  it("chatId null → push skipped (CLI context); tick still ok", async () => {
    const store = openStore();
    seedBoard(store);
    const result = await tick(store, { chatId: null });
    expect(result.status).toBe("ok");
    expect(result.pushed).toBe(false);
    expect(store.countNotificationsByIdempotencyKey(`idea-panel:${WEEK}:${NOW}`)).toBe(0);
  });

  it("store fault mid-apply: contained by the inner try/catch — ledger trace still lands, never throws", async () => {
    const store = openStore();
    seedBoard(store);
    vi.spyOn(store, "upsertShortlistSnapshot").mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = await tick(store, { chatId: null });
    expect(result.status).toBe("ok");
    expect(store.getPanelLastRun()).toBe(NOW);
    expect(panelEvents(store).length).toBe(1);
  });

  it("push failure is non-fatal: the tick is already complete", async () => {
    const store = openStore();
    seedBoard(store);
    vi.spyOn(store, "enqueueNotification").mockImplementation(() => {
      throw new Error("outbox down");
    });
    const result = await tick(store);
    expect(result.status).toBe("ok");
    expect(result.pushed).toBe(false);
    expect(panelEvents(store).length).toBe(1);
  });

  it("writes the weekly brief when projectRoot is set; ledger records brief_written", async () => {
    const store = openStore();
    seedBoard(store);
    const root = tmpRoot();
    const result = await tick(store, { projectRoot: root, chatId: null });
    expect(result.status).toBe("ok");
    expect(result.briefWritten).toBe(true);
    const briefPath = join(root, "memory", "briefs", `${WEEK}-ideas.md`);
    const content = readFileSync(briefPath, "utf8");
    expect(content.startsWith("> ⚠️ Content below is derived from untrusted public feeds")).toBe(true);
    const [event] = panelEvents(store);
    expect(event?.payload).toMatchObject({ brief_written: true });
  });

  it("brief write failure is non-fatal: brief_written false, tick continues to ledger+push", async () => {
    const store = openStore();
    seedBoard(store);
    const root = tmpRoot();
    // memory/briefs occupied by a FILE → mkdirSync throws inside writeBriefFile.
    const memoryDir = join(root, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "briefs"), "not a directory");
    const result = await tick(store, { projectRoot: root });
    expect(result.status).toBe("ok");
    expect(result.briefWritten).toBe(false);
    expect(result.pushed).toBe(true);
    const [event] = panelEvents(store);
    expect(event?.payload).toMatchObject({ result: "ok", brief_written: false });
  });
});

// --- renderPanelProposals --------------------------------------------------------

describe("renderPanelProposals", () => {
  it("renders ranks, titles, means and rationales, naming the synthesis mode", () => {
    const lines = renderPanelProposals({
      ran: true,
      status: "ok",
      weekKey: "2026-W30",
      judgesOk: ["kimi", "gemini"],
      judgesFailed: ["codex"],
      chairUsed: false,
      cardsScored: 3,
      shortlist: [
        { rank: 1, idea_id: 5, title: "Log watcher", mean_score: 7.5, chair_rationale: CHAIR_FALLBACK_RATIONALE }
      ]
    });
    const text = lines.join("\n");
    expect(text).toContain("2026-W30");
    expect(text).toContain("mean-score fallback");
    expect(text).toContain("1. Log watcher — mean 7.5");
    expect(text).toContain("(dry run — nothing was written.)");
  });

  it("M1: hostile chars never survive into the terminal render", () => {
    const lines = renderPanelProposals({
      ran: true,
      status: "ok",
      weekKey: "2026-W30",
      judgesOk: ["kimi", "gemini"],
      chairUsed: true,
      shortlist: [
        { rank: 1, idea_id: 5, title: "evil\u202Etitle\u0007", mean_score: 5, chair_rationale: "why\u200B so" }
      ]
    });
    const text = lines.join("\n");
    expect(text).not.toContain("\u202E");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u200B");
    expect(text).toContain("eviltitle");
  });

  it("renders the skip and abort outcomes distinctly", () => {
    expect(renderPanelProposals({ ran: true, status: "skipped", reason: "thin_board" }).join("\n")).toContain(
      "thin board"
    );
    expect(
      renderPanelProposals({
        ran: true,
        status: "aborted",
        reason: "quorum",
        judgesOk: ["kimi"],
        judgesFailed: ["gemini", "codex"]
      }).join("\n")
    ).toContain("quorum failed");
  });
});
