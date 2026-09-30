import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentRefusedLine, TelegramNotificationAdapter } from "../../src/notifications/telegram-notification-adapter.js";
import { parseAttachments } from "../../src/omp/planner-supervisor.js";
import { writeSeatbeltProfiles } from "../../src/omp/seatbelt.js";
import { chatWorkspace, verifiedWorkspace } from "../../src/omp/workspace.js";

describe("chatWorkspace (fix round 1, M-5): one helper for the planner cwd, bash cwd and the attachment root", () => {
  it("places a chat's workspace under <data>/omp/workspace/chat-<id>", () => {
    expect(chatWorkspace("/d", "42")).toBe("/d/omp/workspace/chat-42");
    expect(chatWorkspace("/d", "-1001")).toBe("/d/omp/workspace/chat--1001");
  });
});

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A fake home holding an SSH canary, and a data dir whose chat-1 workspace the daemon created. */
function layout() {
  const F = realpathSync(mkdtempSync(join(tmpdir(), "houge-ws-"))); roots.push(F);
  const home = join(F, "home"); const data = join(F, "data");
  mkdirSync(join(home, ".ssh"), { recursive: true }); writeFileSync(join(home, ".ssh", "id_key"), "SSHCANARY\n");
  const ws = chatWorkspace(data, "1"); mkdirSync(ws, { recursive: true });
  return { F, home, data, ws };
}

async function sendAttach(data: string, ws: string) {
  const { attachments } = parseAttachments("done\n[[attach: .ssh/id_key]]", ws);
  const uploads: string[] = []; const texts: string[] = [];
  const client = {
    sendMessage: async (m: { text: string }) => { texts.push(m.text); return { message_id: 1 }; },
    sendDocument: async (d: { content: Uint8Array }) => { uploads.push(Buffer.from(d.content).toString()); }
  };
  const a = new TelegramNotificationAdapter(client as never, { workspaceFor: (c) => chatWorkspace(data, c) });
  await a.send({ target: { kind: "telegram", chat_id: "1" }, payload: { text: "done", attachments } } as never);
  return { uploads, texts };
}

describe("the chat workspace cannot be swapped for a symlink (security C2, A6)", () => {
  it("verifiedWorkspace accepts the real directory and refuses a symlink at any component from <data>/omp down", () => {
    const { F, data, ws } = layout();
    expect(verifiedWorkspace(ws)).toBe(ws);
    renameSync(ws, `${ws}.old`); symlinkSync(join(F, "home"), ws);
    expect(verifiedWorkspace(ws)).toBeNull();
    rmSync(ws); renameSync(`${ws}.old`, ws);
    const wsRoot = join(data, "omp", "workspace");
    renameSync(wsRoot, `${wsRoot}.real`); symlinkSync(`${wsRoot}.real`, wsRoot);
    expect(verifiedWorkspace(ws)).toBeNull();
  });

  it.runIf(process.platform === "darwin")("the reviewer's swap, run as the model's bash under shell.sb, is denied and the workspace stays a real dir", () => {
    const { F, home, data, ws } = layout();
    const { shell } = writeSeatbeltProfiles({ home, repo: join(F, "repo"), data });
    const r = spawnSync("/usr/bin/sandbox-exec", ["-f", shell, "/bin/bash", "-c", `cd ${ws} && mv ${ws} ${ws}.old && ln -s ${home} ${ws}`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Operation not permitted/);
    expect(lstatSync(ws).isDirectory()).toBe(true);
    expect(existsSync(`${ws}.old`)).toBe(false);
  });

  it.runIf(process.platform === "darwin")("sessions: the planner cannot move a chat's session dir either", () => {
    const { F, home, data } = layout();
    const ss = join(data, "omp", "sessions", "chat-1"); mkdirSync(ss, { recursive: true });
    const { planner } = writeSeatbeltProfiles({ home, repo: join(F, "repo"), data });
    const r = spawnSync("/usr/bin/sandbox-exec", ["-f", planner, "/bin/mv", ss, `${ss}.old`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(existsSync(ss)).toBe(true);
    expect(spawnSync("/usr/bin/sandbox-exec", ["-f", planner, "/bin/sh", "-c", `echo x > ${ss}/t.jsonl`]).status).toBe(0);
  });

  it("even if the swap happens (e.g. outside the sandbox), the daemon uploads nothing and says why", async () => {
    const { F, data, ws } = layout();
    renameSync(ws, `${ws}.old`); symlinkSync(join(F, "home"), ws);
    const { uploads, texts } = await sendAttach(data, ws);
    expect(uploads).toEqual([]);
    expect(texts.join("\n")).toContain(attachmentRefusedLine("id_key", "outside_workspace"));
  });
});
