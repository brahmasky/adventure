import { spawn, type ChildProcess } from "node:child_process";
import { buildChildEnv } from "./child-env.js";
import type { OmpConfig } from "./omp-config.js";
import { parseFrameLine, type OmpFrame } from "./omp-frames.js";
import type { ModelString } from "./model-string.js";

export interface PlannerSessionOptions {
  cfg: OmpConfig; sessionDir: string; cwd: string; systemPromptFile: string; extensions: string[]; skills?: string;
  bridgeSock: string; bridgeToken: string; model: ModelString; configFile: string; plannerProfile: string;
}

export function plannerArgs(o: PlannerSessionOptions): { file: string; args: string[] } {
  const omp = ["--profile", o.cfg.profile, "--mode", "rpc", "--config", o.configFile, "--session-dir", o.sessionDir,
    "--cwd", o.cwd, "--tools", "read,edit,write", ...o.extensions.flatMap((e) => ["-e", e]), "--no-extensions",
    "--no-rules", "--approval-mode", "yolo", "--model", `${o.model.provider}/${o.model.model}`,
    ...(o.model.effort ? ["--thinking", o.model.effort] : []), "--append-system-prompt", o.systemPromptFile];
  return o.cfg.sandbox ? { file: "sandbox-exec", args: ["-f", o.plannerProfile, o.cfg.bin, ...omp] } : { file: o.cfg.bin, args: omp };
}

type Waiter = { resolve: (d: unknown) => void; reject: (e: Error) => void };

export class PlannerSession {
  private child: ChildProcess | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly frameCbs: Array<(f: OmpFrame) => void> = [];
  private readonly exitCbs: Array<(c: number | null) => void> = [];
  private ready: Promise<void> | undefined;
  private n = 0; private buf = ""; private stopped = false;

  constructor(private readonly o: PlannerSessionOptions) {}
  get pid(): number | undefined { return this.child?.pid; }
  onFrame(cb: (f: OmpFrame) => void): void { this.frameCbs.push(cb); }
  onExit(cb: (c: number | null) => void): void { this.exitCbs.push(cb); }

  async start(): Promise<{ resumed: boolean; sessionId: string }> {
    const { file, args } = plannerArgs(this.o);
    const env = { ...buildChildEnv(this.o.cfg.envPassthrough), HOUGE_BRIDGE_SOCK: this.o.bridgeSock, HOUGE_BRIDGE_TOKEN: this.o.bridgeToken };
    this.child = spawn(file, args, { cwd: this.o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.ready = new Promise((resolve, reject) => {
      this.onFrame((f) => { if (f.type === "ready") resolve(); });
      this.child?.once("error", reject);
      this.child?.once("close", (code) => reject(new Error(`planner exited ${code} before ready`)));
    });
    this.child.stdout?.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    this.child.stderr?.on("data", () => undefined);
    this.child.on("close", (code) => this.onClose(code));
    await this.ready;
    return (await this.send({ type: "open_session", sessionDir: this.o.sessionDir })) as { resumed: boolean; sessionId: string };
  }

  prompt(text: string): Promise<void> { return this.send({ type: "prompt", message: text }).then(() => undefined); }
  steer(text: string): Promise<void> { return this.send({ type: "steer", message: text }).then(() => undefined); }
  abort(): Promise<void> { return this.send({ type: "abort" }).then(() => undefined); }
  async setModel(m: ModelString): Promise<void> {
    await this.send({ type: "set_model", provider: m.provider, modelId: m.model });
    if (m.effort) await this.send({ type: "set_thinking_level", level: m.effort });
  }

  private send(cmd: Record<string, unknown>): Promise<unknown> {
    const id = `c${++this.n}`;
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("planner not running"));
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.child?.stdin?.write(`${JSON.stringify({ ...cmd, id })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk; let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const f = parseFrameLine(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1);
      if (!f) continue;
      if (f.type === "response" && typeof f.id === "string" && this.waiters.has(f.id)) {
        const w = this.waiters.get(f.id) as Waiter; this.waiters.delete(f.id);
        f.success === false ? w.reject(new Error(String(f.error ?? "command failed"))) : w.resolve(f.data);
        continue;
      }
      for (const cb of this.frameCbs) cb(f);
    }
  }

  private onClose(code: number | null): void {
    for (const w of this.waiters.values()) w.reject(new Error(`planner exited ${code}`));
    this.waiters.clear();
    for (const cb of this.exitCbs) cb(code);
  }

  async stop(): Promise<void> {
    if (this.stopped || !this.child) return;
    this.stopped = true;
    const c = this.child;
    if (c.exitCode !== null) return;
    await Promise.race([this.abort().catch(() => undefined), new Promise((r) => setTimeout(r, 1_000))]);
    c.kill("SIGTERM");
    const exited = new Promise((r) => c.once("close", r));
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    if (c.exitCode === null) c.kill("SIGKILL");
  }
}
