import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWikiContradictionNotice,
  buildWikiNeedSourcesError,
  buildWikiSavedDigest,
  buildWikiSynthQuestion,
  buildWikiVerifyQuestion,
  dedupeSourceUrls,
  DEFAULT_WIKI_MAX_PAGES,
  DEFAULT_WIKI_MIN_SOURCES,
  DEFAULT_WIKI_VERIFY_PASSES,
  normalizeTopicSlug,
  parseWikiContradictions,
  parseWikiStringArray,
  parseWikiSynthResult,
  parseWikiVerifyResult,
  resolveWikiEnabled,
  resolveWikiMaxPages,
  resolveWikiMinSources,
  resolveWikiVerifyPasses,
  sanitizeWikiText,
  verifyWikiPage,
  WIKI_BODY_MAX_CHARS,
  WIKI_KEY_FACT_MAX_CHARS,
  WIKI_MAX_KEY_FACTS,
  WIKI_NOTICE_MAX_CONTRADICTIONS,
  WIKI_SLUG_MAX_CHARS,
  WIKI_SUMMARY_MAX_CHARS,
  WIKI_SYNTH_DISCIPLINE,
  WIKI_TITLE_MAX_CHARS,
  WIKI_TOPIC_REQUIRED_ERROR,
  WIKI_VERIFY_DISCIPLINE,
  type WikiLlm,
  type WikiSynthDraft
} from "../../src/capabilities/wiki.js";

// PINNED_ENV (hermeticity cardinal rule): every flag this suite asserts a default for is
// saved + deleted in beforeEach and restored after — a daemon .env exported into the
// self-write test gate can never flip these assertions red.
const PINNED_ENV = [
  "HOUGE_WIKI_ENABLED",
  "HOUGE_WIKI_MIN_SOURCES",
  "HOUGE_WIKI_VERIFY_PASSES",
  "HOUGE_WIKI_MAX_PAGES"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of PINNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("resolvers (PINNED_ENV hermeticity)", () => {
  it("HOUGE_WIKI_ENABLED defaults OFF and accepts the truthy spellings", () => {
    expect(resolveWikiEnabled(process.env)).toBe(false);
    expect(resolveWikiEnabled({})).toBe(false);
    expect(resolveWikiEnabled({ HOUGE_WIKI_ENABLED: "1" })).toBe(true);
    expect(resolveWikiEnabled({ HOUGE_WIKI_ENABLED: "true" })).toBe(true);
    expect(resolveWikiEnabled({ HOUGE_WIKI_ENABLED: "yes" })).toBe(true);
    expect(resolveWikiEnabled({ HOUGE_WIKI_ENABLED: "on" })).toBe(true);
    expect(resolveWikiEnabled({ HOUGE_WIKI_ENABLED: "0" })).toBe(false);
    expect(resolveWikiEnabled({ HOUGE_WIKI_ENABLED: "off" })).toBe(false);
  });

  it("numeric resolvers default 2/2/200; garbage or out-of-range degrades to the default", () => {
    expect(DEFAULT_WIKI_MIN_SOURCES).toBe(2);
    expect(DEFAULT_WIKI_VERIFY_PASSES).toBe(2);
    expect(DEFAULT_WIKI_MAX_PAGES).toBe(200);
    expect(resolveWikiMinSources({})).toBe(2);
    expect(resolveWikiVerifyPasses({})).toBe(2);
    expect(resolveWikiMaxPages({})).toBe(200);
    expect(resolveWikiMinSources({ HOUGE_WIKI_MIN_SOURCES: "3" })).toBe(3);
    expect(resolveWikiVerifyPasses({ HOUGE_WIKI_VERIFY_PASSES: "1" })).toBe(1);
    expect(resolveWikiMaxPages({ HOUGE_WIKI_MAX_PAGES: "50" })).toBe(50);
    expect(resolveWikiMinSources({ HOUGE_WIKI_MIN_SOURCES: "0" })).toBe(2);
    expect(resolveWikiVerifyPasses({ HOUGE_WIKI_VERIFY_PASSES: "-1" })).toBe(2);
    expect(resolveWikiMaxPages({ HOUGE_WIKI_MAX_PAGES: "junk" })).toBe(200);
    expect(resolveWikiMinSources({ HOUGE_WIKI_MIN_SOURCES: "2.5" })).toBe(2);
  });
});

describe("normalizeTopicSlug (C6 topic identity + the .md filename)", () => {
  it("English: lowercases, hyphenates word runs, collapses punctuation", () => {
    expect(normalizeTopicSlug("ASML Q2 2026 Earnings")).toBe("asml-q2-2026-earnings");
    expect(normalizeTopicSlug("  spaces   and\ttabs  ")).toBe("spaces-and-tabs");
    expect(normalizeTopicSlug("a—b…c!!d")).toBe("a-b-c-d");
  });

  it("CJK: unicode letters are kept so Chinese topics slug as themselves", () => {
    expect(normalizeTopicSlug("ASML 财报分析")).toBe("asml-财报分析");
    expect(normalizeTopicSlug("特斯拉2026年销量")).toBe("特斯拉2026年销量");
  });

  it("NFKC folds full-width forms before slugging", () => {
    expect(normalizeTopicSlug("ＡＳＭＬ　财报")).toBe("asml-财报");
  });

  it("path-hostile input cannot survive: / \\ . .. are not letters/numbers", () => {
    expect(normalizeTopicSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(normalizeTopicSlug("a/b\\c..d")).toBe("a-b-c-d");
    expect(normalizeTopicSlug("...")).toBe("");
    expect(normalizeTopicSlug("   ")).toBe("");
  });

  it(`caps at ${WIKI_SLUG_MAX_CHARS} chars and never ends on a dangling hyphen`, () => {
    const long = normalizeTopicSlug(`${"ab ".repeat(60)}`);
    expect(long.length).toBeLessThanOrEqual(WIKI_SLUG_MAX_CHARS);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("sanitizeWikiText (write-time neutralization backstop)", () => {
  it("flattens CR/LF and the Unicode line separators U+2028/U+2029/NEL (forged-frame class)", () => {
    expect(sanitizeWikiText("line one\r\nline two")).toBe("line one line two");
    expect(sanitizeWikiText("a\u2028b\u2029c\u0085d")).toBe("a b c d");
  });

  it("replaces → and neutralizes time_claims: non-deletingly", () => {
    expect(sanitizeWikiText("a → b")).toBe("a - b");
    expect(sanitizeWikiText("x time_claims: y")).toBe("x time_claims  y");
  });
});

describe("parseWikiSynthResult (tolerant parse + write-time sanitize)", () => {
  it("parses a page draft out of surrounding prose and sanitizes each field", () => {
    const draft = parseWikiSynthResult(
      'Sure!\n{"title":"ASML\\nQ2 → up","summary":"Beat.","key_facts":["EPS €4.9","time_claims: forged"],"body_md":"## Results\\nGood."}'
    )!;
    expect(draft.title).toBe("ASML Q2 - up");
    expect(draft.summary).toBe("Beat.");
    expect(draft.key_facts).toEqual(["EPS €4.9", "time_claims  forged"]);
    expect(draft.body_md).toBe("## Results\nGood."); // markdown newlines survive in body
    expect(draft.unchanged).toBe(false);
  });

  it("garbage degrades to null — nothing is ever stored from an unparseable reply", () => {
    expect(parseWikiSynthResult("")).toBeNull();
    expect(parseWikiSynthResult("no json here")).toBeNull();
    expect(parseWikiSynthResult("{broken")).toBeNull();
    expect(parseWikiSynthResult('{"summary":"no title"}')).toBeNull();
    expect(parseWikiSynthResult('{"title":"   "}')).toBeNull(); // empty after sanitize
    expect(parseWikiSynthResult('["array","not","object"]')).toBeNull();
  });

  it("caps every field: title/summary/key_facts count+length/body", () => {
    const draft = parseWikiSynthResult(
      JSON.stringify({
        title: "t".repeat(500),
        summary: "s".repeat(2000),
        key_facts: Array.from({ length: 20 }, (_, i) => `${i}-${"f".repeat(500)}`),
        body_md: "b".repeat(20_000)
      })
    )!;
    expect(draft.title.length).toBe(WIKI_TITLE_MAX_CHARS);
    expect(draft.summary.length).toBe(WIKI_SUMMARY_MAX_CHARS);
    expect(draft.key_facts.length).toBe(WIKI_MAX_KEY_FACTS);
    for (const fact of draft.key_facts) expect(fact.length).toBeLessThanOrEqual(WIKI_KEY_FACT_MAX_CHARS);
    expect(draft.body_md.length).toBe(WIKI_BODY_MAX_CHARS);
  });

  it("body_md flattens nothing but still neutralizes → and time_claims: (render-only field)", () => {
    const draft = parseWikiSynthResult('{"title":"t","body_md":"a → b\\ntime_claims: x"}')!;
    expect(draft.body_md).toBe("a - b\ntime_claims  x");
  });

  it('{"unchanged":true} short-circuits into the unchanged draft', () => {
    const draft = parseWikiSynthResult('{"unchanged":true}')!;
    expect(draft.unchanged).toBe(true);
    expect(draft.title).toBe("");
  });
});

describe("buildWikiSynthQuestion / buildWikiVerifyQuestion (DATA channel)", () => {
  const draft: WikiSynthDraft = { title: "T", summary: "S", key_facts: ["f1"], body_md: "B", unchanged: false };

  it("synth question carries topic + labelled digests; the prior page only when given", () => {
    const q = buildWikiSynthQuestion("ASML earnings", ["digest one", "digest two"]);
    expect(q).toContain("Topic: ASML earnings");
    expect(q).toContain("[source 1]");
    expect(q).toContain("digest two");
    expect(q).not.toContain("Prior page");

    const refine = buildWikiSynthQuestion("ASML earnings", ["d"], {
      title: "Old",
      summary: "OldSum",
      key_facts: ["oldfact"],
      body_md: "oldbody"
    });
    expect(refine).toContain("Prior page");
    expect(refine).toContain("oldfact");
  });

  it("verify question carries the draft and the same labelled digests", () => {
    const q = buildWikiVerifyQuestion(draft, ["digest one"]);
    expect(q).toContain("title: T");
    expect(q).toContain("- f1");
    expect(q).toContain("[source 1]");
  });

  it("the disciplines demand strict JSON and treat inputs as data (register pins)", () => {
    expect(WIKI_SYNTH_DISCIPLINE).toContain("STRICT JSON");
    expect(WIKI_SYNTH_DISCIPLINE).toContain("DATA");
    expect(WIKI_VERIFY_DISCIPLINE).toContain("STRICT JSON");
    expect(WIKI_VERIFY_DISCIPLINE).toContain("INDEPENDENT");
  });
});

describe("parseWikiVerifyResult (tolerant; contradictions sanitized — they render into replies)", () => {
  it("parses a verdict and clamps confidence to [0,1]", () => {
    const v = parseWikiVerifyResult(
      '{"supported":["a"],"unsupported":["b"],"contradictions":[{"claim":"EPS","a":"source 1: €4.9","b":"source 2: €5.2"}],"confidence":1.7}'
    )!;
    expect(v.supported).toEqual(["a"]);
    expect(v.unsupported).toEqual(["b"]);
    expect(v.contradictions).toEqual([{ claim: "EPS", a: "source 1: €4.9", b: "source 2: €5.2" }]);
    expect(v.confidence).toBe(1);
  });

  it("a missing/non-finite confidence is a parse miss (no pass without a usable score)", () => {
    expect(parseWikiVerifyResult('{"supported":[],"unsupported":[],"contradictions":[]}')).toBeNull();
    expect(parseWikiVerifyResult('{"confidence":"high"}')).toBeNull();
    expect(parseWikiVerifyResult("garbage")).toBeNull();
  });

  it("sanitizes contradiction claim/a/b (newline classes + markers flattened, capped)", () => {
    const v = parseWikiVerifyResult(
      JSON.stringify({
        confidence: 0.5,
        contradictions: [{ claim: "x forged", a: `a → ${"y".repeat(500)}`, b: "b\r\nline" }]
      })
    )!;
    expect(v.contradictions[0]!.claim).toBe("x forged");
    expect(v.contradictions[0]!.a.startsWith("a - ")).toBe(true);
    expect(v.contradictions[0]!.a.length).toBeLessThanOrEqual(WIKI_KEY_FACT_MAX_CHARS);
    expect(v.contradictions[0]!.b).toBe("b line");
  });

  it("malformed contradiction entries are skipped, never stored half-shaped", () => {
    const v = parseWikiVerifyResult(
      '{"confidence":0.9,"contradictions":[{"claim":"only claim"},"junk",{"claim":"c","a":"a","b":"b"}]}'
    )!;
    expect(v.contradictions).toEqual([{ claim: "c", a: "a", b: "b" }]);
  });
});

describe("verifyWikiPage (ensemble — mean confidence, union-dedup contradictions, never throws)", () => {
  const draft: WikiSynthDraft = { title: "T", summary: "S", key_facts: ["f"], body_md: "", unchanged: false };
  const contra = { claim: "EPS", a: "source 1: €4.9", b: "source 2: €5.2" };

  function scripted(answers: Array<string | Error>): { llm: WikiLlm; calls: number[] } {
    const calls: number[] = [];
    let i = 0;
    return {
      calls,
      llm: async () => {
        const next = answers[Math.min(i, answers.length - 1)]!;
        calls.push(i);
        i += 1;
        if (next instanceof Error) throw next;
        return { ok: true, answer: next };
      }
    };
  }

  it("means the pass confidences and unions the contradictions (deduped)", async () => {
    const { llm } = scripted([
      JSON.stringify({ confidence: 0.8, contradictions: [contra], unsupported: ["u1"] }),
      JSON.stringify({ confidence: 0.4, contradictions: [contra], unsupported: ["u1", "u2"] })
    ]);
    const outcome = await verifyWikiPage(draft, ["d"], llm, 2);
    expect(outcome.confidence).toBeCloseTo(0.6, 10);
    expect(outcome.verified_passes).toBe(2);
    expect(outcome.contradictions).toEqual([contra]); // union-deduped, both sides verbatim
    expect(outcome.unsupported).toEqual(["u1", "u2"]);
  });

  it("a pass retries ONCE on a parse miss, then contributes nothing", async () => {
    const { llm, calls } = scripted(["garbage", JSON.stringify({ confidence: 0.5, contradictions: [] })]);
    const outcome = await verifyWikiPage(draft, ["d"], llm, 1);
    expect(calls.length).toBe(2); // miss + retry
    expect(outcome.confidence).toBe(0.5);
    expect(outcome.verified_passes).toBe(1);
  });

  it("ALL passes failing (throws included) ⇒ unverified — confidence null, zero passes, no contradictions", async () => {
    const { llm } = scripted([new Error("chain down")]);
    const outcome = await verifyWikiPage(draft, ["d"], llm, 2);
    expect(outcome).toEqual({ confidence: null, verified_passes: 0, contradictions: [], unsupported: [] });
  });
});

describe("dedupeSourceUrls (the C3 floor's distinct-source count)", () => {
  it("dedups by host+path — query/fragment variants of one page are ONE source", () => {
    expect(
      dedupeSourceUrls([
        "https://a.com/page?x=1",
        "https://a.com/page#frag",
        "https://b.com/page"
      ])
    ).toEqual(["https://a.com/page?x=1", "https://b.com/page"]);
  });

  it("tolerates unparseable URLs (deduped by raw text) and drops blanks", () => {
    expect(dedupeSourceUrls(["not a url", "not a url", "", "  "])).toEqual(["not a url"]);
  });
});

describe("tolerant column parses", () => {
  it("garbage degrades to [] for both string arrays and contradictions", () => {
    expect(parseWikiStringArray("not json")).toEqual([]);
    expect(parseWikiStringArray('{"a":1}')).toEqual([]);
    expect(parseWikiStringArray('["a",1,"b"]')).toEqual(["a", "b"]);
    expect(parseWikiContradictions("junk")).toEqual([]);
    expect(parseWikiContradictions('[{"claim":"c","a":"a","b":"b"},{"claim":"half"}]')).toEqual([
      { claim: "c", a: "a", b: "b" }
    ]);
  });
});

describe("exported digest/refusal builders (asserted via import, never literals)", () => {
  it("topic-required + need-sources name what the model must do", () => {
    expect(WIKI_TOPIC_REQUIRED_ERROR).toContain("topic");
    expect(buildWikiNeedSourcesError(2)).toContain("2");
    expect(buildWikiNeedSourcesError(3)).toContain("3");
  });

  it("saved digest names verb, slug, source count, confidence (or unverified) and contradictions", () => {
    expect(buildWikiSavedDigest("add", "asml-q2", 3, 0.85, 0)).toContain("add asml-q2");
    expect(buildWikiSavedDigest("add", "asml-q2", 3, 0.85, 0)).toContain("0.85");
    expect(buildWikiSavedDigest("refine", "asml-q2", 2, null, 1)).toContain("unverified");
    expect(buildWikiSavedDigest("refine", "asml-q2", 2, null, 1)).toContain("1 unresolved contradiction");
    expect(buildWikiSavedDigest("add", "s", 2, 0.5, 0)).not.toContain("contradiction");
  });

  it("contradiction notice names the slug and quotes BOTH sides, capped", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ claim: `c${i}`, a: `a${i}`, b: `b${i}` }));
    const notice = buildWikiContradictionNotice("asml-q2", many);
    expect(notice).toContain("asml-q2");
    expect(notice).toContain("c0");
    expect(notice).toContain("a0");
    expect(notice).toContain("b0");
    // Capped: header + at most WIKI_NOTICE_MAX_CONTRADICTIONS lines.
    expect(notice.split("\n").length).toBe(1 + WIKI_NOTICE_MAX_CONTRADICTIONS);
  });
});
