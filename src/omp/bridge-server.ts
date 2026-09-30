import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { encodeLine, LineDecoder, type BridgeRequest } from "./bridge-protocol.js";

type Handle = (req: BridgeRequest) => Promise<unknown>;

/** One listener per planner child (spec §4): every authenticated connection on it IS that child. */
export class BridgeServer {
  private readonly sockets = new Set<Socket>();
  private disconnect: (() => void) | undefined;
  private constructor(private readonly server: Server, private readonly path: string) {}

  static listen(path: string, token: string, handle: Handle): Promise<BridgeServer> {
    rmSync(path, { force: true });
    const server = createServer();
    const bridge = new BridgeServer(server, path);
    server.on("connection", (s) => bridge.accept(s, token, handle));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { chmodSync(path, 0o600); resolve(bridge); });
    });
  }

  onDisconnect(cb: () => void): void { this.disconnect = cb; }

  private accept(s: Socket, token: string, handle: Handle): void {
    this.sockets.add(s);
    const dec = new LineDecoder(); let authed = false;
    s.setEncoding("utf8"); // StringDecoder: a multi-byte character split across chunks arrives intact
    s.on("data", (d: string) => {
      const msgs = dec.push(d) as BridgeRequest[];
      if (dec.overflowed) { s.destroy(); return; }
      for (const msg of msgs) {
        if (!authed) {
          if (msg.kind === "hello" && msg.token === token) { authed = true; continue; }
          s.destroy(); return;
        }
        this.answer(s, msg, handle);
      }
    });
    s.on("close", () => { this.sockets.delete(s); if (authed) this.disconnect?.(); });
    s.on("error", () => s.destroy());
  }

  /** A handler failure becomes ok:false on the wire; it never throws into the daemon. */
  private answer(s: Socket, msg: BridgeRequest, handle: Handle): void {
    const write = (line: object) => { if (!s.destroyed) s.write(encodeLine(line)); };
    Promise.resolve().then(() => handle(msg)).then(
      (result) => write({ id: msg.id, ok: true, result }),
      (e: unknown) => write({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    );
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => { rmSync(this.path, { force: true }); resolve(); }));
  }
}
