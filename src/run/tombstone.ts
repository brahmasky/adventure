import { readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * Durable kill-switch tombstone (ADR 0018, Phase S-1).
 *
 * `/kill` writes this file; the BOOT gate in `src/cli.ts` checks it before starting the
 * daemon (or a `run`/`--once` invocation). Because launchd's `KeepAlive` is unconditional
 * (`deploy/launchd/com.houge.daemon.plist.template` — a plain exit would be relaunched
 * every `ThrottleInterval` 10s), a killed daemon does NOT exit: it **parks alive** — the
 * process stays up, idle, holding no Telegram poll, admitting no runs — so launchd is
 * satisfied and the agent is stopped.
 *
 * Revival is a documented MANUAL step by design (the whole point of a kill switch is that
 * nothing automatic can undo it): delete the tombstone file, then restart the daemon.
 *
 * FAIL-CLOSED: a tombstone that exists but cannot be read or parsed still kills — corrupting
 * the file must never revive the agent.
 */

/** Default tombstone path — repo root, beside `houge.daemon.lock` (cwd-relative). Gitignored. */
export const DEFAULT_TOMBSTONE_PATH = "houge.kill";

/** The manual revival command (per-user launchd job). */
export const REVIVE_COMMAND = "launchctl kickstart -k gui/$UID/com.houge.daemon";

/** What `/kill` records. All fields are best-effort on READ (a corrupt file still kills). */
export interface TombstoneRecord {
  killed_at?: string;
  by?: string;
  reason?: string;
}

export function resolveTombstonePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HOUGE_TOMBSTONE_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_TOMBSTONE_PATH;
}

/** Write the tombstone (JSON body). Returns the path written, for the ack/log line. */
export function writeTombstone(
  record: { killed_at: string; by: string; reason?: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const path = resolveTombstonePath(env);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/**
 * Read the tombstone. `null` means ABSENT (the only state that lets the daemon start).
 * Any present-but-unreadable or present-but-unparseable file returns a record with
 * unknown fields — a corrupt tombstone MUST still kill (fail-closed).
 */
export function readTombstone(env: NodeJS.ProcessEnv = process.env): TombstoneRecord | null {
  const path = resolveTombstonePath(env);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    // Only a confirmed ABSENT file clears the gate; an unreadable one (permissions,
    // I/O error) is treated as present — refuse to start on a file we can't inspect.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.killed_at === "string" ? { killed_at: record.killed_at } : {}),
      ...(typeof record.by === "string" ? { by: record.by } : {}),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {})
    };
  } catch {
    return {};
  }
}

/** Remove the tombstone. For tests and the manual revival step — nothing in the runtime calls this. */
export function clearTombstone(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(resolveTombstonePath(env), { force: true });
}

/** The Telegram ack `/kill` enqueues BEFORE signalling shutdown (the shutdown flush delivers it). */
export function formatKillAckText(path: string): string {
  return [
    "☠️ Kill switch engaged — the daemon is stopping now.",
    `launchd will relaunch the process, but it PARKS idle (no polling, no runs) while the tombstone exists.`,
    `Revive manually: delete ${path}, then run: ${REVIVE_COMMAND}`
  ].join("\n");
}

/** The single boot log line a parked (or refused) invocation prints. */
export function formatTombstoneParkedMessage(path: string): string {
  return (
    `kill-switch tombstone present at ${path} — parking idle (no Telegram polling, no runs). ` +
    `Revive manually: delete the file, then run: ${REVIVE_COMMAND}`
  );
}

// --- Park marker -------------------------------------------------------------------------
//
// The tombstone is deleted BEFORE revival, so by the time the daemon is back and the invariant
// sweep runs, nothing on disk says the silence was deliberate. The sweep then reads a heartbeat
// that stopped hours or days ago and opens a `heartbeat_gap` incident equal to the park duration
// — a false alarm on every single park (observed live 2026-09-06: "gap_minutes 2134" for a 35.6 h
// park). The park path is forbidden from touching the store (ADR 0018: construct nothing), but
// it already writes a file, so it leaves ONE more: a marker the sweep can read after revival.
//
// Lifecycle: written by the park path (idempotent across launchd relaunches while parked), read
// by the sweep to classify the gap as deliberate, removed by the daemon on its first successful
// poll cycle after revival. It is NOT a stop switch — deleting it revives nothing, it only
// changes how the next gap is reported — so it is deliberately absent from the self-write guard.

/** Default marker path — beside the tombstone. Gitignored. */
export const DEFAULT_PARK_MARKER_PATH = "houge.parked";

/** What the park path records. Best-effort on READ: a corrupt marker still counts as present. */
export interface ParkMarkerRecord {
  parked_at?: string;
  killed_at?: string;
  by?: string;
  reason?: string;
}

export function resolveParkMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HOUGE_PARK_MARKER_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_PARK_MARKER_PATH;
}

/** Write the marker (JSON body). Returns the path written. */
export function writeParkMarker(
  record: { parked_at: string } & Omit<ParkMarkerRecord, "parked_at">,
  env: NodeJS.ProcessEnv = process.env
): string {
  const path = resolveParkMarkerPath(env);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/**
 * Read the marker. `null` means ABSENT — the gap is unexplained and should be reported.
 * Present-but-unreadable or unparseable returns `{}`: the park happened even if its record is
 * damaged, so the gap is still deliberate.
 */
export function readParkMarker(env: NodeJS.ProcessEnv = process.env): ParkMarkerRecord | null {
  const path = resolveParkMarkerPath(env);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const pick = (key: keyof ParkMarkerRecord): Partial<ParkMarkerRecord> =>
      typeof record[key] === "string" ? { [key]: record[key] as string } : {};
    return { ...pick("parked_at"), ...pick("killed_at"), ...pick("by"), ...pick("reason") };
  } catch {
    return {};
  }
}

/** Remove the marker. Called once by the daemon after its first successful cycle post-revival. */
export function clearParkMarker(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(resolveParkMarkerPath(env), { force: true });
}
