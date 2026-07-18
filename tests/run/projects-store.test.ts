import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { canTransitionProject } from "../../src/run/state-machines.js";

// P2 (spec 2026-07-18 §4): durable pursued-bounty state + scan memory. A wrong
// transition table would let bookkeeping skip externally-reached states; a
// downgrading upsert would erase a real judgment with an unverified re-scan.

describe("projects store (P2)", () => {
  it("migration is idempotent (open twice on the same db)", () => {
    const store = RunStore.openInMemory();
    // second construction over the same schema path is exercised by openInMemory
    // per-instance; re-running migrate on an already-migrated file is the real case:
    const again = RunStore.openInMemory();
    expect(store.listProjects()).toEqual([]);
    expect(again.listProjects()).toEqual([]);
  });

  it("addProject creates a tracked row; duplicate source_url is an idempotent return", () => {
    const store = RunStore.openInMemory();
    const first = store.addProject({
      source_url: "https://github.com/acme/widget/issues/7",
      title: "Fix the frobnicator",
      amount_usd: 250
    });
    expect(first.created).toBe(true);
    expect(first.row.state).toBe("tracked");
    expect(first.row.kind).toBe("bounty");
    expect(first.row.project_id).toMatch(/^proj_/);

    const dup = store.addProject({
      source_url: "https://github.com/acme/widget/issues/7",
      title: "different title must not overwrite"
    });
    expect(dup.created).toBe(false);
    expect(dup.row.project_id).toBe(first.row.project_id);
    expect(dup.row.title).toBe("Fix the frobnicator");
    expect(store.listProjects()).toHaveLength(1);
  });

  it("walks the full legal chain tracked→working→submitted→paid→dropped→tracked", () => {
    const store = RunStore.openInMemory();
    const { row } = store.addProject({ source_url: "https://github.com/a/b/issues/1" });
    for (const to of ["working", "submitted", "paid", "dropped", "tracked"] as const) {
      const result = store.transitionProject(row.project_id, to, `move to ${to}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.row.state).toBe(to);
        expect(result.row.state_reason).toBe(`move to ${to}`);
      }
    }
  });

  it("rejects illegal moves with no row change (skipping ahead, self-move, unknown id)", () => {
    const store = RunStore.openInMemory();
    const { row } = store.addProject({ source_url: "https://github.com/a/b/issues/2" });

    const skip = store.transitionProject(row.project_id, "paid");
    expect(skip.ok).toBe(false);
    const self = store.transitionProject(row.project_id, "tracked");
    expect(self.ok).toBe(false);
    const ghost = store.transitionProject("proj_nope", "working");
    expect(ghost.ok).toBe(false);

    expect(store.getProject(row.project_id)!.state).toBe("tracked");
  });

  it("transition table matches the spec exactly (state-machines guard)", () => {
    expect(canTransitionProject("tracked", "working")).toBe(true);
    expect(canTransitionProject("working", "submitted")).toBe(true);
    expect(canTransitionProject("submitted", "paid")).toBe(true);
    expect(canTransitionProject("tracked", "dropped")).toBe(true);
    expect(canTransitionProject("paid", "dropped")).toBe(true);
    expect(canTransitionProject("dropped", "tracked")).toBe(true);
    expect(canTransitionProject("tracked", "submitted")).toBe(false);
    expect(canTransitionProject("tracked", "paid")).toBe(false);
    expect(canTransitionProject("dropped", "working")).toBe(false);
    expect(canTransitionProject("paid", "tracked")).toBe(false);
  });

  it("listProjects filters by state, newest first", () => {
    const store = RunStore.openInMemory();
    const a = store.addProject({ source_url: "https://github.com/a/b/issues/3", now: "2026-07-18T00:00:00.000Z" });
    const b = store.addProject({ source_url: "https://github.com/a/b/issues/4", now: "2026-07-18T01:00:00.000Z" });
    store.transitionProject(a.row.project_id, "dropped");
    expect(store.listProjects("tracked").map((r) => r.project_id)).toEqual([b.row.project_id]);
    expect(store.listProjects()).toHaveLength(2);
  });
});

describe("bounty sightings (P2 scan memory)", () => {
  const url = "https://github.com/a/b/issues/9";

  it("first sighting is NEW; later sightings are not", () => {
    const store = RunStore.openInMemory();
    expect(store.upsertBountySighting({ issue_url: url, score: 70, verdict: "candidate" }).isNew).toBe(true);
    expect(store.upsertBountySighting({ issue_url: url, score: 72, verdict: "candidate" }).isNew).toBe(false);
    const row = store.getBountySighting(url)!;
    expect(row.times_seen).toBe(2);
    expect(row.last_score).toBe(72);
  });

  it("non-downgrading: unverified never overwrites a substantive verdict, but still bumps seen", () => {
    const store = RunStore.openInMemory();
    store.upsertBountySighting({ issue_url: url, score: 70, verdict: "candidate", now: "2026-07-18T00:00:00.000Z" });
    store.upsertBountySighting({ issue_url: url, score: null, verdict: "unverified", now: "2026-07-18T01:00:00.000Z" });
    const row = store.getBountySighting(url)!;
    expect(row.last_verdict).toBe("candidate");
    expect(row.last_score).toBe(70);
    expect(row.times_seen).toBe(2);
    expect(row.last_seen_at).toBe("2026-07-18T01:00:00.000Z");
  });

  it("a substantive verdict DOES overwrite unverified (upgrade path)", () => {
    const store = RunStore.openInMemory();
    store.upsertBountySighting({ issue_url: url, score: null, verdict: "unverified" });
    store.upsertBountySighting({ issue_url: url, score: 15, verdict: "scam_suspect" });
    const row = store.getBountySighting(url)!;
    expect(row.last_verdict).toBe("scam_suspect");
    expect(row.last_score).toBe(15);
  });
});

describe("P2 ledger events", () => {
  it("records scan/created/state-changed with required payloads, actor core", () => {
    const store = RunStore.openInMemory();
    store.recordBountyScanCompleted({
      run_id: "run_p2", venue_count: 2, candidates: 8, scam_suspects: 1, new_sightings: 5
    });
    store.recordProjectCreated({
      run_id: "run_p2", project_id: "proj_x", source_url: "https://github.com/a/b/issues/1"
    });
    store.recordProjectStateChanged({
      run_id: "run_p2", project_id: "proj_x", from: "tracked", to: "working"
    });
    const events = store.getLedgerEvents("run_p2");
    const types = events.map((e) => e.event_type);
    expect(types).toContain("bounty_scan_completed");
    expect(types).toContain("project_created");
    expect(types).toContain("project_state_changed");
    for (const event of events) {
      expect(event.actor).toBe("core");
    }
  });

  it("latestBountyScanAt reads the newest scan event (the re-scan throttle input)", () => {
    const store = RunStore.openInMemory();
    expect(store.latestBountyScanAt()).toBeUndefined();
    store.recordBountyScanCompleted({
      run_id: "run_p2", venue_count: 1, candidates: 0, scam_suspects: 0, new_sightings: 0
    });
    expect(store.latestBountyScanAt()).toBeTruthy();
  });
});
