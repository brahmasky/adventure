import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DISARM_FLAGS,
  disarmPosturePresent,
  formatDisarmAckText,
  formatRearmAckText,
  writeDisarmPosture
} from "../../src/config/disarm-posture.js";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { formatKillAckText, readTombstone } from "../../src/run/tombstone.js";
import { checkSelfWriteDiff } from "../../src/capabilities/self-write-guard.js";

const dir = mkdtempSync(join(tmpdir(), "houge-killswitch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// PINNED_ENV hermeticity: the gateway handlers read process.env for the tombstone/posture
// paths, and /disarm MUTATES the arming flags in process.env — pin + restore everything,
// and point both files at the temp dir so the repo root is never touched.
const PINNED_ENV = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", ...DISARM_FLAGS] as const;
const pinned = new Map<string, string | undefined>();
let seq = 0;

beforeEach(() => {
  for (const key of PINNED_ENV) {
    pinned.set(key, process.env[key]);
    delete process.env[key];
  }
  seq += 1;
  process.env.HOUGE_TOMBSTONE_PATH = join(dir, `case-${seq}.kill`);
  process.env.HOUGE_DISARM_PATH = join(dir, `case-${seq}.disarm`);
});

afterEach(() => {
  for (const key of PINNED_ENV) {
    const value = pinned.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function killEvent(overrides: Partial<Parameters<typeof buildTypedTaskEvent>[0]> = {}): TypedTaskEvent {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "kill",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: `telegram:kill-${seq}`,
    source_reference: `telegram:update:${seq}:message:1`,
    created_at: "2026-07-15T10:00:00.000Z",
    ...overrides
  });
}

function controlEvent(type: "disarm" | "rearm" | "status"): TypedTaskEvent {
  return buildTypedTaskEvent({
    source: "telegram",
    type,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: `telegram:${type}-${seq}`,
    source_reference: `telegram:update:${seq}:message:2`,
    created_at: "2026-07-15T10:00:00.000Z"
  });
}

describe("/kill (ADR 0018)", () => {
  it("writes the tombstone (by/killed_at/reason), enqueues the ack, and signals shutdown", () => {
    const store = RunStore.openInMemory();
    try {
      let shutdowns = 0;
      const gateway = new Gateway(store, undefined, undefined, undefined, {
        requestShutdown: () => { shutdowns += 1; }
      });

      const event = killEvent({ goal: "runaway loop" });
      const result = gateway.intake(event, "2026-07-15T10:00:00.000Z");

      expect(result).toEqual({ ok: true, status: "killed", run_id: "" });
      expect(readTombstone(process.env)).toEqual({
        killed_at: "2026-07-15T10:00:00.000Z",
        by: "paco",
        reason: "runaway loop"
      });
      expect(store.countNotificationsByIdempotencyKey(`${event.idempotency_key}:kill`)).toBe(1);
      expect(shutdowns).toBe(1);
    } finally {
      store.close();
    }
  });

  it("enqueues the ack BEFORE signalling shutdown — the shutdown flush must have it to deliver", () => {
    // WHY the order matters: the daemon exits right after the abort; an ack enqueued
    // after the signal could miss the final outbox flush and the operator would get a
    // dead daemon with no explanation of how to revive it.
    const store = RunStore.openInMemory();
    try {
      const event = killEvent();
      let ackQueuedAtShutdown = -1;
      let tombstoneAtShutdown: unknown = null;
      const gateway = new Gateway(store, undefined, undefined, undefined, {
        requestShutdown: () => {
          ackQueuedAtShutdown = store.countNotificationsByIdempotencyKey(`${event.idempotency_key}:kill`);
          tombstoneAtShutdown = readTombstone(process.env);
        }
      });

      gateway.intake(event, "2026-07-15T10:00:00.000Z");

      expect(ackQueuedAtShutdown).toBe(1); // already durable when the abort fires
      expect(tombstoneAtShutdown).not.toBeNull(); // and the tombstone is already down
    } finally {
      store.close();
    }
  });

  it("ack text is the exported formatter: tombstone path + manual revival steps", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = killEvent();
      gateway.intake(event, "2026-07-15T10:00:00.000Z");
      const claimed = store.claimNextNotification("test-sender", 30);
      expect(claimed?.payload.text).toBe(formatKillAckText(process.env.HOUGE_TOMBSTONE_PATH!));
    } finally {
      store.close();
    }
  });

  it("is idempotent: a redelivered /kill replays the verdict, one ack, ONE shutdown signal", () => {
    const store = RunStore.openInMemory();
    try {
      let shutdowns = 0;
      const gateway = new Gateway(store, undefined, undefined, undefined, {
        requestShutdown: () => { shutdowns += 1; }
      });
      const event = killEvent();

      const first = gateway.intake(event, "2026-07-15T10:00:00.000Z");
      const second = gateway.intake(event, "2026-07-15T10:00:05.000Z");

      expect(second).toEqual(first);
      expect(store.countNotificationsByIdempotencyKey(`${event.idempotency_key}:kill`)).toBe(1);
      expect(shutdowns).toBe(1);
    } finally {
      store.close();
    }
  });

  it("works WITHOUT a requestShutdown hook (--once/run contexts): tombstone written, ack queued", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store); // no hooks
      const event = killEvent();
      const result = gateway.intake(event, "2026-07-15T10:00:00.000Z");
      expect(result).toEqual({ ok: true, status: "killed", run_id: "" });
      expect(readTombstone(process.env)).not.toBeNull();
      expect(store.countNotificationsByIdempotencyKey(`${event.idempotency_key}:kill`)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("is EXEMPT from the per-chat command rate limit — the emergency stop can't be queued behind chatter", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store, undefined, undefined, undefined, { requestShutdown: () => {} });
      // Saturate the 60s window (5 accepted commands) for this actor+chat.
      for (let i = 0; i < 5; i += 1) {
        store.recordTelegramCommandAudit({
          actor_id: "paco",
          chat_id: "222",
          command: "turn",
          source_reference: `seed:${i}`,
          decision: "accepted",
          occurred_at: "2026-07-15T09:59:50.000Z"
        });
      }
      // A normal control command is refused…
      const status = gateway.intake(controlEvent("status"), "2026-07-15T10:00:00.000Z");
      expect(status).toMatchObject({ ok: false, error: { code: "TELEGRAM_RATE_LIMITED" } });
      // …but /kill goes through.
      const kill = gateway.intake(killEvent(), "2026-07-15T10:00:00.000Z");
      expect(kill).toEqual({ ok: true, status: "killed", run_id: "" });
    } finally {
      store.close();
    }
  });
});

describe("/disarm and /rearm (ADR 0018)", () => {
  it("/disarm writes the posture file, flips the flags LIVE, and acks what was disarmed", () => {
    const store = RunStore.openInMemory();
    try {
      process.env.HOUGE_SCHEDULER_ENABLED = "true";
      process.env.HOUGE_SELFWRITE_ENABLED = "true";
      const gateway = new Gateway(store);
      const event = controlEvent("disarm");

      const result = gateway.intake(event, "2026-07-15T10:00:00.000Z");

      expect(result).toEqual({ ok: true, status: "disarmed", run_id: "" });
      expect(disarmPosturePresent(process.env)).toBe(true);
      for (const flag of DISARM_FLAGS) expect(process.env[flag]).toBe("false"); // immediate effect
      const claimed = store.claimNextNotification("test-sender", 30);
      expect(claimed?.payload.text).toBe(formatDisarmAckText(process.env.HOUGE_DISARM_PATH!));
    } finally {
      store.close();
    }
  });

  it("/rearm deletes the posture file and acks that flags re-apply on the next restart", () => {
    const store = RunStore.openInMemory();
    try {
      writeDisarmPosture({ disarmed_at: "2026-07-15T09:00:00.000Z", by: "paco" }, process.env);
      const gateway = new Gateway(store);
      const event = controlEvent("rearm");

      const result = gateway.intake(event, "2026-07-15T10:00:00.000Z");

      expect(result).toEqual({ ok: true, status: "rearmed", run_id: "" });
      expect(existsSync(process.env.HOUGE_DISARM_PATH!)).toBe(false);
      const claimed = store.claimNextNotification("test-sender", 30);
      expect(claimed?.payload.text).toBe(formatRearmAckText(process.env.HOUGE_DISARM_PATH!));
    } finally {
      store.close();
    }
  });

  it("both are idempotent on the trigger key (one ack per delivered update)", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = controlEvent("disarm");
      const first = gateway.intake(event, "2026-07-15T10:00:00.000Z");
      const second = gateway.intake(event, "2026-07-15T10:00:05.000Z");
      expect(second).toEqual(first);
      expect(store.countNotificationsByIdempotencyKey(`${event.idempotency_key}:disarm`)).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("self-write guard covers the operator stop switches", () => {
  it("a self-write diff touching houge.kill / houge.disarm / the kill-switch modules is DENIED", () => {
    // A self-write that deletes the tombstone would revive a killed agent; one that edits
    // tombstone.ts could make readTombstone() always return null. Both are Paco's-hand-only.
    for (const path of [
      "houge.kill",
      "houge.disarm",
      "src/run/tombstone.ts",
      "src/config/disarm-posture.ts",
      "src/config/load-env.ts"
    ]) {
      for (const status of ["D", "M", "A"]) {
        const verdict = checkSelfWriteDiff([{ status, path, oldMode: "100644", newMode: "100644" }]);
        expect(verdict.allowed, `${status} ${path} must be denied`).toBe(false);
      }
    }
  });
});
