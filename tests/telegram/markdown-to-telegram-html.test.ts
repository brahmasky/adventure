import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "../../src/telegram/markdown-to-telegram-html.js";
import { formatIdeaText, formatRadarDetailText } from "../../src/gateway/gateway.js";
import type { IdeaRow, ShortlistRow } from "../../src/run/run-store.js";
import { buildToolApprovalPromptText } from "../../src/run/run-store.js";

describe("markdownToTelegramHtml", () => {
  it("converts **bold** and __bold__ to <b>", () => {
    expect(markdownToTelegramHtml("a **bold** b")).toBe("a <b>bold</b> b");
    expect(markdownToTelegramHtml("a __bold__ b")).toBe("a <b>bold</b> b");
  });

  it("converts *italic* and _italic_ to <i>", () => {
    expect(markdownToTelegramHtml("a *it* b")).toBe("a <i>it</i> b");
    expect(markdownToTelegramHtml("a _it_ b")).toBe("a <i>it</i> b");
  });

  it("never treats an intraword _ as emphasis, so ids and snake_case survive (CommonMark; live gate item 2)", () => {
    const id = "appr_1dc4e2a0-7b1f-4c55-9d1e-3f0a8b2c6d10";
    // the exact line the pre-fix card sent: the operator copied `appr<i>…</i>` and lost the underscore
    expect(markdownToTelegramHtml(`Reply /approve ${id} to continue or /deny ${id} to stop.`))
      .toBe(`Reply /approve ${id} to continue or /deny ${id} to stop.`);
    expect(markdownToTelegramHtml("snake_case_word")).toBe("snake_case_word");
    expect(markdownToTelegramHtml("Requester: telegram_user:1 and write_local")).toBe("Requester: telegram_user:1 and write_local");
    expect(markdownToTelegramHtml("a __dunder__init__ b")).toBe("a <b>dunder__init</b> b");
  });

  it("still italicises a real _italic_ and *italic* at word boundaries", () => {
    expect(markdownToTelegramHtml("this is _really_ it")).toBe("this is <i>really</i> it");
    expect(markdownToTelegramHtml("(_aside_)")).toBe("(<i>aside</i>)");
    expect(markdownToTelegramHtml("a*b*c")).toBe("a<i>b</i>c");
  });

  it("renders the tool-approval card's id as tap-to-copy inline code, underscore intact", () => {
    const id = "appr_1dc4e2a0-7b1f-4c55-9d1e-3f0a8b2c6d10";
    const card = buildToolApprovalPromptText(id, {
      run_id: "run_1", worker_id: "w", tool_call_id: "t", capability: "omp.bash", input_hash: "h", action_fingerprint: "f",
      requester: { kind: "user", id: "telegram_user:1" }, summary: "run a command", side_effect_level: "local_write",
      expires_at: "2026-10-01T02:00:00.000Z"
    });
    const html = markdownToTelegramHtml(card);
    expect(html).toContain(`Approval required: <code>${id}</code>`);
    expect(html).toContain(`Reply /approve <code>${id}</code> to continue or /deny <code>${id}</code> to stop.`);
    expect(html).not.toContain("<i>");
  });

  it("does not treat the inner * of bold as italic", () => {
    expect(markdownToTelegramHtml("**strong** and *soft*")).toBe("<b>strong</b> and <i>soft</i>");
  });

  it("converts inline `code` to <code> and does not re-parse its contents", () => {
    expect(markdownToTelegramHtml("run `a**b` now")).toBe("run <code>a**b</code> now");
  });

  it("converts fenced code blocks to <pre>", () => {
    expect(markdownToTelegramHtml("```\nx = 1\n```")).toBe("<pre>x = 1</pre>");
    // Language hint on the fence line is dropped.
    expect(markdownToTelegramHtml("```js\nlet y;\n```")).toBe("<pre>let y;</pre>");
  });

  it("HTML-escapes &, <, > in plain text but not inside emitted tags", () => {
    expect(markdownToTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(markdownToTelegramHtml("`<tag>`")).toBe("<code>&lt;tag&gt;</code>");
  });

  it("converts links [t](u) to <a href> with escaped url and label", () => {
    expect(markdownToTelegramHtml("see [docs](https://x.test/a)")).toBe(
      'see <a href="https://x.test/a">docs</a>'
    );
  });
});

/**
 * Round-trip the ACTUAL /radar family renders through the converter (the whole outgoing
 * Telegram path): the code-owned `**` scaffolding must become <b>, escaped card text must
 * stay inert, and bare URLs must survive verbatim as plain text (never <a>-wrapped, never
 * mangled) — a converter/render mismatch here would trip Telegram's HTML entity parser
 * and drop every board/week message to the plain-text fallback.
 */
describe("radar render round-trips", () => {
  const NOW = "2026-07-26T12:00:00.000Z";
  const card: IdeaRow = {
    id: 1,
    slug: "agent-cli",
    title: "Agent-native CLIs *hostile*",
    summary: "Tools built for agents first — humans second. [spoof](x)",
    status: "shortlisted",
    sources: {
      hn_front: [
        { id: "hn_front:1", url: "https://news.ycombinator.com/item?id=44001", title: "Show HN: thing" }
      ]
    },
    distinct_items: 3,
    distinct_sources: 2,
    scores_json: JSON.stringify({
      panel: {
        week: "2026-W30",
        judges: {
          kimi: { score: 7, reason: "real demand" },
          gemini: { score: 8, reason: "novel angle" },
          codex: { score: 6, reason: "one-week slice" }
        },
        chair_rank: 1
      }
    }),
    first_seen: "2026-07-24T12:00:00.000Z",
    last_seen: "2026-07-26T11:00:00.000Z",
    archived_at: null,
    momentum: 6
  };

  it("the /radar <n> detail render converts cleanly and keeps bare URLs bare", () => {
    const rendered = formatRadarDetailText(1, card, NOW);
    let html = "";
    expect(() => {
      html = markdownToTelegramHtml(rendered);
    }).not.toThrow();
    // Code-owned scaffolding became real bold; the escaped hostile title stayed inert text.
    expect(html).toContain("<b>1. Agent-native CLIs hostile</b>");
    expect(html).not.toContain("<i>");
    // The URL survives verbatim on its own line — plain text, no anchor.
    expect(html).toContain("\n  https://news.ycombinator.com/item?id=44001");
    expect(html).not.toContain("<a ");
    // No literal markdown leaked through.
    expect(html).not.toContain("**");
  });

  it("the /radar week render converts cleanly (header + block scaffolding become <b>)", () => {
    const snapshot: ShortlistRow = {
      id: 1,
      created_at: NOW,
      week_key: "2026-W30",
      cards: [
        { rank: 1, idea_id: 1, slug: "agent-cli", title: "Agent-native CLIs *hostile*", mean_score: 7, chair_rationale: "sharp wedge" }
      ],
      picked_idea_id: null
    };
    const rendered = formatIdeaText(snapshot, 1, () => card);
    let html = "";
    expect(() => {
      html = markdownToTelegramHtml(rendered);
    }).not.toThrow();
    expect(html).toContain("<b>本周 idea shortlist — 2026-W30</b>");
    expect(html).toContain("<b>1. Agent-native CLIs hostile</b> — 综合 7/10 ✅ picked");
    expect(html).toContain("💡 Tools built for agents first — humans second. spoofx");
    expect(html).not.toContain("**");
    expect(html).not.toContain("<a ");
  });
});
