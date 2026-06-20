import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "../../src/telegram/markdown-to-telegram-html.js";

describe("markdownToTelegramHtml", () => {
  it("converts **bold** and __bold__ to <b>", () => {
    expect(markdownToTelegramHtml("a **bold** b")).toBe("a <b>bold</b> b");
    expect(markdownToTelegramHtml("a __bold__ b")).toBe("a <b>bold</b> b");
  });

  it("converts *italic* and _italic_ to <i>", () => {
    expect(markdownToTelegramHtml("a *it* b")).toBe("a <i>it</i> b");
    expect(markdownToTelegramHtml("a _it_ b")).toBe("a <i>it</i> b");
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
