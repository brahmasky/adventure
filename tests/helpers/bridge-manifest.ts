import { connect, type Socket } from "node:net";

/**
 * Plays the omp extension's side of the bridge at load time (src/omp/extension/bridge-client.ts):
 * hello with the minted token, then one manifest request. Resolves once both lines are written;
 * the caller owns the socket and destroys it when its fake child "exits". Tests only.
 */
export function openManifestClient(sock: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(sock);
    s.once("error", reject);
    s.once("connect", () => {
      s.on("error", () => s.destroy());
      s.write(`${JSON.stringify({ id: "hello", kind: "hello", token })}\n`);
      s.write(`${JSON.stringify({ id: "r1", kind: "manifest" })}\n`);
      resolve(s);
    });
  });
}
