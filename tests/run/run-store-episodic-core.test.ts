import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EPISODIC_CORE_CAP,
  resolveEpisodicCoreCap,
  RunStore
} from "../../src/run/run-store.js";

// Hermetic (self-write test-gate rule): pin the core cap (and the per-chat cap the
// save path reads) to their code defaults so a daemon .env override never flips these.
const EPISODIC_ENV_VARS = ["HOUGE_EPISODIC_CORE_CAP", "HOUGE_EPISODIC_FACT_CAP_PER_CHAT"] as const;
let savedEnv: Record<string, string | undefined> = {};
let dirs: string[] = [];
beforeEach(() => {
  savedEnv = {};
  for (const key of EPISODIC_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of EPISODIC_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const NOW = "2026-07-17T12:00:00.000Z";
const CHAT = "core-chat";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-episodic-core-"));
  dirs.push(dir);
  return join(dir, "houge.sqlite");
}

describe("2026-07-17-episodic-core migration", () => {
  it("is idempotent: reopening re-runs migrate() and is_core survives with existing rows", () => {
    const path = tempDbPath();
    const store = RunStore.open(path);
    const id = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", is_core: true, created_at: NOW });
    store.close();

    const reopened = RunStore.open(path);
    try {
      const row = reopened.getEpisodicFact(id);
      expect(row?.is_core).toBe(1);
      // A second reopen must not throw (ALTER guarded by table_info) or lose the row.
      reopened.close();
      const third = RunStore.open(path);
      expect(third.getEpisodicFact(id)?.fact).toBe("Paco lives in Sydney");
      third.close();
    } finally {
      // reopened already closed above in the happy path
    }
  });
});

describe("addEpisodicFact — is_core persistence", () => {
  it("defaults is_core to 0 and stores 1 when marked core", () => {
    const store = RunStore.open(tempDbPath());
    try {
      const pref = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco prefers concise answers", created_at: NOW });
      const bio = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", is_core: true, created_at: NOW });
      expect(store.getEpisodicFact(pref)?.is_core).toBe(0);
      expect(store.getEpisodicFact(bio)?.is_core).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("saveReconciledFact — is_core across ADD/UPDATE/SUPERSEDE", () => {
  it("ADD preserves the candidate's core flag", () => {
    const store = RunStore.open(tempDbPath());
    try {
      const r = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Sydney", is_core: true },
        { verdict: "ADD" },
        NOW
      );
      expect(store.getEpisodicFact(r.id!)?.is_core).toBe(1);
    } finally {
      store.close();
    }
  });

  it("SUPERSEDE: a NON-core item superseding a core row still inherits core (never demote biography)", () => {
    const store = RunStore.open(tempDbPath());
    try {
      const old = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", is_core: true, created_at: NOW });
      const r = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Melbourne", is_core: false },
        { verdict: "SUPERSEDE", id: old },
        NOW
      );
      expect(r.verb).toBe("supersede");
      expect(store.getEpisodicFact(r.id!)?.is_core).toBe(1); // inherited from the old core row
      expect(store.getEpisodicFact(old)?.status).toBe("superseded");
    } finally {
      store.close();
    }
  });

  it("SUPERSEDE: a core item superseding a non-core row is core (either side counts)", () => {
    const store = RunStore.open(tempDbPath());
    try {
      const old = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco is in Sydney", is_core: false, created_at: NOW });
      const r = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Sydney", is_core: true },
        { verdict: "SUPERSEDE", id: old },
        NOW
      );
      expect(store.getEpisodicFact(r.id!)?.is_core).toBe(1);
    } finally {
      store.close();
    }
  });

  it("UPDATE: a core supplement to a non-core row yields a core merged row", () => {
    const store = RunStore.open(tempDbPath());
    try {
      const old = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", is_core: false, created_at: NOW });
      const r = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Sydney CBD", is_core: true },
        { verdict: "UPDATE", id: old, text: "Paco lives in Sydney CBD" },
        NOW
      );
      expect(r.verb).toBe("update");
      expect(store.getEpisodicFact(r.id!)?.is_core).toBe(1);
    } finally {
      store.close();
    }
  });

  it("two non-core sides stay non-core", () => {
    const store = RunStore.open(tempDbPath());
    try {
      const old = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco likes tea", is_core: false, created_at: NOW });
      const r = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco likes green tea", is_core: false },
        { verdict: "SUPERSEDE", id: old },
        NOW
      );
      expect(store.getEpisodicFact(r.id!)?.is_core).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("getCoreEpisodicFacts", () => {
  it("returns only ACTIVE core rows, highest-salience first, and never non-core or superseded", () => {
    const store = RunStore.open(tempDbPath());
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "Paco prefers concise answers", is_core: false, created_at: NOW });
      store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", is_core: true, salience: 0.6, created_at: NOW });
      store.addEpisodicFact({ chat_id: CHAT, fact: "Paco is a software engineer", is_core: true, salience: 0.9, created_at: NOW });
      // A core row in a DIFFERENT chat must not leak.
      store.addEpisodicFact({ chat_id: "other", fact: "Someone else lives in Perth", is_core: true, created_at: NOW });
      // A superseded core row must not appear.
      const stale = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lived in Perth", is_core: true, created_at: NOW });
      store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Sydney now", is_core: true },
        { verdict: "SUPERSEDE", id: stale },
        NOW
      );

      const core = store.getCoreEpisodicFacts(CHAT);
      const facts = core.map((f) => f.fact);
      expect(facts).toContain("Paco is a software engineer");
      expect(facts).toContain("Paco lives in Sydney");
      expect(facts).not.toContain("Paco prefers concise answers");
      expect(facts).not.toContain("Someone else lives in Perth");
      expect(facts).not.toContain("Paco lived in Perth");
      // salience DESC: engineer (0.9) before Sydney (0.6).
      expect(facts.indexOf("Paco is a software engineer")).toBeLessThan(facts.indexOf("Paco lives in Sydney"));
    } finally {
      store.close();
    }
  });

  it("respects the cap resolver (explicit arg and env)", () => {
    const store = RunStore.open(tempDbPath());
    try {
      for (let i = 0; i < 5; i++) {
        store.addEpisodicFact({ chat_id: CHAT, fact: `core fact ${i}`, is_core: true, salience: 0.5, created_at: NOW });
      }
      expect(store.getCoreEpisodicFacts(CHAT, 2)).toHaveLength(2);
      process.env.HOUGE_EPISODIC_CORE_CAP = "3";
      expect(store.getCoreEpisodicFacts(CHAT)).toHaveLength(3);
    } finally {
      store.close();
    }
  });
});

describe("resolveEpisodicCoreCap", () => {
  it("defaults when unset", () => {
    expect(resolveEpisodicCoreCap({} as NodeJS.ProcessEnv)).toBe(DEFAULT_EPISODIC_CORE_CAP);
  });
  it("honors a valid positive integer, min 1", () => {
    expect(resolveEpisodicCoreCap({ HOUGE_EPISODIC_CORE_CAP: "3" } as unknown as NodeJS.ProcessEnv)).toBe(3);
    expect(resolveEpisodicCoreCap({ HOUGE_EPISODIC_CORE_CAP: "1" } as unknown as NodeJS.ProcessEnv)).toBe(1);
  });
  it("degrades garbage / zero / negative / float to the default", () => {
    for (const bad of ["0", "-2", "abc", "2.5", ""]) {
      expect(resolveEpisodicCoreCap({ HOUGE_EPISODIC_CORE_CAP: bad } as unknown as NodeJS.ProcessEnv)).toBe(
        DEFAULT_EPISODIC_CORE_CAP
      );
    }
  });
});
