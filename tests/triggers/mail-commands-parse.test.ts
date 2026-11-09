import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseMailCallback, parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";

// Spec 2026-11-09 §3.6: /inbox, /mail and /mail_undo are slash-only typed commands; the card taps are pinned callback shapes that
// carry ids only (never an address) and fit Telegram's 64-byte callback_data.
const item = `mi_${randomUUID()}`;
const rule = `mr_${randomUUID()}`;

describe("mail command parsing", () => {
  it("/inbox and /inbox all", () => {
    expect(parseTelegramCommand("/inbox")).toEqual({ ok: true, command: { type: "inbox", all: false } });
    expect(parseTelegramCommand("/inbox@houge_bot all")).toEqual({ ok: true, command: { type: "inbox", all: true } });
    expect(parseTelegramCommand("/inbox everything")).toMatchObject({ ok: false });
    expect(parseTelegramCommand("/inbox all extra")).toMatchObject({ ok: false });
  });
  it("/mail on|off|status, bare /mail is status, anything else is invalid", () => {
    for (const a of ["on", "off", "status"] as const) expect(parseTelegramCommand(`/mail ${a}`)).toEqual({ ok: true, command: { type: "mail", action: a } });
    expect(parseTelegramCommand("/mail")).toEqual({ ok: true, command: { type: "mail", action: "status" } });
    expect(parseTelegramCommand("/mail purge")).toMatchObject({ ok: false });
    expect(parseTelegramCommand("/mail on now")).toMatchObject({ ok: false });
  });
  it("/mail_undo takes exactly one mr_<uuid>", () => {
    expect(parseTelegramCommand(`/mail_undo ${rule}`)).toEqual({ ok: true, command: { type: "mail_undo", rule_id: rule } });
    for (const bad of ["/mail_undo", "/mail_undo mr_1", `/mail_undo ${item}`, `/mail_undo ${rule} ${rule}`, `/mail_undo ${rule.toUpperCase()}`]) {
      expect(parseTelegramCommand(bad), bad).toMatchObject({ ok: false });
    }
  });
});

describe("parseMailCallback", () => {
  it("round-trips every item action and the page tap", () => {
    for (const action of ["wu", "never", "always", "shp"] as const) expect(parseMailCallback(`mail:${action}:${item}`)).toEqual({ action, item_id: item });
    expect(parseMailCallback("mail:page:2")).toEqual({ action: "page", page: 2 });
    expect(parseMailCallback("mail:page:9999")).toEqual({ action: "page", page: 9999 });
  });
  it("rejects the near misses", () => {
    for (const bad of [`mail:wu:${rule}`, `mail:other:${item}`, `mail:wu:${item.toUpperCase()}`, `mail:wu:${item}x`, "mail:page:0", "mail:page:10000", "mail:page:01", "mail:page:-1", "mail:page:", `xmail:wu:${item}`, 5, null, undefined]) {
      expect(parseMailCallback(bad), String(bad)).toBeNull();
    }
  });
  it("every shape fits Telegram's 64-byte callback_data", () => {
    for (const action of ["wu", "never", "always", "shp"]) expect(Buffer.byteLength(`mail:${action}:${item}`)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength("mail:page:9999")).toBeLessThanOrEqual(64);
  });
});
