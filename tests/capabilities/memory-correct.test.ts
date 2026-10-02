import { describe, expect, it } from "vitest";
import { executeMemoryCorrect, inertCode, newMemoryTurnState, parseMemoryRequest } from "../../src/capabilities/memory-correct.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { markdownToTelegramHtml } from "../../src/telegram/markdown-to-telegram-html.js";

const CHAT = "555";

/** Paco's own Telegram turn: every write trust limit but the gate would pass. */
function telegramRun(store: RunStore): string {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "forget the ASML fact",
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: "mc-unit:1", source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

describe("executeMemoryCorrect: the search entry never writes", () => {
  // The search entry is ungated (no approval card). A retire routed through it must be refused even when
  // every other limit passes, or a write would skip Paco's tap entirely.
  it("retire on the ungated entry is refused bad_input and changes nothing, even with the id offered", async () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco follows ASML", created_at: "2026-10-01T00:00:00.000Z" });
      const run_id = telegramRun(store);
      const state = newMemoryTurnState();
      state.offered.fact.add(id);
      const r = await executeMemoryCorrect(
        { store, run_id, chat_id: CHAT, state, embed: async () => null, gated: false },
        { action: "retire", ids: [id] }
      );
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/^bad_input:/) });
      expect(store.getEpisodicFact(id)?.status).toBe("active");
      expect(state.changed).toBe(0);
      expect(store.getLedgerEvents(run_id).filter((e) => e.event_type === "memory_corrected")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("inertCode: a correction on a card is never markup", () => {
  // A backtick in Paco's text would close the code span early and let the rest render as markup.
  it("swaps a backtick for U+02CB so `a` *b* [x](http://e) renders with no italic and no link", () => {
    const html = markdownToTelegramHtml(`New text: ${inertCode("`a` *b* [x](http://e)")}`);
    expect(html).toBe("New text: <code>ˋaˋ *b* [x](http://e)</code>");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<a ");
  });
});

describe("parseMemoryRequest: a correction carries no invisible control characters", () => {
  // A bidi override (U+202E) makes a stored fact display reversed text; zero-width characters hide inside words.
  it("strips bidi controls and zero-width characters, keeps every visible character, and still flattens lines", () => {
    const req = parseMemoryRequest({
      action: "correct", ids: [1], correction: "snake_‮case‬ [x]​(http://e)⁦﻿\nnext line‍"
    });
    expect(req).toEqual({ action: "correct", kind: "fact", ids: [1], correction: "snake_case [x](http://e) next line" });
  });
});
