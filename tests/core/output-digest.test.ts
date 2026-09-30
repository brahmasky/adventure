import { describe, expect, it } from "vitest";
import { digestOutput, timeConvertDigestHeader } from "../../src/core/output-digest.js";

// Moved from tests/core/inner-loop.test.ts with digestOutput (Task 14): the text the omp wall
// hands the quarantined reader as the untrusted source is still exactly this rendering.
describe("digestOutput", () => {
  it("prefers the answer text, renders web results as numbered lines, falls back to JSON", () => {
    expect(digestOutput({ answer: "Paris.", model: "m" }, 100)).toBe("Paris.");
    const web = digestOutput({ results: [{ title: "T", url: "https://t.test", content: "c" }] }, 200);
    expect(web).toContain("[1] T — https://t.test");
    expect(digestOutput({ saved: true, scope: "ask" }, 100)).toBe('{"saved":true,"scope":"ask"}');
  });

  it("renders http_fetch-shaped output ({url,status,content} jointly) as a readable header + content", () => {
    const digest = digestOutput(
      { url: "https://a.test/x", status: 200, content_type: "text/html; charset=utf-8", content: "Body text here", truncated: false, bytes: 512 },
      500
    );
    expect(digest).toContain("https://a.test/x → HTTP 200 (text/html; charset=utf-8)");
    expect(digest).toContain("Body text here");
  });

  it("http_fetch redirect output carries the location as a next-step hint (never auto-followed)", () => {
    const digest = digestOutput(
      { url: "http://a.test/old", status: 301, content_type: "", content: "", truncated: false, bytes: 0, location: "https://a.test/new", note: "redirect note" },
      500
    );
    expect(digest).toContain("http://a.test/old → HTTP 301");
    expect(digest).toContain("https://a.test/new");
    expect(digest).toContain("next step");
  });

  it("a joint url+status+content match is required — partial shapes still fall back to JSON", () => {
    expect(digestOutput({ url: "https://a.test", saved: true }, 200)).toBe('{"url":"https://a.test","saved":true}');
  });

  it("B6: to_local_time rows render the event label on success AND error rows (row stays bound to its event)", () => {
    const digest = digestOutput(
      {
        results: [
          { when: "2026-07-07 16:00", tz: "UTC", local: "2026-07-08 02:00", relative_day: "tomorrow", label: "Argentina vs Egypt" },
          { when: "2026-07-07 20:00", tz: "UTC", error: "zone not stated by source", label: "France vs Brazil" },
          { when: "2026-07-08 12:00", tz: "UTC", local: "2026-07-08 22:00", relative_day: "tomorrow" } // unlabeled: legacy shape
        ]
      },
      1_000
    );
    expect(digest).toContain("Argentina vs Egypt: 2026-07-07 16:00 (UTC) → 2026-07-08 02:00 (tomorrow)");
    expect(digest).toContain("France vs Brazil: 2026-07-07 20:00 (UTC) → error: zone not stated by source");
    expect(digest).toContain("\n2026-07-08 12:00 (UTC) → 2026-07-08 22:00 (tomorrow)");
  });

  it("R1: with local_tz on the envelope, success rows name the zone inside the parens; error rows keep their shape", () => {
    const digest = digestOutput(
      {
        local_tz: "Australia/Sydney",
        results: [
          { when: "2026-07-07 16:00", tz: "UTC", local: "2026-07-08 02:00", relative_day: "tomorrow", label: "Argentina vs Egypt" },
          { when: "2026-07-07 20:00", tz: "UTC", error: "zone not stated by source" }
        ]
      },
      1_000
    );
    // Header carries the already-in-your-zone clause (exported builder, never a pinned literal).
    expect(digest.startsWith(timeConvertDigestHeader("Australia/Sydney"))).toBe(true);
    // The zone rides INSIDE the existing parens — `(` stays immediately after HH:MM.
    const successRow = "Argentina vs Egypt: 2026-07-07 16:00 (UTC) → 2026-07-08 02:00 (tomorrow, Australia/Sydney)";
    expect(digest).toContain(successRow);
    // Error rows carry no local time and stay zone-free (unchanged shape).
    expect(digest).toContain("2026-07-07 20:00 (UTC) → error: zone not stated by source");
    expect(digest).not.toContain("error: zone not stated by source, Australia/Sydney");
  });

  it("R1: without local_tz the legacy zone-less rendering is byte-stable (back-compat outputs)", () => {
    const digest = digestOutput(
      { results: [{ when: "2026-07-07 16:00", tz: "UTC", local: "2026-07-08 02:00", relative_day: "tomorrow" }] },
      1_000
    );
    expect(digest.startsWith(timeConvertDigestHeader(""))).toBe(true);
    expect(digest).toContain("2026-07-07 16:00 (UTC) → 2026-07-08 02:00 (tomorrow)");
    expect(digest).not.toContain("Australia/Sydney");
  });
});
