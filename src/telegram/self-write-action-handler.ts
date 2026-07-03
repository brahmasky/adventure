import {
  defaultMergeActionDeps,
  discardBranch,
  mergeAndReload,
  resolveSelfWritePush,
  viewDiff,
  type MergeActionDeps,
  type MergeOutcome
} from "../capabilities/self-write-merge.js";
import { NotificationOutbox } from "../notifications/notification-outbox.js";
import { selfWriteBranchName } from "../run/branch-publish.js";
import type { RunStore } from "../run/run-store.js";
import type { SelfWriteActionEvent } from "../triggers/telegram-trigger-adapter.js";
import { formatDiffMessage } from "./diff-format.js";
import type {
  TelegramAnswerCallbackQueryInput,
  TelegramEditMessageReplyMarkupInput,
  TelegramInlineKeyboardMarkup,
  TelegramSendDocumentInput,
  TelegramSendMessageInput,
  TelegramSendMessageResult
} from "./telegram-client.js";

/**
 * M4 — execute an authorized self-write inline-button action (Phase 3.3).
 *
 * This is the SINGLE implementation behind the M4 SEAM: BOTH the one-shot poll runner and the
 * always-on daemon call {@link handleSelfWriteAction}, so view/discard/merge behave identically
 * in either path. M2 already enforced auth (only an allowlisted `from` produces a
 * {@link SelfWriteActionEvent}); this module NEVER re-derives or weakens that gate.
 *
 * Flow per tap:
 *   1. answerCallbackQuery — stop the Telegram spinner immediately.
 *   2. view   → read-only `git diff` sent back; buttons LEFT in place (repeatable).
 *   3. discard→ CLEAR the buttons FIRST (idempotency: no re-tap), then `git branch -D`.
 *   4. merge  → CLEAR the buttons FIRST (no double-tap during the slow merge), then merge→build→
 *               test-gate→detached restart. A GREEN merge restarts the daemon, so the user-visible
 *               "merged, reloading…" message is the DURABLE one enqueued by `notifyDurable` BEFORE
 *               the restart kills this process — code after `reloaded` may never run.
 *
 * Never throws to the caller: any error maps to a sent message (or is swallowed if even the send
 * fails) so a button tap can never crash the poll loop / daemon.
 */

/**
 * The Telegram surface the handler needs: send + ack-callback + edit-keyboard. The callback
 * methods are OPTIONAL on the boundary (mirroring {@link TelegramSendClient}) so existing
 * send-only test fakes still satisfy it; the handler guards each call and degrades gracefully
 * when a method is absent (the underlying merge actions are idempotent / read-only).
 */
export interface SelfWriteActionTelegramClient {
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult>;
  answerCallbackQuery?(input: TelegramAnswerCallbackQueryInput): Promise<void>;
  editMessageReplyMarkup?(input: TelegramEditMessageReplyMarkupInput): Promise<void>;
  /** Attach a file (the full `.patch` when a diff overflows the inline cap). Optional like the rest. */
  sendDocument?(input: TelegramSendDocumentInput): Promise<void>;
}

export interface HandleSelfWriteActionOptions {
  event: SelfWriteActionEvent;
  telegramClient: SelfWriteActionTelegramClient;
  projectRoot: string;
  store: RunStore;
  /**
   * Injectable for tests: build the merge-action deps for a given `notifyDurable`. Production
   * uses the real {@link defaultMergeActionDeps} (real git/launchctl); tests pass mocks so no
   * real merge/restart runs.
   */
  makeDeps?: (notifyDurable: (text: string) => void) => MergeActionDeps;
  /** Injectable for tests: resolve whether [Merge & reload] also pushes. Defaults to the env. */
  resolvePush?: () => boolean;
}

export async function handleSelfWriteAction(options: HandleSelfWriteActionOptions): Promise<void> {
  const { event, telegramClient, projectRoot, store } = options;
  const branch = selfWriteBranchName(event.runId);

  // 1. Ack the tap immediately (stop the spinner). Best-effort — a failed ack must not abort.
  try {
    await telegramClient.answerCallbackQuery?.({ callback_query_id: event.callback_id });
  } catch {
    // The spinner not stopping is cosmetic; proceed with the action.
  }

  try {
    // The durable notify channel: the "merged, reloading…" message MUST survive the self-restart,
    // so it is enqueued into the persistent outbox (not sent inline) targeting the tapper's chat.
    const notifyDurable = (text: string): void => {
      enqueueDurableChatNotification(store, event, text);
    };
    const deps = options.makeDeps
      ? options.makeDeps(notifyDurable)
      : defaultMergeActionDeps({
          dir: projectRoot,
          env: process.env,
          notifyDurable,
          // The reload marker rides the same durable store as the outbox (⓪·2c U2).
          writeReloadMarker: (marker) => store.writeReloadMarker(marker)
        });

    switch (event.action) {
      case "view": {
        // Read-only + repeatable: leave the buttons in place.
        const result = viewDiff({ branch, deps });
        if (result.ok) {
          await sendDiff(telegramClient, event, branch, result.diff);
        } else {
          await send(telegramClient, event.chat_id, `Couldn't show \`${branch}\`: ${result.reason}.`);
        }
        return;
      }
      case "discard": {
        // Clear the buttons FIRST so a stale tap can't re-fire after the branch is gone.
        await clearButtons(telegramClient, event);
        const result = discardBranch({ branch, deps });
        if (result.ok) {
          await send(telegramClient, event.chat_id, `🗑 Discarded \`${branch}\` (or it was already gone).`);
        } else {
          await send(telegramClient, event.chat_id, `Couldn't discard \`${branch}\`: ${result.reason}.`);
        }
        return;
      }
      case "merge": {
        // Clear the buttons FIRST: a merge is slow, and a double-tap mid-merge must not re-enter.
        await clearButtons(telegramClient, event);
        const push = options.resolvePush ? options.resolvePush() : resolveSelfWritePush(process.env);
        const outcome = mergeAndReload({ branch, push, deps });
        await reportMergeOutcome(telegramClient, event.chat_id, branch, outcome);
        // A REFUSED merge that leaves the branch in place (conflict-aborted / red-gate or
        // dirty-tree revert) gets the SAME keyboard back so a retry stays one tap away.
        // Success (reloaded) and gone-branch outcomes (not_found/already_merged) stay cleared.
        if (outcome.kind === "merge_conflict" || outcome.kind === "reverted") {
          await restoreButtons(telegramClient, event);
        }
        return;
      }
    }
  } catch (error) {
    // NEVER throw out of the handler — map any unexpected failure to a sent message.
    const detail = error instanceof Error ? error.message : String(error);
    await send(telegramClient, event.chat_id, `Something went wrong handling that (${detail}).`);
  }
}

/** Send the merge outcome as a single user message. `reloaded` is handled by `notifyDurable`. */
async function reportMergeOutcome(
  client: SelfWriteActionTelegramClient,
  chat_id: string,
  branch: string,
  outcome: MergeOutcome
): Promise<void> {
  switch (outcome.kind) {
    case "reloaded":
      // The "merged, reloading…" message was enqueued durably BEFORE the restart killed us; this
      // code likely never runs (the process is gone). No inline send here by design.
      return;
    case "reverted":
      await send(
        client,
        chat_id,
        `Merged \`${branch}\` but the test gate went red at \`${outcome.stage}\` — reverted, still ` +
          `running the old code. Nothing landed.`
      );
      return;
    case "merge_conflict":
      await send(
        client,
        chat_id,
        `Couldn't merge \`${branch}\` (conflict). Yours to resolve. (detail: ${outcome.detail})`
      );
      return;
    case "already_merged":
      await send(client, chat_id, `\`${branch}\` is already merged.`);
      return;
    case "not_found":
      await send(client, chat_id, `Branch \`${branch}\` not found (already discarded?).`);
      return;
  }
}

/**
 * Send the diff as a readable message: stat summary + compact body (⓪·2c U1). A small diff
 * renders fully inline; when the inline view loses content, the full patch ALSO ships as a
 * document attachment (when the client can), or the message carries a truncation note.
 * Empty diff → a "no changes" note.
 */
async function sendDiff(
  client: SelfWriteActionTelegramClient,
  event: SelfWriteActionEvent,
  branch: string,
  diff: string
): Promise<void> {
  const chat_id = event.chat_id;
  const trimmed = diff.trim();
  if (trimmed.length === 0) {
    await send(client, chat_id, `\`${branch}\` has no changes against main.`);
    return;
  }
  const rendered = formatDiffMessage(branch, trimmed);
  if (!rendered.truncated) {
    await send(client, chat_id, rendered.text);
    return;
  }
  if (client.sendDocument) {
    await send(client, chat_id, rendered.text);
    try {
      await client.sendDocument({
        chat_id,
        filename: `${event.runId}.patch`,
        content: trimmed,
        caption: `Full diff for ${branch}`
      });
    } catch {
      // The compact inline view already went out; a failed attach is recoverable.
    }
    return;
  }
  await send(
    client,
    chat_id,
    `${rendered.text}\n(diff truncated; full patch unavailable on this client)`
  );
}

/** Clear a message's inline keyboard (idempotency: a tapped action can't be re-tapped). */
async function clearButtons(
  client: SelfWriteActionTelegramClient,
  event: SelfWriteActionEvent
): Promise<void> {
  // Best-effort: if the edit fails (message gone / already cleared), still run the action.
  try {
    await client.editMessageReplyMarkup?.({ chat_id: event.chat_id, message_id: event.message_id });
  } catch {
    // Leaving stale buttons is recoverable (the underlying actions are idempotent).
  }
}

/**
 * Re-attach the original three-button keyboard after a refused merge (the branch still
 * exists and a retry is meaningful). Reconstructed from the callback event's run id —
 * byte-identical to the keyboard the publish notification carried. Best-effort: a client
 * without editMessageReplyMarkup (or a failed edit) just leaves the message button-less.
 */
async function restoreButtons(
  client: SelfWriteActionTelegramClient,
  event: SelfWriteActionEvent
): Promise<void> {
  try {
    await client.editMessageReplyMarkup?.({
      chat_id: event.chat_id,
      message_id: event.message_id,
      reply_markup: selfWriteKeyboard(event.runId)
    });
  } catch {
    // Recoverable: the branch survives; Paco can still merge/discard manually.
  }
}

/** The published-notification keyboard (must mirror runSelfWrite's notifyButtons exactly). */
function selfWriteKeyboard(runId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🔀 Merge & reload", callback_data: `selfwrite:merge:${runId}` },
        { text: "👀 View diff", callback_data: `selfwrite:view:${runId}` },
        { text: "🗑 Discard", callback_data: `selfwrite:discard:${runId}` }
      ]
    ]
  };
}

/** Send a chat message; swallow a send failure so the handler can never throw. */
async function send(client: SelfWriteActionTelegramClient, chat_id: string, text: string): Promise<void> {
  try {
    await client.sendMessage({ chat_id, text });
  } catch {
    // Nothing more we can do — surface nothing rather than crash the loop.
  }
}

/**
 * Enqueue a DURABLE notification to the tapper's chat via the outbox, so a message (the
 * "merged, reloading…" beacon in particular) survives the self-restart. Idempotency key is
 * stamped per-callback so a redelivered tap doesn't double-enqueue. Best-effort: a store error
 * must not crash the merge path (the restart still happens).
 */
function enqueueDurableChatNotification(
  store: RunStore,
  event: SelfWriteActionEvent,
  text: string
): void {
  try {
    new NotificationOutbox(store).enqueue({
      target: { kind: "telegram", chat_id: event.chat_id },
      intent_type: "final_report",
      idempotency_key: `selfwrite:${event.action}:${event.callback_id}:notify`,
      correlation_id: `selfwrite:${event.runId}`,
      payload: { text }
    });
  } catch {
    // A duplicate/conflict or store hiccup must not abort the (irreversible) restart sequence.
  }
}
