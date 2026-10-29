// Stage 4B differential, report-redaction corpus (spec 2026-10-29 §6 item 5; the classes are tests/run/report-redaction-corpus.test.ts rebuilt in plain JS).
// Items: every final_report text of Paco's live DB (read from a VACUUM copy, private: printed only as transcript#<i>) times the three report wrappers,
// then the seeded classes (maskable, cut boundary, short control, firewall off, clean edges, the four enqueue outcomes) with the nine fake values.
// One fresh store and run per (text, wrapper): the final-report and failure wrappers share the key `${run_id}:final_report`. Pair: s4a -> new.
//
// Compared (after id scrubbing): the wrapper results, the outbox payload_json / payload_hash / state, the evolution chat turn, the decisions rows
// (secret.redact rows are filtered by the harness and REQUIRED on the new side) and the full-DB TEXT scan. Nothing is stripped beyond STRIP_KEYS:
// the only run-varying value, the run id, is replaced by RUN inside the projection.
// Required (new side), besides the per-class row counts: the stored bytes equal an oracle written independently of the redactor.
import { SetupError, fakeBroker, requireNew } from "../stage4-diff-lib.mjs";
import { CHAT_MAX, MARK, MASKABLE, SHORT, TAIL, WRAPPERS, checkItem, oracleStored, pad, projectItem, readLiveTexts, tally } from "../stage4-redact-fixture.mjs";

const MIN_LIVE = 633;
const DEFAULT_LIVE_DB = new URL("../../../../houge.sqlite", import.meta.url).pathname; // the main checkout's DB (this file lives in .worktrees/<name>/scripts/stage4-corpora)
const TAGS = ["live", "maskable", "cut_boundary", "short_control", "firewall_off", "clean", "duplicate", "conflict", "insert_failure", "outer_rollback", "transcript"];

const mk = (key, w, cls, extra) => ({ key: `${cls}:${key}:${w}`, wrapper: w, scenario: "single", firewall: true, tags: [cls, `wrap_${w}`], ...extra });
const onlyPayload = (w) => ({ "notification_outbox.payload_json": 1, ...(w === "evolution" ? { "chat_turns.text": 1 } : {}) });

/** each maskable value planted at the start, the end, twice, and at offset 2,000 of a 3,000-char text; the expected bytes are written out by hand */
function plants(v) {
  const rest = pad(1000 - v.length);
  return [["start", `${v} then some ordinary prose`, `${MARK} then some ordinary prose`], ["end", `ordinary prose then ${v}`, `ordinary prose then ${MARK}`],
    ["twice", `first ${v} middle ${v} last`, `first ${MARK} middle ${MARK} last`], ["at2000", pad(2000) + v + rest, pad(2000) + MARK + rest]];
}

function seeded(w) {
  const items = [];
  MASKABLE.forEach((v, i) => plants(v).forEach(([where, text, expected]) => items.push(mk(`${i}-${where}`, w, "maskable", { text, expected }))));
  const cutText = pad(3895) + MASKABLE[1] + " tail"; // no leading whitespace: trim() cannot shift the index
  items.push(mk("straddle", w, "cut_boundary", { text: cutText, expected: pad(3895) + "«reda" + TAIL }));
  items.push(mk("short", w, "short_control", { text: `the short ${SHORT} value, twice ${SHORT}`, needles: [SHORT], expectHits: onlyPayload(w) }));
  MASKABLE.forEach((v, i) => items.push(mk(`${i}`, w, "firewall_off", { firewall: false, text: `before ${v} after`, expected: `before ${v} after`, expectHits: onlyPayload(w) })));
  [["empty", ""], ["whitespace", " \n\t  "], ["3899", pad(3899)], ["3900", pad(3900)], ["3901", pad(3901)]].forEach(([n, text]) => items.push(mk(n, w, "clean", { text })));
  const masked = `answer with ${MASKABLE[0]} inside`;
  items.push(mk("same-text", w, "duplicate", { scenario: "duplicate", text: masked }));
  items.push(mk("other-text", w, "conflict", { scenario: "conflict", text: `first ${MASKABLE[1]}`, secondText: "a different report" }));
  items.push(mk("trigger", w, "insert_failure", { scenario: "insert_failure", text: `report ${MASKABLE[0]}` }));
  items.push(mk("begin-rollback", w, "outer_rollback", { scenario: "outer_rollback", text: `report ${MASKABLE[0]}` }));
  return items;
}

/** The Task 1 premise, asserted before anything runs: the marker starts at 3,895 so the 3,900 cut keeps only its first 5 chars. */
function assertPremise(d) {
  const redacted = fakeBroker(d).redact(pad(3895) + MASKABLE[1] + " tail");
  const hand = pad(3895) + "«reda" + TAIL;
  if (redacted.indexOf(MARK) !== 3895 || MARK.length !== 10 || redacted.trim() !== redacted || oracleStored(pad(3895) + MASKABLE[1] + " tail", true) !== hand || hand.length !== CHAT_MAX + TAIL.length) {
    throw new SetupError("cut-boundary premise failed: the marker no longer straddles char 3,900");
  }
}

function liveItems(texts) {
  return texts.flatMap((text, i) => WRAPPERS.map((w) => ({ key: `live:${i + 1}:${w}`, wrapper: w, scenario: "single", firewall: true, text, tags: ["live", "transcript", `wrap_${w}`] })));
}

export default {
  name: "redaction",
  pairs: [["s4a", "new"]],
  min: { items: MIN_LIVE * 3 + 153, branches: [...TAGS, ...WRAPPERS.map((w) => `wrap_${w}`)] },
  async load(ctx) {
    assertPremise(ctx.dists.new);
    for (const k of Object.keys(tally)) delete tally[k];
    const texts = readLiveTexts(ctx.liveDb ?? DEFAULT_LIVE_DB, `${ctx.mkTemp("live-copy")}/live.sqlite`);
    if (texts.length < MIN_LIVE) throw new SetupError(`live DB holds ${texts.length} final_report texts, fewer than the pinned ${MIN_LIVE}`);
    return [...WRAPPERS.flatMap(seeded), ...liveItems(texts)];
  },
  async project(d, item) { return projectItem(d, item); },
  required(d, item, proj) {
    const bad = checkItem(d, item, proj);
    if (bad.length) throw new Error(bad.join("; "));
  },
  /** The brief's pin: every single-call item leaves exactly one outbox row for its wrapper, on both builds. */
  async finish(ctx, items) {
    const pin = { key: "outbox-rows-per-wrapper", tags: [] };
    for (const [side, d] of [["s4a", ctx.dists.s4a], ["new", ctx.dists.new]]) {
      for (const w of WRAPPERS) {
        const want = items.filter((it) => it.wrapper === w && it.scenario === "single").length;
        const got = tally[d.dir]?.[w] ?? 0;
        console.log(`outbox rows [${side}] ${w}: ${got} for ${want} single-call items`);
        requireNew({ name: "redaction" }, pin, `${side} ${w} outbox rows ${got} == ${want}`, got === want);
      }
    }
  }
};
