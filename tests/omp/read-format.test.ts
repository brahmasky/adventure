import { describe, expect, it } from "vitest";
import { TRUNCATED_NOTE } from "../../src/omp/extension/read-hook.js";
import { OMP_READ_FORMAT_DRIFT, readFormat, syncReadFormatDrift } from "../../src/omp/read-format.js";
import { RunStore } from "../../src/run/run-store.js";

// Nothing pins omp's version, and the secret mask was tested against one read shape (hashline header + `N:` prefixes).
// A shape nobody tested must page once per omp version: a mask reading an untested shape is a leak waiting for a key at
// line start. The shapes below were captured from omp 18.12.3 on 2026-10-21 (a plain, an empty, a paged and a missing file).
const PLAIN = "[notes.txt#0238]\n1:alpha one\n2:\n3:beta two\n4:api_key: PLANTEDVALUE12345678";
const EMPTY = "[empty.txt#5D05]\n1:";
const PAGED = "[big.txt#EE20]\n1:line 1 xxx\n300:line 300 xxx\n\n[Showing lines 1-300 of 4000. Use :301 to continue]";

describe("readFormat", () => {
  it("the tested shape is `prefixed`: header plus `N:`, `N|`, `N-M:` lines; a paged note, a blank line, an empty file and Houge's cap note pass", () => {
    for (const t of [PLAIN, EMPTY, PAGED, "[/tmp/c.txt#9F]\n7|# Netscape HTTP Cookie File\n8|.example", "[/tmp/e.env#2D]\n1-2|a=1\n4-5:b=2",
      `[/tmp/x.txt#1A]\n1:line\n${TRUNCATED_NOTE}`, "[/tmp/x.txt#1A]\n1234567890:ten digits"]) expect([t.slice(0, 24), readFormat(t)]).toEqual([t.slice(0, 24), "prefixed"]);
  });
  it("an untested shape is `unknown`: no header (omp's `rowPrefixes: false` text or an error message), a header with bare lines, or a new prefix form", () => {
    for (const t of ["alpha one\n\nbeta two", "Path 'missing.txt' not found", "[notes.txt#0238]\nalpha one\n2:beta", "[notes.txt#0238]\n1 | alpha\n2 | beta",
      "[notes.txt#0238]\n  1→alpha", "[notes.txt]\n1:alpha", ""]) expect([t.slice(0, 24), readFormat(t)]).toEqual([t.slice(0, 24), "unknown"]);
  });
});

describe("syncReadFormatDrift", () => {
  const env = {}; // no HOUGE_TELEGRAM_CHAT_ID: the row only
  it("an unknown shape opens omp_read_format_drift once per omp version; a prefixed read on that version resolves it", () => {
    const store = RunStore.openInMemory();
    syncReadFormatDrift(store, "18.13.0", "unknown", { env, now: "2026-10-21T10:00:00.000Z" });
    syncReadFormatDrift(store, "18.13.0", "unknown", { env, now: "2026-10-21T10:00:01.000Z" });
    expect(store.listOpenIncidents().filter((i) => i.kind === OMP_READ_FORMAT_DRIFT).map((i) => i.subject)).toEqual(["omp:18.13.0"]);
    syncReadFormatDrift(store, "18.13.0", "prefixed", { env, now: "2026-10-21T10:00:02.000Z" });
    expect(store.listOpenIncidents().filter((i) => i.kind === OMP_READ_FORMAT_DRIFT)).toEqual([]);
    store.close();
  });
  it("a prefixed read on another version leaves the drift open, and an unchecked version is the subject `omp:unknown`", () => {
    const store = RunStore.openInMemory();
    syncReadFormatDrift(store, null, "unknown", { env, now: "2026-10-21T10:00:00.000Z" });
    syncReadFormatDrift(store, "18.12.3", "prefixed", { env, now: "2026-10-21T10:00:01.000Z" });
    expect(store.listOpenIncidents().filter((i) => i.kind === OMP_READ_FORMAT_DRIFT).map((i) => i.subject)).toEqual(["omp:unknown"]);
    store.close();
  });
});
