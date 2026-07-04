import { beforeEach, describe, expect, it } from "vitest";
import {
  evolutionLaneSettled,
  resetEvolutionLaneForTests,
  tryStartEvolutionPipeline
} from "../../src/core/evolution-lane.js";
import { RunStore } from "../../src/run/run-store.js";
import { selfWriteBranchName } from "../../src/run/branch-publish.js";
import { handleSelfWriteAction, resetViewTapDedupeForTests } from "../../src/telegram/self-write-action-handler.js";
import type { MergeActionDeps, MergeOutcome } from "../../src/capabilities/self-write-merge.js";
import type { SelfWriteActionEvent } from "../../src/triggers/telegram-trigger-adapter.js";
import type { SelfWriteCallbackAction } from "../../src/triggers/telegram-command-parser.js";

const RUN_ID = "run_42";
const CHAT_ID = "777";
const BRANCH = selfWriteBranchName(RUN_ID);

// ⓪·3g: the view-tap dedupe window is module state keyed on (view, runId) — clear it so
// the many view tests here (all on RUN_ID) exercise the handler, not the dedupe. The
// evolution lane is module state too (the F1 merge refusal consults it) — keep it idle.
beforeEach(() => {
  resetViewTapDedupeForTests();
  resetEvolutionLaneForTests();
});

/** ⓪·3g: the immediate merge ack sent right after the buttons are cleared. */
const MERGE_ACK = "正在合并，跑门禁要几分钟，完事我喊你 🐒";

interface ClientLog {
  answered: string[];
  cleared: Array<{ chat_id: string; message_id: number }>;
  /** H4: editMessageReplyMarkup calls that RE-ATTACH a keyboard (reply_markup present). */
  restored: Array<{ chat_id: string; message_id: number; reply_markup: unknown }>;
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
    async editMessageReplyMarkup(input: { chat_id: string; message_id: number; reply_markup?: unknown }) {
      if (input.reply_markup) {
        log.restored.push({ chat_id: input.chat_id, message_id: input.message_id, reply_markup: input.reply_markup });
      } else {
        log.cleared.push({ chat_id: input.chat_id, message_id: input.message_id });
      }
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
    writeReloadMarker: () => {},
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
    client: { answered: [], cleared: [], restored: [], sent: [] },
    deps: { viewed: [], discarded: [], merged: [], durable: [] }
  };
}

/** The exact keyboard a published notification carries (what H4 must restore). */
const RESTORED_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🔀 Merge & reload", callback_data: `selfwrite:merge:${RUN_ID}` },
      { text: "👀 View diff", callback_data: `selfwrite:view:${RUN_ID}` },
      { text: "🗑 Discard", callback_data: `selfwrite:discard:${RUN_ID}` }
    ]
  ]
};

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
      // ⓪·3g: the ONLY inline send is the immediate "merging…" ack — the "reloaded"
      // outcome itself still rides the durable beacon, never an inline message.
      expect(cl.sent).toEqual([MERGE_ACK]);
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
        writeReloadMarker: () => {},
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

  it("H4 merge_conflict → clears the keyboard FIRST, reports, then RESTORES the exact original keyboard", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "merge_conflict", detail: "CONFLICT in foo.ts" } }));
      // Anti-double-tap clear still happened, on the same message.
      expect(cl.cleared).toEqual([{ chat_id: CHAT_ID, message_id: 55 }]);
      // The refusal was reported, THEN the keyboard came back (branch still exists — retry is one tap away).
      expect(cl.restored).toEqual([{ chat_id: CHAT_ID, message_id: 55, reply_markup: RESTORED_KEYBOARD }]);
    } finally {
      store.close();
    }
  });

  it("H4 reverted (test-gate red) → keyboard restored after the report", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "reverted", stage: "test", detail: "red" } }));
      expect(cl.restored).toEqual([{ chat_id: CHAT_ID, message_id: 55, reply_markup: RESTORED_KEYBOARD }]);
    } finally {
      store.close();
    }
  });

  it("H4 reverted (build red / dirty-tree deps failure) → keyboard restored", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "reverted", stage: "build", detail: "dirty tree" } }));
      expect(cl.restored.length).toBe(1);
    } finally {
      store.close();
    }
  });

  it("H4 success (reloaded) keeps the keyboard CLEARED — no restore", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "reloaded", pushed: false } }));
      expect(cl.cleared.length).toBe(1);
      expect(cl.restored).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("H4 not_found / already_merged (branch gone or landed) stay cleared — nothing to re-offer", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "not_found" } }));
      await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "already_merged" } }));
      expect(cl.restored).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("H4 discard still clears without restoring", async () => {
    const store = RunStore.openInMemory();
    const { client: cl, deps: dl } = freshLogs();
    const client = makeClient(cl);
    try {
      await run("discard", store, client, makeDeps(dl));
      expect(cl.cleared.length).toBe(1);
      expect(cl.restored).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("H4 a send-only client (no editMessageReplyMarkup) never crashes the restore path", async () => {
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    const sendOnlyClient = {
      async sendMessage(input: { chat_id: string; text: string }) {
        sent.push(input.text);
        return { message_id: sent.length };
      }
    };
    const { deps: dl } = freshLogs();
    try {
      await handleSelfWriteAction({
        event: event("merge"),
        telegramClient: sendOnlyClient,
        projectRoot: "/fake/root",
        store,
        makeDeps: makeDeps(dl, { mergeOutcome: { kind: "merge_conflict", detail: "CONFLICT" } }),
        resolvePush: () => false
      });
      // The refusal was still reported; the missing optional method was tolerated.
      expect(sent.some((t) => t.includes("conflict"))).toBe(true);
    } finally {
      store.close();
    }
  });

  describe("[View diff] rendering (⓪·2c U1)", () => {
    const SMALL_DIFF = [
      "diff --git a/src/skills/clock.ts b/src/skills/clock.ts",
      "index abc123..def456 100644",
      "--- a/src/skills/clock.ts",
      "+++ b/src/skills/clock.ts",
      "@@ -10,4 +10,5 @@ export function now() {",
      " const d = new Date();",
      "-return d.toString();",
      "+return d.toISOString();",
      " }"
    ].join("\n");

    /** 200 added lines in one file — far past the per-file head cap and the inline cap. */
    function bigDiff(): string {
      const lines = [
        "diff --git a/src/big.ts b/src/big.ts",
        "index 1111111..2222222 100644",
        "--- a/src/big.ts",
        "+++ b/src/big.ts",
        "@@ -1,1 +1,200 @@"
      ];
      for (let i = 0; i < 200; i++) lines.push(`+const filler_${i} = "${"x".repeat(40)}";`);
      return lines.join("\n");
    }

    interface DocInput { chat_id: string; filename: string; content: string; caption?: string }

    function makeDocClient(sent: string[], docs: DocInput[], docThrows = false) {
      return {
        async sendMessage(input: { chat_id: string; text: string }) {
          sent.push(input.text);
          return { message_id: sent.length };
        },
        async sendDocument(input: DocInput) {
          if (docThrows) throw new Error("sendDocument failed: HTTP 413");
          docs.push(input);
        }
      };
    }

    function view(store: RunStore, client: { sendMessage: (i: { chat_id: string; text: string }) => Promise<{ message_id: number }> }, diff: string): Promise<void> {
      const { deps: dl } = freshLogs();
      return handleSelfWriteAction({
        event: event("view"),
        telegramClient: client,
        projectRoot: "/fake/root",
        store,
        makeDeps: makeDeps(dl, { diff }),
        resolvePush: () => false
      });
    }

    it("small diff → ONE fully-inline message: header, stat summary, compact body; no document", async () => {
      const store = RunStore.openInMemory();
      const sent: string[] = [];
      const docs: DocInput[] = [];
      try {
        await view(store, makeDocClient(sent, docs), SMALL_DIFF);
        expect(sent.length).toBe(1);
        const msg = sent[0];
        expect(msg).toContain(`Diff for \`${BRANCH}\``);
        expect(msg).toContain("src/skills/clock.ts | +1 −1");
        expect(msg).toContain("1 file changed, +1 −1");
        expect(msg).toContain("📄 src/skills/clock.ts");
        expect(msg).toContain("@ 10");
        expect(msg).toContain("+return d.toISOString();");
        expect(msg).toContain("-return d.toString();");
        // Noise stripped.
        expect(msg).not.toContain("index abc123");
        expect(msg).not.toContain("+++ b/");
        expect(msg).not.toContain("diff --git");
        // Fully inline → no attachment, no truncation note.
        expect(docs).toEqual([]);
        expect(msg).not.toContain("full patch unavailable");
      } finally {
        store.close();
      }
    });

    it("oversized diff → compact inline message PLUS the full raw diff as a .patch document", async () => {
      const store = RunStore.openInMemory();
      const sent: string[] = [];
      const docs: DocInput[] = [];
      const raw = bigDiff();
      try {
        await view(store, makeDocClient(sent, docs), raw);
        expect(sent.length).toBe(1);
        expect(sent[0]).toContain("src/big.ts | +200 −0");
        expect(sent[0]).toContain("… (+160 more lines)"); // per-file head cap at 40
        expect(sent[0]!.length).toBeLessThanOrEqual(4096);
        expect(docs).toEqual([
          {
            chat_id: CHAT_ID,
            filename: `${RUN_ID}.patch`,
            content: raw,
            caption: `Full diff for ${BRANCH}`
          }
        ]);
      } finally {
        store.close();
      }
    });

    it("oversized diff on a client WITHOUT sendDocument → truncation note, no crash", async () => {
      const store = RunStore.openInMemory();
      const sent: string[] = [];
      const sendOnly = {
        async sendMessage(input: { chat_id: string; text: string }) {
          sent.push(input.text);
          return { message_id: sent.length };
        }
      };
      try {
        await view(store, sendOnly, bigDiff());
        expect(sent.length).toBe(1);
        expect(sent[0]).toContain("(diff truncated; full patch unavailable on this client)");
      } finally {
        store.close();
      }
    });

    it("a failing sendDocument never loses the inline message or crashes the handler", async () => {
      const store = RunStore.openInMemory();
      const sent: string[] = [];
      const docs: DocInput[] = [];
      try {
        await view(store, makeDocClient(sent, docs, true), bigDiff());
        expect(sent.length).toBe(1);
        expect(sent[0]).toContain("📄 src/big.ts");
        expect(docs).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  describe("⓪·3g tap hygiene", () => {
    it("view double-tap within 60s → callback answered BOTH times, but only ONE diff sent", async () => {
      const store = RunStore.openInMemory();
      const { client: cl, deps: dl } = freshLogs();
      const client = makeClient(cl);
      let clock = 1_000_000;
      const run = (action: SelfWriteCallbackAction) =>
        handleSelfWriteAction({
          event: event(action),
          telegramClient: client,
          projectRoot: "/fake/root",
          store,
          makeDeps: makeDeps(dl, { diff: "diff --git a b" }),
          resolvePush: () => false,
          now: () => clock
        });
      try {
        await run("view");
        clock += 5_000; // an impatient second tap 5s later
        await run("view");
        // Both taps were ACKED (spinner stopped) …
        expect(cl.answered).toEqual(["cb_1", "cb_1"]);
        // … but the diff went out exactly once (one viewDiff, one send).
        expect(dl.viewed).toEqual([BRANCH]);
        expect(cl.sent.filter((t) => t.includes("diff --git a b")).length).toBe(1);
      } finally {
        store.close();
      }
    });

    it("view tap AFTER the 60s window runs again (dedupe expires)", async () => {
      const store = RunStore.openInMemory();
      const { client: cl, deps: dl } = freshLogs();
      const client = makeClient(cl);
      let clock = 1_000_000;
      const run = () =>
        handleSelfWriteAction({
          event: event("view"),
          telegramClient: client,
          projectRoot: "/fake/root",
          store,
          makeDeps: makeDeps(dl, { diff: "diff --git a b" }),
          resolvePush: () => false,
          now: () => clock
        });
      try {
        await run();
        clock += 61_000; // past the window — a legitimate re-view
        await run();
        expect(dl.viewed).toEqual([BRANCH, BRANCH]);
        expect(cl.sent.filter((t) => t.includes("diff --git a b")).length).toBe(2);
      } finally {
        store.close();
      }
    });

    it("merge/discard are NOT deduped (idempotent already; a merge retry after a refusal must work)", async () => {
      const store = RunStore.openInMemory();
      const { client: cl, deps: dl } = freshLogs();
      const client = makeClient(cl);
      try {
        // Two merges in quick succession: both EXECUTE (the second maps to a real outcome
        // via mergeAndReload's own idempotency, not a silent dedupe skip).
        await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "merge_conflict", detail: "CONFLICT" } }));
        await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "merge_conflict", detail: "CONFLICT" } }));
        expect(cl.sent.filter((t) => t === MERGE_ACK).length).toBe(2);
        expect(cl.sent.filter((t) => t.includes("conflict")).length).toBe(2);
      } finally {
        store.close();
      }
    });

    it("F1: [Merge & reload] is REFUSED while the evolution lane is busy — buttons intact, merge never runs", async () => {
      const store = RunStore.openInMemory();
      const { client: cl, deps: dl } = freshLogs();
      const client = makeClient(cl);
      // Occupy the lane with a controllable in-flight pipeline.
      let release!: () => void;
      const started = tryStartEvolutionPipeline({
        current: { run_id: "run_bg", tool: "self_write_propose", started_at: new Date().toISOString() },
        capMs: 60_000,
        run: () => new Promise((resolve) => { release = () => resolve({ text: "done" }); }),
        onTimeout: () => ({ text: "timeout" }),
        onError: (d) => ({ text: d }),
        deliver: () => {}
      });
      expect(started).toBe(true);
      let merged = false;
      const deps = (notifyDurable: (text: string) => void): MergeActionDeps => ({
        branchExists: () => true,
        isMerged: () => false,
        diff: () => "",
        merge: () => { merged = true; },
        resetMerge: () => {},
        preMergeRef: () => "PRE",
        build: () => ({ ok: true }),
        testGate: () => ({ green: true }),
        deleteBranch: () => {},
        writeReloadMarker: () => {},
        notifyDurable,
        restart: () => {},
        push: () => {}
      });
      try {
        await handleSelfWriteAction({
          event: event("merge"),
          telegramClient: client,
          projectRoot: "/fake/root",
          store,
          makeDeps: deps,
          resolvePush: () => false
        });
        // The tap was acked and refused with the wait message naming the tool.
        expect(cl.answered).toEqual(["cb_1"]);
        expect(cl.sent.length).toBe(1);
        expect(cl.sent[0]).toContain("自我修改还在后台跑着");
        expect(cl.sent[0]).toContain("self_write_propose");
        // Buttons stay in place (retry is one tap away) and NOTHING merged.
        expect(cl.cleared).toEqual([]);
        expect(merged).toBe(false);
        expect(cl.sent).not.toContain(MERGE_ACK);
      } finally {
        release();
        await evolutionLaneSettled();
        store.close();
      }
    });

    it("F1: once the lane settles, the SAME merge tap goes through normally", async () => {
      const store = RunStore.openInMemory();
      const { client: cl, deps: dl } = freshLogs();
      const client = makeClient(cl);
      let release!: () => void;
      tryStartEvolutionPipeline({
        current: { run_id: "run_bg", tool: "self_write_propose", started_at: new Date().toISOString() },
        capMs: 60_000,
        run: () => new Promise((resolve) => { release = () => resolve({ text: "done" }); }),
        onTimeout: () => ({ text: "timeout" }),
        onError: (d) => ({ text: d }),
        deliver: () => {}
      });
      try {
        await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "already_merged" } }));
        expect(cl.sent.some((t) => t.includes("自我修改还在后台跑着"))).toBe(true);
        release();
        await evolutionLaneSettled();
        await run("merge", store, client, makeDeps(dl, { mergeOutcome: { kind: "already_merged" } }));
        // Normal flow resumed: ack + cleared buttons + real outcome.
        expect(cl.sent).toContain(MERGE_ACK);
        expect(cl.sent.some((t) => t.includes("already merged"))).toBe(true);
        expect(cl.cleared.length).toBe(1);
      } finally {
        store.close();
      }
    });

    it("merge ORDERING: ack callback → clear buttons → send '正在合并…' → THEN run the merge", async () => {
      const store = RunStore.openInMemory();
      const order: string[] = [];
      const client = {
        async sendMessage(input: { chat_id: string; text: string }) {
          order.push(`send:${input.text}`);
          return { message_id: 1 };
        },
        async answerCallbackQuery() {
          order.push("ack");
        },
        async editMessageReplyMarkup() {
          order.push("clear");
        }
      };
      const deps = (notifyDurable: (text: string) => void): MergeActionDeps => ({
        branchExists: () => true,
        isMerged: () => false,
        diff: () => "",
        merge: () => { order.push("merge"); },
        resetMerge: () => {},
        preMergeRef: () => "PRE",
        build: () => ({ ok: true }),
        testGate: () => ({ green: true }),
        deleteBranch: () => {},
        writeReloadMarker: () => {},
        notifyDurable,
        restart: () => {},
        push: () => {}
      });
      try {
        await handleSelfWriteAction({
          event: event("merge"),
          telegramClient: client,
          projectRoot: "/fake/root",
          store,
          makeDeps: deps,
          resolvePush: () => false
        });
        expect(order).toEqual(["ack", "clear", `send:${MERGE_ACK}`, "merge"]);
      } finally {
        store.close();
      }
    });
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
