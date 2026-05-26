import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";

describe("CoreWorker", () => {
  it("claims a queued run and writes a report", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-core-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    const store = RunStore.openInMemory();
    const gateway = new Gateway(store);
    gateway.intake(
      buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "summarize local project rules",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:core-test",
        source_reference: "argv"
      })
    );

    const worker = new CoreWorker(store, root);
    const result = await worker.executeOnce("worker-1");

    expect(result.status).toBe("completed");
    expect(result.report_path).toContain("report.md");
    store.close();
  });
});
