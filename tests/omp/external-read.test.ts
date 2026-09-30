import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_NOTE, renderExternalRead, TRUSTED_HEADER } from "../../src/omp/external-read.js";

describe("the wall's one output shape (spec §5.2) — only trusted_extract may carry source bytes", () => {
  it("renders digest, the instruction flag and the trusted side-channel, nothing else", () => {
    const text = renderExternalRead({ digest: "A page about tides.", contains_instructions: true,
      trusted_extract: { links: ["https://x.io/a"], codes: ["123456"] }, source_meta: { tool: "http_fetch", bytes: 9000 } });
    expect(text).toContain("A page about tides.");
    expect(text).toContain(INSTRUCTIONS_NOTE);
    expect(text).toContain(TRUSTED_HEADER);
    expect(text).toContain("https://x.io/a");
    expect(text).toContain("123456");
    expect(text).not.toContain("9000");
  });

  it("omits the instruction note and the trusted header when there is nothing to flag or extract", () => {
    const text = renderExternalRead({ digest: "Plain.", contains_instructions: false, source_meta: { tool: "web_search", bytes: 5 } });
    expect(text).toBe("Plain.");
  });
});
