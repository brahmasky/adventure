import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_TRACK_ANCHOR_ERROR,
  PROJECT_TRACK_INVALID_URL_ERROR,
  PROJECT_UPDATE_INVALID_STATE_ERROR
} from "../../src/capabilities/bounty-intake.js";
import { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

// P2 (spec §carve-out + verifier MAJOR 2 / MINOR 6): the project_track anchor is the
// structural backstop against injection→write — it must refuse unseen URLs AND
// scam-judged sightings, and only the user's real message overrides the latter.

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

type ProjectToolRunner = {
  executeProjectTool(
    name: "project_track" | "project_update" | "project_list",
    claim: { run_id: string; contract: { objective: string } },
    input: Record<string, unknown>
  ): ToolAdapterResult;
};

function makeWorker(store: RunStore): ProjectToolRunner {
  const dir = mkdtempSync(join(tmpdir(), "houge-project-tools-"));
  dirs.push(dir);
  const worker = new CoreWorker(store, dir, async () => ({ ok: false, error: "no llm in this test" }));
  return worker as unknown as ProjectToolRunner;
}

const URL_A = "https://github.com/acme/widget/issues/7";

function claim(objective: string): { run_id: string; contract: { objective: string } } {
  return { run_id: "run_p2t", contract: { objective } };
}

describe("project_track anchor (P2)", () => {
  it("refuses an unseen URL not present in the user message (verifier MINOR 6)", () => {
    const store = RunStore.openInMemory();
    const worker = makeWorker(store);
    const result = worker.executeProjectTool("project_track", claim("跟进那个 bounty"), {
      source_url: URL_A
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(PROJECT_TRACK_ANCHOR_ERROR);
    expect(store.listProjects()).toHaveLength(0);
  });

  it("refuses a scam_suspect sighting — only the user's own message overrides (verifier MAJOR 2)", () => {
    const store = RunStore.openInMemory();
    const worker = makeWorker(store);
    store.upsertBountySighting({ issue_url: URL_A, score: 0, verdict: "scam_suspect" });

    const viaSighting = worker.executeProjectTool("project_track", claim("track it"), { source_url: URL_A });
    expect(viaSighting.ok).toBe(false);

    const viaUserMessage = worker.executeProjectTool(
      "project_track",
      claim(`我知道风险，就是要跟 ${URL_A}`),
      { source_url: URL_A }
    );
    expect(viaUserMessage.ok).toBe(true);
    expect(store.getLedgerEvents("run_p2t").map((e) => e.event_type)).toContain("project_created");
  });

  it("accepts a candidate sighting; duplicate track is idempotent and not re-ledgered", () => {
    const store = RunStore.openInMemory();
    const worker = makeWorker(store);
    store.upsertBountySighting({ issue_url: URL_A, score: 70, verdict: "candidate" });

    const first = worker.executeProjectTool("project_track", claim("pursue #1"), {
      source_url: URL_A, title: "Fix it", amount_usd: 500
    });
    expect(first.ok).toBe(true);
    const dup = worker.executeProjectTool("project_track", claim("pursue #1 again"), { source_url: URL_A });
    expect(dup.ok).toBe(true);
    expect(store.listProjects()).toHaveLength(1);
    const created = store.getLedgerEvents("run_p2t").filter((e) => e.event_type === "project_created");
    expect(created).toHaveLength(1);
  });

  it("rejects malformed URLs before any anchor lookup", () => {
    const store = RunStore.openInMemory();
    const worker = makeWorker(store);
    const result = worker.executeProjectTool("project_track", claim("x"), {
      source_url: "https://github.com/acme/widget/pull/7"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(PROJECT_TRACK_INVALID_URL_ERROR);
  });
});

describe("project_update / project_list (P2)", () => {
  it("walks a legal move with ledger, refuses illegal state and bad ids", () => {
    const store = RunStore.openInMemory();
    const worker = makeWorker(store);
    store.upsertBountySighting({ issue_url: URL_A, score: 70, verdict: "candidate" });
    const tracked = worker.executeProjectTool("project_track", claim("pursue"), { source_url: URL_A });
    expect(tracked.ok).toBe(true);
    const project_id = store.listProjects()[0]!.project_id;

    const move = worker.executeProjectTool("project_update", claim("started"), { project_id, state: "working" });
    expect(move.ok).toBe(true);
    expect(store.getProject(project_id)!.state).toBe("working");
    expect(store.getLedgerEvents("run_p2t").map((e) => e.event_type)).toContain("project_state_changed");

    const skip = worker.executeProjectTool("project_update", claim("paid!"), { project_id, state: "paid" });
    expect(skip.ok).toBe(false);
    const badState = worker.executeProjectTool("project_update", claim("x"), { project_id, state: "shipped" });
    expect(badState.ok).toBe(false);
    if (!badState.ok) expect(badState.error).toBe(PROJECT_UPDATE_INVALID_STATE_ERROR);
    const badId = worker.executeProjectTool("project_update", claim("x"), { project_id: "nope", state: "working" });
    expect(badId.ok).toBe(false);
  });

  it("project_list renders tracked rows code-owned", () => {
    const store = RunStore.openInMemory();
    const worker = makeWorker(store);
    const empty = worker.executeProjectTool("project_list", claim("状态"), {});
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.output.answer).toBe("No tracked projects.");

    store.upsertBountySighting({ issue_url: URL_A, score: 70, verdict: "candidate" });
    worker.executeProjectTool("project_track", claim("pursue"), { source_url: URL_A, title: "Fix it" });
    const list = worker.executeProjectTool("project_list", claim("状态"), {});
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(String(list.output.answer)).toContain("[tracked]");
      expect(String(list.output.answer)).toContain(URL_A);
    }
  });
});
