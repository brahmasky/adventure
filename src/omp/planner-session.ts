import { spawn, type ChildProcess } from "node:child_process";
import { buildChildEnv } from "./child-env.js";
import type { OmpConfig } from "./omp-config.js";
import { parseFrameLine, type OmpFrame } from "./omp-frames.js";
import type { ModelString } from "./model-string.js";

export interface PlannerSessionOptions {
  cfg: OmpConfig; sessionDir: string; cwd: string; systemPromptFile: string; extensions: string[]; skills?: string;
  bridgeSock: string; bridgeToken: string; model: ModelString; configFile: string; plannerProfile: string;
  sendTimeoutMs?: number; maxFrameBufferBytes?: number;
}

export function plannerArgs(o: PlannerSessionOptions): { file: string; args: string[] } {
  const omp = ["--profile", o.cfg.profile, "--mode", "rpc", "--config", o.configFile, "--session-dir", o.sessionDir,
    "--cwd", o.cwd, "--tools", "read,edit,write", ...o.extensions.flatMap((e) => ["-e", e]), "--no-extensions",
    "--no-rules", "--approval-mode", "yolo", "--model", `${o.model.provider}/${o.model.model}`,
    ...(o.model.effort ? ["--thinking", o.model.effort] : []), "--append-system-prompt", o.systemPromptFile];
  return o.cfg.sandbox ? { file: "sandbox-exec", args: ["-f", o.plannerProfile, o.cfg.bin, ...omp] } : { file: o.cfg.bin, args: omp };
}

export interface ExitInfo { code: number | null; signal: NodeJS.Signals | null; stopped: boolean }
type Waiter = { type: string; resolve: (d: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * A failed planner RPC. `code` is fixed — `command_failed:<type>` (omp answered success:false),
 * `timeout:<type>`, `not_running`, `exited`, `frame_too_large` — and is all that may reach an
 * error_ref or an incident. omp's own error text never rides it (it is logged to stderr, capped).
 */
export class PlannerRpcError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PlannerRpcError"; }
}
const OMP_ERROR_LOG_CAP = 200;
const MAX_FRAME_BUFFER = 64 * 1024 * 1024;

export class PlannerSession {
  private child: ChildProcess | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly frameCbs: Array<(f: OmpFrame) => void> = [];
  private readonly exitCbs: Array<(i: ExitInfo) => void> = [];
  private n = 0; private parts: string[] = []; private size = 0;
  private stopped = false; private closed = false; private cbErrorLogged = false;

  constructor(private readonly o: PlannerSessionOptions) {}
  get pid(): number | undefined { return this.child?.pid; }
  onFrame(cb: (f: OmpFrame) => void): void { this.frameCbs.push(cb); }
  onExit(cb: (i: ExitInfo) => void): void { this.exitCbs.push(cb); }

  async start(): Promise<{ resumed: boolean; sessionId: string }> {
    const { file, args } = plannerArgs(this.o);
    const env = { ...buildChildEnv(this.o.cfg.envPassthrough), HOUGE_BRIDGE_SOCK: this.o.bridgeSock, HOUGE_BRIDGE_TOKEN: this.o.bridgeToken };
    const child = spawn(file, args, { cwd: this.o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      this.onFrame((f) => { if (f.type === "ready") resolve(); });
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`planner exited ${code} before ready`)));
    });
    child.stdin?.on("error", () => undefined); // EPIPE: onClose rejects the waiters
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.onData(d));
    child.stderr?.on("data", () => undefined);
    child.on("close", (code, signal) => this.onClose(code, signal));
    await ready;
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
    if (this.closed || !this.child?.stdin?.writable) return Promise.reject(new PlannerRpcError("not_running"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new PlannerRpcError(`timeout:${String(cmd.type)}`));
      }, this.o.sendTimeoutMs ?? 30_000);
      this.waiters.set(id, { type: String(cmd.type), resolve, reject, timer });
      this.child?.stdin?.write(`${JSON.stringify({ ...cmd, id })}\n`);
    });
  }

  private rejectAll(err: Error): void {
    for (const w of this.waiters.values()) { clearTimeout(w.timer); w.reject(err); }
    this.waiters.clear();
  }

  private onData(chunk: string): void {
    const segs = chunk.split("\n");
    for (let k = 0; k < segs.length - 1; k++) {
      this.parts.push(segs[k] as string);
      const line = this.parts.join(""); this.parts = []; this.size = 0;
      this.dispatch(line);
    }
    const tail = segs[segs.length - 1] as string;
    this.parts.push(tail); this.size += tail.length;
    if (this.size > (this.o.maxFrameBufferBytes ?? MAX_FRAME_BUFFER)) {
      this.parts = []; this.size = 0;
      this.rejectAll(new PlannerRpcError("frame_too_large"));
      this.child?.kill("SIGKILL");
    }
  }

  private dispatch(line: string): void {
    const f = parseFrameLine(line);
    if (!f) return;
    if (f.type === "response" && typeof f.id === "string" && this.waiters.has(f.id)) {
      const w = this.waiters.get(f.id) as Waiter; this.waiters.delete(f.id); clearTimeout(w.timer);
      if (f.success !== false) { w.resolve(f.data); return; }
      console.error(`planner ${w.type} failed: ${String(f.error ?? "").slice(0, OMP_ERROR_LOG_CAP)}`);
      w.reject(new PlannerRpcError(`command_failed:${w.type}`));
      return;
    }
    for (const cb of this.frameCbs) {
      try { cb(f); } catch {
        if (!this.cbErrorLogged) { this.cbErrorLogged = true; console.error(`planner onFrame callback threw (frame type ${f.type})`); }
      }
    }
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.closed = true;
    this.rejectAll(new PlannerRpcError("exited"));
    for (const cb of this.exitCbs) cb({ code, signal, stopped: this.stopped });
  }

  async stop(): Promise<void> {
    if (this.stopped || !this.child) return;
    this.stopped = true;
    const c = this.child;
    if (this.closed) return;
    const timers: NodeJS.Timeout[] = [];
    const wait = (ms: number) => new Promise<void>((r) => { timers.push(setTimeout(r, ms)); });
    await Promise.race([this.abort().catch(() => undefined), wait(1_000)]);
    if (!this.closed) {
      const exited = new Promise<void>((r) => c.once("close", () => r()));
      c.kill("SIGTERM");
      await Promise.race([exited, wait(5_000)]);
      if (!this.closed) c.kill("SIGKILL");
    }
    for (const t of timers) clearTimeout(t);
  }
}
