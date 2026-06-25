import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { selfWriteBranchName } from "../../src/run/branch-publish.js";
import { handleSelfWriteAction } from "../../src/telegram/self-write-action-handler.js";
import type { MergeActionDeps, MergeOutcome } from "../../src/capabilities/self-write-merge.js";
import type { SelfWriteActionEvent } from "../../src/triggers/telegram-trigger-adapter.js";
import type { SelfWriteCallbackAction } from "../../src/triggers/telegram-command-parser.js";

const RUN_ID = "run_42";
const CHAT_ID = "777";
const BRANCH = selfWriteBranchName(RUN_ID);

interface ClientLog {
  answered: string[];
  cleared: Array<{ chat_id: string; message_id: number }>;
  sent: string[];
}

/** A Telegram client fake recording every call. */
function makeClient(log: ClientLog) {
  return {
    async sendMessage(input: { chat_id: string; text: string }) {
      log.sent.push(input.text);
      return { message_id: log.sent.length };
    },
    async answerCallbackQuery(input: { callback_query_id: string }) {
      log.answered.push(input.callback_query_id);
    },
    async editMessageReplyMarkup(input: { chat_id: string; message_id: number }) {
      log.cleared.push({ chat_id: input.chat_id, message_id: input.message_id });
    }
  };
}

/** Build a normalized self-write action event (M2 already authorized it). */
function event(action: SelfWriteCallbackAction): SelfWriteActionEvent {
  return {
    type: "selfwrite_action",
    action,
    runId: RUN_ID,
    callback_id: "cb_1",
    chat_id: CHAT_ID,
    message_id: 55,
    from: { kind: "user", id: "paco" },
    source_reference: "telegram:update:1:callback:cb_1",
    idempotency_key: "telegram:1:callback:cb_1"
  };
}

interface DepsLog {
  viewed: string[];
  discarded: string[];
  merged: Array<{ branch: string; push: boolean }>;
  durable: string[];
}

/**
 * Mock merge-action deps. The high-level capability functions (viewDiff/discardBranch/
 * mergeAndReload) call these primitives — we feed a fixed outcome per test so NO real
 * git/build/restart runs. `mergeOutcome` lets each test drive mergeAndReload's branches by
 * controlling what the primitives report (e.g. merge throws → conflict).
 */
function makeDeps(log: DepsLog, opts: { mergeOutcome?: MergeOutcome; diff?: string; branchExists?: boolean } = {}) {
  const branchExists = opts.branchExists ?? true;
  const outcome = opts.mergeOutcome ?? { kind: "reloaded", pushed: false };
  return (notifyDurable: (text: string) => void): MergeActionDeps => ({
    branchExists: (b) => {
      if (outcome.kind === "not_found") return false;
      return branchExists && b === BRANCH;
    },
    isMerged: () => outcome.kind === "already_merged",
    diff: (b) => { log.viewed.push(b); return opts.diff ?? ""; },
    merge: () => {
      if (outcome.kind === "merge_conflict") throw new Error(outcome.detail);
    },
    resetMerge: () => {},
    preMergeRef: () => "PRE",
    build: () => ({ ok: !(outcome.kind === "reverted" && outcome.stage === "build") }),
    testGate: () => ({ green: !(outcome.kind === "reverted" && outcome.stage === "test"), stage: "test", output: "red" }),
    deleteBranch: (b) => { log.discarded.push(b); },
    notifyDurable: (t) => { log.durable.push(t); notifyDurable(t); },
    restart: () => {},
    push: () => {}
  });
}

function run(
  action: SelfWriteCallbackAction,
  store: RunStore,
  client: ReturnType<typeof makeClient>,
  deps: ReturnType<typeof makeDeps>,
  push = false
): Promise<void> {
  return handleSelfWriteAction({
    event: event(action),
    telegramClient: client,
    projectRoot: "/fake/root",
    store,
    makeDeps: deps,
    resolvePush: () => push
  });
}

function freshLogs(): { client: ClientLog; deps: DepsLog } {
  return {
    client: { answered: [], cleared: [], sent: [] },
    deps: { viewed: [], discarded: [], merged: [], durable: [] }
  };
}

describe("handleSelfWriteAction", () => {
  it("view → answers the callback, runs viewDiff, sends the diff, and LEAVES the buttons in place", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("view", store, client, makeDeps(dl, { diff: "diff --git a b" }));
      // Spinner stopped.
      expect(cl.answered).toEqual(["cb_1"]);
      // Read-only diff was taken against the run's branch.
      expect(dl.viewed).toEqual([BRANCH]);
      // The diff was sent to the chat.
      expect(cl.sent.some((t) => t.includes("diff --git a b"))).toBe(true);
      // View is repeatable → buttons NOT cleared.
      expect(cl.cleared).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("discard → CLEARS the buttons FIRST (idempotency), deletes the branch, confirms", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("discard", store, client, makeDeps(dl));
      expect(cl.answered).toEqual(["cb_1"]);
      // Buttons cleared on the SAME message before the action (no re-tap).
      expect(cl.cleared).toEqual([{ chat_id: CHAT_ID, message_id: 55 }]);
      // Branch deleted.
      expect(dl.discarded).toEqual([BRANCH]);
      // Confirmation sent.
      expect(cl.sent.some((t) => t.includes("Discarded") && t.includes(BRANCH))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("merge happy (reloaded) → clears buttons FIRST, calls mergeAndReload with the branch + push flag, enqueues the DURABLE reload beacon", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "reloaded", pushed: true } }), true);
      expect(cl.answered).toEqual(["cb_1"]);
      // Buttons cleared BEFORE the slow merge (no double-tap).
      expect(cl.cleared).toEqual([{ chat_id: CHAT_ID, message_id: 55 }]);
      // The "merged, reloading…" message is DURABLE (persisted in the outbox, survives restart) —
      // not an inline send, since the process is about to be killed.
      expect(dl.durable).toEqual(["merged, reloading…"]);
      // It was PERSISTED to the durable outbox (survives the restart), targeting the tapper's chat.
      const queued = store.claimNextNotification("test-claim", 60);
      expect(queued).not.toBeNull();
      expect(queued!.target).toMatchObject({ kind: "telegram", chat_id: CHAT_ID });
      expect(queued!.payload.text).toBe("merged, reloading…");
      expect(queued!.intent_type).toBe("final_report");
      // No inline "reloaded" message (handled by the durable beacon).
      expect(cl.sent).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("merge reverted → tells the user the gate went red and the OLD code is still running", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "reverted", stage: "test", detail: "red" } }));
      expect(cl.cleared.length).toBe(1);
      const msg = cl.sent.join("\n");
      expect(msg).toContain("reverted");
      expect(msg).toContain("old code");
      expect(msg).toContain("test");
    } finally {
      store.close();
    }
  });

  it("merge conflict → tells the user it's theirs to resolve, with the detail", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "merge_conflict", detail: "CONFLICT in foo.ts" } }));
      const msg = cl.sent.join("\n");
      expect(msg).toContain("conflict");
      expect(msg).toContain("CONFLICT in foo.ts");
    } finally {
      store.close();
    }
  });

  it("merge already_merged → says so", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "already_merged" } }));
      expect(cl.sent.some((t) => t.includes("already merged"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("merge not_found → says the branch is gone", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "not_found" } }));
      expect(cl.sent.some((t) => t.includes("not found"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("IDEMPOTENCY: tapping [Merge] twice never double-merges or double-restarts (second tap no-ops)", async () => {
    // Mandate 4 — a real double-tap sequence at the HANDLER level. First tap merges + restarts;
    // the branch is now an ancestor of main, so a stale second tap must hit the `isMerged` no-op
    // and produce `already_merged` with NO second merge, NO second restart, NO second durable beacon.
    const store = RunStore.openInMemory();
    const { client: cl } = freshLogs();
    const client = makeClient(cl);
    try {
      // A deps factory whose `isMerged` flips to true once `merge` has run — exactly what git would
      // report after the first successful merge. Records merge/restart/durable so we can count them.
      let merged = false;
      const restarts: number[] = [];
      const merges: number[] = [];
      const durables: string[] = [];
      const deps = (notifyDurable: (text: string) => void): MergeActionDeps => ({
        branchExists: () => true,
        isMerged: () => merged,
        diff: () => "",
        merge: () => { merges.push(1); merged = true; },
        resetMerge: () => {},
        preMergeRef: () => "PRE",
        build: () => ({ ok: true }),
        testGate: () => ({ green: true, stage: "test", output: "" }),
        deleteBranch: () => {},
        notifyDurable: (t) => { durables.push(t); notifyDurable(t); },
        restart: () => { restarts.push(1); },
        push: () => {}
      });

      await run("merge", store, client, deps);
      await run("merge", store, client, deps); // stale second tap

      // Exactly one real merge + one restart + one reload beacon — the second tap was inert.
      expect(merges).toEqual([1]);
      expect(restarts).toEqual([1]);
      expect(durables).toEqual(["merged, reloading…"]);
      // The second tap reported "already merged".
      expect(cl.sent.some((t) => t.includes("already merged"))).toBe(true);
      // Buttons were cleared on BOTH taps (best-effort), but only one merge ran.
      expect(cl.cleared.length).toBe(2);
    } finally {
      store.close();
    }
  });

  it("never throws even if the merge deps blow up — maps to a sent message", async () => {
    const store = RunStore.openInMemory();
    const { client: cl } = freshLogs();
    const client = makeClient(cl);
    // Deps whose primitives throw synchronously inside mergeAndReload's body — but mergeAndReload
    // itself never throws, so to force the handler's own catch we make a deps factory that throws.
    const explodingDeps = (): never => { throw new Error("boom"); };
    try {
      await handleSelfWriteAction({
        event: event("merge"),
        telegramClient: client,
        projectRoot: "/fake/root",
        store,
        makeDeps: explodingDeps as never
      });
      expect(cl.sent.some((t) => t.includes("Something went wrong"))).toBe(true);
    } finally {
      store.close();
    }
  });
});
