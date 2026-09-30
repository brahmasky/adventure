// Runs inside the omp planner process. Protected (self-write guard). Imports nothing from Houge.
import { connect, type Socket } from "node:net";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
export interface Bridge { request(msg: Record<string, unknown>): Promise<any> }
let client: Bridge | null = null;

/** Names of stubs that actually registered with omp; shared by both extensions (same module instance). */
export const registered = new Set<string>();

function open(sock: string, token: string): Bridge {
  const s: Socket = connect(sock); const pending = new Map<string, Pending>(); let n = 0;
  s.setEncoding("utf8"); // multi-byte characters split across chunks arrive intact
  let parts: string[] = []; // pieces of the current unterminated line: joined only when a newline arrives
  const onLine = (line: string) => {
    try {
      const m = JSON.parse(line); const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(String(m.error))); }
    } catch { /* ignore malformed line */ }
  };
  s.on("data", (d: string) => {
    let rest = d;
    for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
      const line = parts.join("") + rest.slice(0, i); parts = []; rest = rest.slice(i + 1); onLine(line);
    }
    if (rest.length > 0) parts.push(rest);
  });
  const failAll = (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear(); if (client === bridge) client = null; };
  s.on("error", failAll); s.on("close", () => failAll(new Error("bridge closed")));
  s.write(`${JSON.stringify({ id: "hello", kind: "hello", token })}\n`);
  const bridge: Bridge = {
    request(msg) {
      const id = `r${++n}`;
      return new Promise((resolve, reject) => {
        if (s.destroyed) { reject(new Error("bridge closed")); return; }
        pending.set(id, { resolve, reject }); s.write(`${JSON.stringify({ ...msg, id })}\n`);
      });
    }
  };
  return bridge;
}

export function getBridge(): Bridge {
  if (client) return client;
  const sock = process.env.HOUGE_BRIDGE_SOCK; const token = process.env.HOUGE_BRIDGE_TOKEN;
  if (!sock || !token) return { request: () => Promise.reject(new Error("bridge_unavailable")) };
  client = open(sock, token);
  return client;
}

export function resetBridgeForTest(): void { client = null; registered.clear(); }
