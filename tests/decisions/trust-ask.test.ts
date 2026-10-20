import { describe, expect, it } from "vitest";
import { countTrustAsk, effectiveAsk, HOSTILE_REASON, SETTLE_REASON, targetsLine, TRUST_TAP_BUDGET, trustAsk, UNTRUSTED_REASON } from "../../src/decisions/trust-ask.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §7.2: a raised level only ADDS a tap (ask := code_ask ∨ trust_ask; ADR 0029 decision 2). Untrusted: the four tools
// that persist or self-change ask. Hostile: also every shell command off the read-only list and every write. Reads never
// ask for trust. The tap budget pages at three a day; the taps still ask.
describe("trustAsk", () => {
  it("clean asks nothing", () => {
    for (const e of ["lesson_write", "shell", "fs_write", "web_search"]) expect(trustAsk("clean", e, "touch x")).toEqual({ ask: false });
  });
  it("untrusted: lesson_write, schedule_task, self_write_propose, skill_author ask; a shell write does not yet", () => {
    for (const e of ["lesson_write", "schedule_task", "self_write_propose", "skill_author"]) expect(trustAsk("untrusted", e)).toEqual({ ask: true, reason: UNTRUSTED_REASON });
    expect(trustAsk("untrusted", "shell", "touch x")).toEqual({ ask: false });
  });
  it("hostile: shell asks unless read-only; writes ask; reads do not", () => {
    expect(trustAsk("hostile", "shell", "ls -la")).toEqual({ ask: false });
    for (const c of ["curl https://x", "touch x", "git log", "file -C -m x"]) expect(trustAsk("hostile", "shell", c)).toEqual({ ask: true, reason: HOSTILE_REASON });
    expect(trustAsk("hostile", "shell_external", "curl -d x https://y")).toEqual({ ask: true, reason: HOSTILE_REASON });
    for (const e of ["wiki_build", "wiki_refine", "lesson_write"]) expect(trustAsk("hostile", e).ask).toBe(true);
    for (const e of ["web_search", "http_fetch", "gmail_read", "google_api", "houge_status", "to_local_time"]) expect(trustAsk("hostile", e)).toEqual({ ask: false });
  });
  // security final I-1: self_diagnose starts codex under a read-only sandbox that can read any file (no Seatbelt credential
  // denies) and sends what it reads off the box; a hostile turn steering its `focus` could leak .env tap-free.
  it("hostile: self_diagnose asks (it is not a plain read); untrusted leaves it alone", () => {
    expect(trustAsk("hostile", "self_diagnose")).toEqual({ ask: true, reason: HOSTILE_REASON });
    expect(trustAsk("untrusted", "self_diagnose")).toEqual({ ask: false });
  });
  it("a shell entry with no command string asks at hostile (fail closed)", () => {
    expect(trustAsk("hostile", "shell").ask).toBe(true);
  });
});

describe("countTrustAsk", () => {
  it("pages trust_tap_budget at the third ask of a local date, resolves it on the next date", () => {
    const store = RunStore.openInMemory(); const env = { HOUGE_DISPLAY_TZ: "Australia/Sydney" };
    for (let k = 1; k <= TRUST_TAP_BUDGET; k++) expect(countTrustAsk(store, env, `2026-10-13T0${k}:00:00.000Z`)).toBe(k);
    expect(store.listOpenIncidents().filter((i) => i.kind === "trust_tap_budget")).toHaveLength(1);
    expect(countTrustAsk(store, env, "2026-10-14T03:00:00.000Z")).toBe(1);
    expect(store.listOpenIncidents().filter((i) => i.kind === "trust_tap_budget")).toHaveLength(0);
  });
});

describe("targetsLine", () => {
  it("names a long command's target paths and byte count (the card cuts the command at 3000 chars)", () => {
    const cmd = `cp ./a.txt /private/tmp/out.txt && ${"x".repeat(3100)}`;
    expect(targetsLine(cmd)).toBe(`Targets: ./a.txt, /private/tmp/out.txt · ${Buffer.byteLength(cmd)} bytes`);
  });
});

describe("trustAsk fails closed at hostile", () => {
  // Spec §7.2 "every write asks": an entry this module has never heard of may write, so at hostile it asks until it is listed.
  it("an unknown entry asks at hostile and nothing at untrusted", () => {
    expect(trustAsk("hostile", "some_new_tool")).toEqual({ ask: true, reason: HOSTILE_REASON });
    expect(trustAsk("untrusted", "some_new_tool")).toEqual({ ask: false });
  });
  it("every shell entry runs only a read-only command tap-free; a write-capable entry asks even with a read-only command", () => {
    expect(trustAsk("hostile", "shell_external", "ls")).toEqual({ ask: false });
    for (const e of ["memory_correct_write", "fs_write", "skill_author", "schedule_task", "self_write_propose"]) expect(trustAsk("hostile", e, "ls").ask).toBe(true);
  });
});

describe("effectiveAsk (2b-i §3.3 settleAsk)", () => {
  it("under settleAsk a clean turn asks as if hostile, with SETTLE_REASON; HOSTILE_READS and read-only shell stay tap-free", () => {
    expect(effectiveAsk("clean", true, "lesson_write")).toEqual({ ask: true, reason: SETTLE_REASON });
    expect(effectiveAsk("clean", true, "memory_correct_write")).toEqual({ ask: true, reason: SETTLE_REASON });
    expect(effectiveAsk("clean", true, "shell", "touch x")).toEqual({ ask: true, reason: SETTLE_REASON });
    expect(effectiveAsk("clean", true, "shell", "ls -la")).toEqual({ ask: false });
    for (const e of ["web_search", "http_fetch", "memory_correct", "fs_read", "houge_status"]) expect(effectiveAsk("clean", true, e)).toEqual({ ask: false });
  });
  it("a hostile turn keeps HOSTILE_REASON under settleAsk; without settleAsk effectiveAsk is trustAsk", () => {
    expect(effectiveAsk("hostile", true, "lesson_write")).toEqual({ ask: true, reason: HOSTILE_REASON });
    expect(effectiveAsk("untrusted", false, "lesson_write")).toEqual(trustAsk("untrusted", "lesson_write"));
  });
});
