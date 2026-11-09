import { describe, expect, it } from "vitest";
import { DISARM_FLAGS } from "../../src/config/disarm-posture.js";
import { mailPollMinutes, mailQuietWindow, mailTextDays, pacoAddress, pacoMailReadable, resolveMailEnabled } from "../../src/mail/flag.js";

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("mail flag", () => {
  it("resolveMailEnabled truth table, default off", () => {
    for (const v of ["1", "true", "YES", " on "]) expect(resolveMailEnabled(env({ HOUGE_MAIL_ENABLED: v }))).toBe(true);
    for (const v of ["0", "false", "", "maybe"]) expect(resolveMailEnabled(env({ HOUGE_MAIL_ENABLED: v }))).toBe(false);
    expect(resolveMailEnabled(env({}))).toBe(false);
  });
  it("mailPollMinutes clamps to [2,60], NaN and unset -> 5", () => {
    expect(mailPollMinutes(env({ HOUGE_MAIL_POLL_MIN: "1" }))).toBe(2);
    expect(mailPollMinutes(env({ HOUGE_MAIL_POLL_MIN: "99" }))).toBe(60);
    expect(mailPollMinutes(env({ HOUGE_MAIL_POLL_MIN: "x" }))).toBe(5);
    expect(mailPollMinutes(env({}))).toBe(5);
    expect(mailPollMinutes(env({ HOUGE_MAIL_POLL_MIN: "10" }))).toBe(10);
  });
  it("mailQuietWindow parses start-end, malformed -> 23-7", () => {
    expect(mailQuietWindow(env({ HOUGE_MAIL_QUIET: "22-6" }))).toEqual({ start: 22, end: 6 });
    expect(mailQuietWindow(env({}))).toEqual({ start: 23, end: 7 });
    for (const bad of ["x", "25-3", "1-", "22:6", "-1-5"]) expect(mailQuietWindow(env({ HOUGE_MAIL_QUIET: bad }))).toEqual({ start: 23, end: 7 });
  });
  it("mailTextDays default 30, min 1", () => {
    expect(mailTextDays(env({}))).toBe(30);
    expect(mailTextDays(env({ HOUGE_MAIL_TEXT_DAYS: "0" }))).toBe(1);
    expect(mailTextDays(env({ HOUGE_MAIL_TEXT_DAYS: "7" }))).toBe(7);
    expect(mailTextDays(env({ HOUGE_MAIL_TEXT_DAYS: "zz" }))).toBe(30);
  });
  it("pacoMailReadable needs both the env switch and the stored switch", () => {
    const on = { mailState: () => ({ enabled: true }) } as never;
    const off = { mailState: () => ({ enabled: false }) } as never;
    expect(pacoMailReadable(env({ HOUGE_MAIL_ENABLED: "1" }), on)).toBe(true);
    expect(pacoMailReadable(env({ HOUGE_MAIL_ENABLED: "1" }), off)).toBe(false);
    expect(pacoMailReadable(env({}), on)).toBe(false);
  });
  it("pacoAddress lower-cases and validates", () => {
    expect(pacoAddress(env({ HOUGE_PACO_GMAIL_ADDRESS: "Paco@Example.com" }))).toBe("paco@example.com");
    expect(pacoAddress(env({ HOUGE_PACO_GMAIL_ADDRESS: "not an address" }))).toBeUndefined();
    expect(pacoAddress(env({}))).toBeUndefined();
  });
  it("/disarm forces HOUGE_MAIL_ENABLED off", () => {
    expect(DISARM_FLAGS).toContain("HOUGE_MAIL_ENABLED");
  });
});
