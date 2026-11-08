import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAttachment, inside, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, overCount, REFUSAL_TEXT } from "../../src/notifications/attachment-check.js";
import * as viaAdapter from "../../src/notifications/telegram-notification-adapter.js";
import { chatWorkspace } from "../../src/omp/workspace.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(join(d, "data", "omp", "workspace", "chat-1", "locked.txt"), 0o600); } catch { /* absent */ } rmSync(d, { recursive: true, force: true }); } });
function layout() {
  const root = mkdtempSync(join(tmpdir(), "hac-")); dirs.push(root);
  const ws = chatWorkspace(join(root, "data"), "1"); mkdirSync(ws, { recursive: true });
  return { root, ws, deps: { canUpload: true, workspace: () => ws } };
}

describe("attach.path's send predicate (spec R7 §4.2): today's checks, verbatim, two reasons split", () => {
  it("a regular file inside the verified workspace yields its exact bytes", () => {
    const { ws, deps } = layout(); writeFileSync(join(ws, "a.csv"), "x,y\n");
    const r = checkAttachment(join(ws, "a.csv"), deps);
    expect(typeof r).toBe("object");
    expect(Buffer.from((r as { bytes: Uint8Array }).bytes).toString()).toBe("x,y\n");
  });
  it("checks in today's order: unsupported before the workspace, the workspace before the file", () => {
    const { ws } = layout();
    const boom = () => { throw new Error("must not resolve the workspace"); };
    expect(checkAttachment(join(ws, "missing"), { canUpload: false, workspace: boom })).toBe("unsupported"); // the resolver is never called (adapter :88 before :89)
    expect(checkAttachment(join(ws, "missing"), { canUpload: true, workspace: () => undefined })).toBe("workspace_unverified");
  });
  it("a workspace replaced by a symlink is workspace_unverified (C2), not outside_workspace", () => {
    const { root, ws, deps } = layout(); writeFileSync(join(ws, "a.txt"), "a");
    renameSync(ws, join(root, "real")); symlinkSync(join(root, "real"), ws);
    expect(checkAttachment(join(ws, "a.txt"), deps)).toBe("workspace_unverified");
  });
  it("each file refusal names its own reason", () => {
    const { root, ws, deps } = layout();
    writeFileSync(join(ws, "big.bin"), ""); truncateSync(join(ws, "big.bin"), 21 * 1024 * 1024);
    mkdirSync(join(ws, "folder")); execFileSync("mkfifo", [join(ws, "x.pdf")]);
    writeFileSync(join(root, "secret.txt"), "S"); linkSync(join(root, "secret.txt"), join(ws, "notes.txt"));
    writeFileSync(join(root, "other.txt"), "O"); symlinkSync(join(root, "other.txt"), join(ws, "leak.txt")); // its own target: secret.txt has nlink 2
    writeFileSync(join(ws, "locked.txt"), "L"); chmodSync(join(ws, "locked.txt"), 0o000);
    expect(checkAttachment(join(ws, "big.bin"), deps)).toBe("too_large");
    expect(checkAttachment(join(ws, "folder"), deps)).toBe("not_a_file");
    expect(checkAttachment(join(ws, "x.pdf"), deps)).toBe("not_a_file"); // O_NONBLOCK: never blocks
    expect(checkAttachment(join(ws, "notes.txt"), deps)).toBe("linked");
    expect(checkAttachment(join(ws, "leak.txt"), deps)).toBe("outside_workspace");
    expect(checkAttachment(join(ws, "nothing.txt"), deps)).toBe("not_found");
    expect(checkAttachment(join(ws, "locked.txt"), deps)).toBe("unreadable"); // EACCES (the suite never runs as root)
  }, 2_000);
  it("a swap between the open and the re-check is changed", () => {
    const { ws } = layout(); writeFileSync(join(ws, "r.txt"), "one");
    const swap = (p: string) => { renameSync(p, join(ws, "old.txt")); writeFileSync(p, "two"); };
    expect(checkAttachment(join(ws, "r.txt"), { canUpload: true, workspace: () => ws, beforeRecheck: swap })).toBe("changed");
  });
  it("overCount is today's i >= MAX_ATTACHMENTS; the split reasons keep Paco's words", () => {
    expect(MAX_ATTACHMENTS).toBe(5); expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
    expect([0, 4, 5, 8].map(overCount)).toEqual([false, false, true, true]);
    expect(REFUSAL_TEXT.workspace_unverified).toBe("outside my workspace");
    expect(REFUSAL_TEXT.not_found).toBe("could not be read");
    expect(REFUSAL_TEXT.outside_workspace).toBe("outside my workspace");
    expect(REFUSAL_TEXT.unreadable).toBe("could not be read");
    expect(Object.keys(REFUSAL_TEXT).sort()).toEqual(["changed", "linked", "not_a_file", "not_found", "outside_workspace", "over_count", "send_failed", "too_large", "unreadable", "unsupported", "workspace_unverified"]);
  });
  it("inside: one helper, re-exported by the adapter", () => {
    expect([inside("/w", "/w/a"), inside("/w", "/w"), inside("/w", "/x"), inside("/w", "/w/../x")]).toEqual([true, false, false, false]);
    expect(viaAdapter.inside).toBe(inside); expect(viaAdapter.checkAttachment).toBe(checkAttachment); expect(viaAdapter.REFUSAL_TEXT).toBe(REFUSAL_TEXT);
  });
});
