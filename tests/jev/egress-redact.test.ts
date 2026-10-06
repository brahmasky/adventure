import { describe, expect, it } from "vitest";
import { sanitizeJevText } from "../../src/jev/egress-redact.js";

// Spec §4.5: nothing credential-shaped leaves for TypeSafe, broker or no broker; Paco's words otherwise untouched.
describe("sanitizeJevText", () => {
  it("strips bearer tokens, known key prefixes and long opaque tokens", () => {
    expect(sanitizeJevText("use Authorization: Bearer abc.def-123 please")).toBe("use Authorization: Bearer <token> please");
    expect(sanitizeJevText("key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and sk-abcdefghijklmnopqrstuvwxyz0123 and AKIAIOSFODNN7EXAMPLE")).toBe("key <token> and <token> and <token>");
    expect(sanitizeJevText("hash 0123456789abcdef0123456789abcdef0123")).toBe("hash <token>");
  });
  it("replaces URLs, home paths, heredocs, long quoted literals, OTP-shaped codes and every chat/user id form", () => {
    expect(sanitizeJevText("see https://example.com/a?b=c and /Users/paco/x and -1001234567890 and 987654321")).toBe("see <url> and ~/x and <id> and <id>");
    expect(sanitizeJevText("run cat <<'EOF'\nsecret stuff\nEOF\nthen")).toBe("run cat <heredoc>\nthen");
    expect(sanitizeJevText(`echo "${"a".repeat(45)}"`)).toBe("echo <literal>");
    expect(sanitizeJevText("your code is 482913 ok")).toBe("your code is <code> ok");
  });
  it("leaves ordinary Chinese and English prose, punctuation, dates, years and short numbers alone", () => {
    const zh = "明天 9am，预算 3500，电话 0412 不要存。以后回复请短一点，不要用敬语；如果我没说清楚就先问我一句，不要猜。2026 年 10 月 4 日。";
    expect(sanitizeJevText(zh)).toBe(zh);
    const en = "From now on keep replies under three sentences unless I ask for detail; it's 2026-10-04 and the budget is 3,500.";
    expect(sanitizeJevText(en)).toBe(en);
    // the 40+ opaque-token rule must not eat a long plain word; if it does, require at least one digit or symbol in the token class
    expect(sanitizeJevText("Pneumonoultramicroscopicsilicovolcanoconiosis is a long word")).toBe("Pneumonoultramicroscopicsilicovolcanoconiosis is a long word");
    const quoted = 'he said "from now on please keep every answer short and skip the greeting" and left';
    expect(sanitizeJevText(quoted)).toBe(quoted); // long quoted PROSE stays; only opaque 40+ char quoted tokens are literals
  });
  it("documents the accepted false positive: a standalone 9+ digit number (a phone, an order number) is treated as an id", () => {
    expect(sanitizeJevText("order 123456789 shipped")).toBe("order <id> shipped");
  });
  it("applies the broker redactor first, then the shapes", () => {
    expect(sanitizeJevText("secret VALUE123 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", (s) => s.replace("VALUE123", "<redacted>"))).toBe("secret <redacted> and <token>");
  });
  it("keeps a long quoted Chinese sentence with no spaces; only opaque ASCII literals are stripped", () => {
    const zh = `他说"${"以后回复请尽量简短不要用敬语".repeat(4)}"然后走了`;
    expect(sanitizeJevText(zh)).toBe(zh);
  });
  it("strips an unterminated heredoc body to the end of the text", () => {
    expect(sanitizeJevText("run cat <<EOF\nsecret body\nmore")).toBe("run cat <heredoc>");
  });
  it("documents the accepted false positive: a standalone 6-8 digit number is treated as an OTP code", () => {
    expect(sanitizeJevText("预算 150000")).toBe("预算 <code>");
  });
});
