import { spawn, type ChildProcess } from "node:child_process";
import { buildChildEnv, childTmpDir } from "./child-env.js";
import type { OmpConfig } from "./omp-config.js";
import { classifyOmpError, parseFrameLine, type OmpFrame } from "./omp-frames.js";
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
  return o.cfg.sandbox ? { file: "/usr/bin/sandbox-exec", args: ["-f", o.plannerProfile, o.cfg.bin, ...omp] } : { file: o.cfg.bin, args: omp };
}

export interface ExitInfo { code: number | null; signal: NodeJS.Signals | null; stopped: boolean }
type Waiter = { type: string; resolve: (d: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * A failed planner RPC. `code` is fixed — `command_failed:<type>` (omp answered success:false),
 * `timeout:<type>`, `not_running`, `exited`, `exited:<kind>` (the child died before `ready`; <kind> is
 * classifyOmpError over its stderr tail; `exited:model_missing` only for omp's exact `Model "…" not found` line, a looser
 * model mention is `exited:model_unconfirmed`), `frame_too_large` — and is all that may reach an
 * error_ref or an incident. omp's own error text never rides it (it is logged to stderr, capped).
 */
export class PlannerRpcError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PlannerRpcError"; }
}
const OMP_ERROR_LOG_CAP = 200;
/** In-memory only: classified on an exit before ready, never logged, never written to the ledger or an incident. */
const STDERR_TAIL_CAP = 4 * 1024;
/** omp 18.4.4's exact refusal of an unknown --model at start (live probe). Only this line is a model refusal. */
const OMP_MODEL_NOT_FOUND = /^Model ".+" not found$/m;
const MAX_FRAME_BUFFER = 64 * 1024 * 1024;

export class PlannerSession {
  private child: ChildProcess | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly frameCbs: Array<(f: OmpFrame) => void> = [];
  private readonly exitCbs: Array<(i: ExitInfo) => void> = [];
  private n = 0; private parts: string[] = []; private size = 0;
  private stopped = false; private closed = false; private cbErrorLogged = false;
  private stderrTail = "";

  constructor(private readonly o: PlannerSessionOptions) {}
  get pid(): number | undefined { return this.child?.pid; }
  onFrame(cb: (f: OmpFrame) => void): void { this.frameCbs.push(cb); }
  onExit(cb: (i: ExitInfo) => void): void { this.exitCbs.push(cb); }

  async start(): Promise<{ resumed: boolean; sessionId: string }> {
    const { file, args } = plannerArgs(this.o);
    const env = { ...buildChildEnv(this.o.cfg.envPassthrough), TMPDIR: childTmpDir(this.o.cwd),
      HOUGE_BRIDGE_SOCK: this.o.bridgeSock, HOUGE_BRIDGE_TOKEN: this.o.bridgeToken };
    // detached: its own process group. Seatbelt's `(deny signal (target others))` spares the sender's own GROUP, so a
    // planner sharing the daemon's group could signal the daemon. omp still exits on stdin EOF if the daemon dies.
    const child = spawn(file, args, { cwd: this.o.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      this.onFrame((f) => { if (f.type === "ready") resolve(); });
      child.once("error", reject);
      child.once("close", () => reject(new PlannerRpcError(this.exitBeforeReadyCode())));
    });
    child.stdin?.on("error", () => undefined); // EPIPE: onClose rejects the waiters
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.onData(d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-STDERR_TAIL_CAP); });
    child.on("close", (code, signal) => this.onClose(code, signal));
    await ready;
    return (await this.send({ type: "open_session", sessionDir: this.o.sessionDir })) as { resumed: boolean; sessionId: string };
  }

  /** omp rejects a bad --model at process start (live, 18.4.4): the stderr tail is classified to a fixed kind, never forwarded. */
  private exitBeforeReadyCode(): string {
    const tail = this.stderrTail.trim();
    this.stderrTail = ""; // classified once, then dropped: it never outlives the start failure
    if (tail.length === 0) return "exited";
    if (OMP_MODEL_NOT_FOUND.test(tail)) return "exited:model_missing";
    // a crash that merely mentions a model is not omp's refusal: it must stay a counted crash, never a fallback
    const kind = classifyOmpError(tail);
    return `exited:${kind === "model_missing" ? "model_unconfirmed" : kind}`;
  }

  prompt(text: string): Promise<void> { return this.send({ type: "prompt", message: text }).then(() => undefined); }
  steer(text: string): Promise<void> { return this.send({ type: "steer", message: text }).then(() => undefined); }
  abort(): Promise<void> { return this.send({ type: "abort" }).then(() => undefined); }
  async setModel(m: ModelString): Promise<void> {
    await this.send({ type: "set_model", provider: m.provider, modelId: m.model });
    if (m.effort) await this.send({ type: "set_thinking_level", level: m.effort });
  }

  /**
   * omp's `new_session` (memory A1 §6): a fresh transcript in the same session dir; the old file stays and the next
   * `open_session` resumes the newest (this one). `cancelled: true` means omp kept the old session.
   */
  async newSession(): Promise<{ cancelled: boolean }> {
    const data = (await this.send({ type: "new_session" })) as { cancelled?: unknown } | undefined;
    return { cancelled: data?.cancelled === true };
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
      this.signalGroup("SIGKILL");
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

  /** Signal the planner's whole process group (it is the leader): a helper it left behind goes with it. */
  private signalGroup(sig: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    try { process.kill(-pid, sig); } catch { /* the group is already gone */ }
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.closed = true;
    // reap whatever the leader left in its group (stopped or crashed alike): no orphan outlives the child. The group id
    // cannot be reused while a member is alive; an empty group answers ESRCH.
    this.signalGroup("SIGKILL");
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
      this.signalGroup("SIGTERM");
      await Promise.race([exited, wait(5_000)]);
      if (!this.closed) this.signalGroup("SIGKILL");
    }
    for (const t of timers) clearTimeout(t);
  }
}
