# ADR 0030: Decision ladder — every decision on one list, a ladder of deciders, improved from outcomes

- **Status:** proposed 2026-10-12 (design approved by Paco section by section, 2026-10-12; rulings R12 (what Jev may cause depends on what it read) and R13 (no off switch, no designed shadow) the same day; the numbered rulings are in spec §2)
- **Date:** 2026-10-12
- **Deciders:** Paco
- **Amends:** [0029](0029-jev-system-one.md) (the front door becomes the `turn.handler` entry; decision 2 applications;
  one named exception to "no Jev in any deny path"; decision 4 egress; decision 5 shadow and provisional bars),
  [0028](0028-omp-runtime.md) (D5, D12), [0014](0014-dual-llm-privilege-separation.md) (an injection judge before the
  reader), [0011](0011-self-evolution-architecture.md) (`src/decisions/` joins the protected surface)
- **Spec:** [2026-10-12-decision-ladder-design.md](../superpowers/specs/2026-10-12-decision-ladder-design.md) (Rev 8), §2 (rulings R1–R13);
  research [2026-10-12-in-loop-decisions](../superpowers/research/2026-10-12-in-loop-decisions/00-synthesis.md)

## Context

Houge takes about 85 decisions between a Telegram message and the delivered reply. They were 85 hand-written branches
with 85 logging styles and 85 implicit failure directions. Jev decided one of them, at the front door, and "System One
shortcut, else the planner" became the architecture. Paco called that tree stiff and declined to add judges on top of
it as a patch (2026-10-12). The middle of the turn was blind in five places: tool output was screened for injection only
on the four read tools and only as a note; "done" was never verified; there was no loop detection beyond the call cap;
output was trimmed by size, not relevance; notify-now-or-later was never decided. Learning paths were each wired to one
trigger, and nothing measured whether an improvement worked.

## Decision

We will hold every decision that changes a turn's path, and whose answer an outcome could show wrong, as one entry in a
code-owned registry under `src/decisions/`. Everything else stays plain code (mechanics).

1. **Entry.** An entry has a stable id, a version bumped on any wording, rung or bar change, a stage, the input source it
   reads (`paco`, `tool` or `mixed`; `mixed` is treated as `tool`), a closed verdict set that always includes an escape
   value, a `fail` verdict used when no rung answers, a default verdict, the outcome signals that can show it wrong, and,
   for each verdict, what it causes (`none`, `reply`, `tighten`, `proposal`, `effect`) and whether that is reversible and
   how it is announced.
2. **Ladder.** Deciders are tried in order: code rule, then Jev, then a model, then Paco. Code goes first, and a rule
   answer ends the walk. A rule that wants a judge consulted abstains; "eligible for judging" is an abstention, never a
   pass. A thrown rule, a timeout or an outage is an abstention, so `fail` decides, never an accident.
3. **Monotone rule, restated.** On an entry declared monotone, a Jev or model rung can only tighten: its verdict applies
   only when it is at least as cautious as the verdict so far, which starts at the abstaining rule's floor. A Jev or
   model rung never opens a gate, and never allows or denies an action (ADR 0029 decision 2), with the one exception
   named under the 0029 amendment below.
4. **What a Jev or model verdict may do depends on what it read (R12).** ADR 0029's accepted risk stands: Jev is
   steerable by injected text, so its labels stay advisory or monotone and steering degrades quality, never safety.
   - Over **tool-derived input** (web, mail, calendar, shell output, files, tool results) a verdict may only tighten:
     withhold a passage, add a tap, or send the planner back once. Any lasting change it suggests (a lesson, fact, skill
     or wiki page) is a proposal for Paco's tap.
   - Over **Paco's own message** a verdict may cause an effect directly, if the effect is reversible and announced.
     Examples: a `turn.handler` lane reply (Dig deeper), and the memory shortcut's instant lesson save (stage A,
     unchanged and permanent; Undo on its card). Every automatic lesson save, whatever route the turn took, is announced
     on the memory card with Undo (Paco, 2026-10-12).
   - **Context does not change the source.** An entry whose verdict is about Paco's message stays `paco` when its
     state also carries recent turns, Houge's replies included, as long as the effect only stores Paco's own words,
     reversibly and announced (the memory shortcut; `turn.handler` reads the last turns for follow-ups). Injected text
     in those replies can at worst steer a save of Paco's words, which the memory card shows with Undo. Any effect that
     would store or act on text from the context is `mixed` (Paco, 2026-10-12, ruling on codex #1).
   - A registry test fails any entry whose Jev or model rung can cause an unannounced or irreversible effect, or any
     effect other than tightening or a proposal from tool input.
5. **Ledger.** The runner decides, then records; recording never changes a decision. A failed write opens incident
   `decision_record_failed` and the verdict stands. A `decisions` row is written when the verdict differs from the
   default, a rung beyond the first rule answered or was asked in shadow, Paco was involved, or the entry always
   records. Rows hold ids, closed enums and numbers only: no state column, never read text. A row whose decision belongs
   to a turn is written with that turn's own records, so a turn that is lost writes no row. `decision_outcomes` holds
   closed-enum outcome signals per decision, validated at insert. Domain detail stays in the entry's own table
   (`turn.handler` keeps `jev_verdicts`, which gains `decision_id`; `jev_decisions` gains `ladder_decision_id`).
6. **Locked entries.** Gates whose logic must never be judged (sender, budget fuse, bare-ack consent, kill posture,
   approval binding, path floor, SSRF, self-write guard, the reader wall, attachment path, secret redaction, turn trust)
   are locked: no rung added and no ladder move, refused in code by a registry test and at run time by the ladder-move
   store.
7. **Ladder moves.** A move changes who decides, recorded in `ladder_moves`. Houge may move on its own, from code rungs
   only: standing approvals (after three consecutive approvals of one action and one proven sealed run), skill authoring
   after a recurrence pattern (into the inert pending area; active only on Paco's tap), and lessons through the existing
   save path for a stated rule, with Undo. Only the standing-approval code may insert an automatic row, only for
   `tool.policy`, enforced in the store. Every other loosening (trusting a source, retiring a judge, lowering a bar) is a
   proposal for Paco's tap; callbacks pass the sender allowlist and are one-shot.
8. **Improvement as a decision.** Corrections, review taps and failures go through one entry, `improve.route`, which
   routes each to what it points at (fact, lesson, skill, ladder move, schedule, wiki page, tool gap) and is itself
   measured by whether its signal recurs. A pattern is needed before behaviour changes, except an explicit stated rule.
9. **Bars.** A Jev rung arms on calibrated rows as ADR 0029 decision 5 requires, or on a **provisional bar** taken from
   an external measurement, kept in the entry's registry code, allowed only on monotone or fail-open entries, and covered
   by golden-set items in the invariant sweep. Golden-set drift pages (`decision_golden_drift:<entry>`) and does not
   disarm. On a model or wording change a provisional rung stays armed on its bar, incident `decision_bar_stale:<entry>`
   pages once naming the new model, and the digest flags the entry until Paco commits a calibrated row. The migrated
   front door keeps ADR 0029 decision 5's existing disarm-on-model-move for its calibrated tree rows, unchanged.
10. **No off switch, no shadow by design (R13).** Once built, the decision system is not switched off and no entry is
    designed to run in shadow: a new entry ships armed and stays armed. The runner's `shadow` mode exists only so the
    migrated front door keeps today's configured triage shadow mode exactly. If a build is fundamentally wrong, the
    remedy is revert, rebuild `dist/`, kickstart. Every stage's migrations are additive (new tables, nullable link
    columns), so the previous build runs on the migrated DB, and every stage plan's final task proves it by booting the
    previous build against a migrated DB copy.
11. **Review.** A daily digest lists unsure verdicts (probability within 0.15 of the bar) with ✅/❌ taps that write
    outcome labels, counts per entry and rung, and per-entry health; urgent cards go out at once for events that cannot
    wait. Silence writes nothing.
12. **Egress (R11).** Paco's ruling R11 (2026-10-12): egress is approved for every new class, after redaction. Paco approved, on 2026-10-12, sending web, mail and calendar content, shell output, files and the
    final reply to TypeSafe for judging, after the judge redactor (`src/decisions/egress.ts`: known secret values,
    credential shapes, named secrets with single-run values, URL userinfo, query values and fragments, this turn's
    extracted codes and links; redacted before splitting). Credential stores are read-denied to the planner and never
    sent; a content check keeps PEM blocks, service-account JSON, cookie jars and dense named secrets on the code floor.

## Consequences

- Easier: a new judgment call is an entry plus a rung, not a branch; every decision has one record, one failure
  direction and one outcome trail; Paco reviews uncertain verdicts in one daily message.
- Harder: every migrated decision needs characterisation tests and a behavioural differential before its call site
  moves; the registry is protected surface, so every rung or bar change is Paco's merge. Without an off switch, a bad
  build is a revert and a kickstart, so each stage's live gate carries more weight.
- The `turn.handler` Jev policy glue (arming, bars and the URL rule, `src/core/turn-handler-ladder.ts`) stays outside the
  protected directory, as `src/jev/tree-policy.ts` already is; the entry itself is protected. Acceptable for a non-gate
  entry; a gate entry's glue must live under `src/decisions/entries/`.
- Accepted residuals: a secret with no recognisable name, shape or content, in output the planner read, can reach
  TypeSafe (Paco approved the class, R11); the planner itself can still send what it reads to its own model provider, as
  today.

## Alternatives considered

- **Judges on top of the existing tree:** rejected by Paco as a patch on "if not System One, then the planner".
- **Judge approval (a model opens a gate):** rejected; approval stays Paco's or a Paco-authorised standing rule.
- **"Jev never causes an effect on its own"** (spec Rev 2–7): replaced by R12. It stretched AGENTS.md's "never gates an
  action" without a decision, and contradicted the memory shortcut Paco armed.
- **An off switch (`HOUGE_DECISIONS_OFF`) and shadow-before-arm for new entries** (spec Rev 1–7): dropped by R13.
- **omp's built-in TypeSafe judges:** rejected because their verdicts cannot be ledgered, calibrated or reviewed; not
  because of where the Jev key lives (ADR 0015's reason no longer holds: the child already holds subscription logins).
- **Migrating every branch:** rejected; mechanics stay code. Clean means every decision, not every branch.
- **A tally table for routine passes:** rejected as a second accounting path before any volume problem.

## Assumptions

- Houge's omp extension can rewrite a built-in `read` result before the model sees it, and can send a turn back once at
  settle (probes P1, P2, run 2026-10-12). Checkable: the stage 2b gate.
- Hook handlers in the extension are bounded at 30 s by omp and fail open to the raw result (probe P4); Houge's own 5 s
  extension timers keep the floor ahead of that.
- Jev answers within its 1.5 s bound on the front door, and the extra in-loop volume (about 25–50 calls a day) stays
  within TypeSafe's limits at ten times that (P5).
- The decisions ledger stays small: about 10–15 rows per turn at about 5 turns a day (DB copy, 30 days to 2026-10-12).
- The front-door migration changes no persisted row: the stage 1 pin and the P6 dual run over the last 200 texts show
  zero mismatches.
- Each stage's migrations are additive, so the previous build runs on a migrated DB: checked by each stage plan's final
  task.

## Revisit when

- omp emits judge verdict events (its built-in judges could then be ledgered).
- TypeSafe ships adversarial hardening or a retention commitment.
- The `decisions` table passes 1 million rows.
- A provisional bar's golden-set drift pages twice in 30 days.
- A locked entry needs a judgment the code cannot make.
- A stage needs a migration that is not additive (then rollback is no longer revert, rebuild, kickstart, and R13 needs
  Paco again).
- Any assumption above is shown false by its check.

## Amendments to prior ADRs (appended 2026-10-12 to 0029, 0028, 0014, 0011)

- **0029.** The front door becomes the entry `turn.handler` (ack rule → Jev tree → Tiny cascade, the planner its `fail`
  value), with `turn.gear` a separate entry on the same Jev call. **Decision 2** stands word for word; this ADR records
  three applications under it: withholding a passage is a data transform, not an action deny; `turn.settle`'s send-back
  is one bounded continuation in which, after a Jev-rung send-back, every side effect asks, and after a code-rung
  send-back the normal gates apply; the built-in `edit`/`write` redirect in a hostile turn is the ask form of a gate that
  cannot wait. **"No Jev in any deny path, ever"** gains one named exception: the code-owned redirect of a built-in
  `edit`/`write` to its asking equivalent (`bash`, which asks Paco) in a turn the injection judge marked hostile. Every
  other Jev verdict stays out of deny paths. What a Jev verdict may cause follows decision 4 above (R12): the memory
  shortcut's instant save stays, permanently. The added-tap budget (3 a day) also counts trust asks. **Decision 4:**
  Paco's R11 approval (decision 12 above) is recorded as the approval of web, mail and calendar content, shell output,
  files and replies, with the judge redactor and the residual above. **Decision 5** (shadow before arm): new entries
  never shadow (R13); a stale bar or golden drift pages instead of disarming; provisional bars (decision 9 above) are an
  explicit exception, under Paco's ruling R6 (all new judges armed at ship, with a daily summary of anything unsure), for monotone or fail-open entries only. The front door's calibrated tree rows keep
  decision 5's disarm on a model move, unchanged.
- **0028.** D5's tap-free local writes become conditional on the turn's trust level (`turn.trust`); D12's network shell
  output gets the `tool.injection` judge.
- **0014.** An injection judge (`tool.injection`) runs on wall-tool output before the quarantined reader; it withholds
  passages, never decides whether the wall applies.
- **0011.** `src/decisions/` joins `PROTECTED_DIRS`: if the registry decides the gates, editing it can open a gate, so
  it is Paco's hand only.

## Amendment (2026-10-13): stage 2a, in-Houge judges (DRAFT for Paco's sign-off)

This file is protected (ADR 0011): the draft is Paco's to merge by hand.

- **tool.injection** runs on shell output (success and failure), on the four wall tools' results before the reader, and on
  the code-built side channel that follows the reader (gmail's extracted codes and links), at the bridge; built-in reads
  follow in stage 2b. Its verdicts are pass < frame < withhold. A passage that may not leave (spec §7.0 items 2–3, now
  ruled per passage on the raw text) is never passed: from outside it is withheld with a note, from a local read framed
  and shown redacted. This corrects the spec: "judged by the floor only" let anyone who controls tool output skip the
  judge (S8). The redactor keeps the spec's order on the whole text and only then splits (masks are atomic; no cut falls
  inside one). The floor and the content check read each passage's raw text locally, and the planner reads raw text outside
  withheld or framed passages. A judge that throws falls back to the same local floor, content and path checks, never to raw
  text. Its wording, floor and splitter are mu's (MIT); through mu, the question's wording and instruction patterns trace to hermes-jev-skills (MIT). The notices are in
  `THIRD_PARTY_NOTICES.md` and in the headers of `tool-injection.ts` and `egress.ts`. Measured on the held-out corpus:
  recall 66/66 planted (34 English, 32 Chinese), 1 of 431 clean English passages withheld (0.23%) and 0 of 134 clean
  passages from fetched Chinese pages (live gate C1, run 8; 1 of 565 overall against a 1% bar). It is armed at ship on that provisional bar (decision 9), covered by a daily golden set that pages on drift or
  a model move and never disarms. The golden set is a daily tick, not part of the invariant sweep (S4): the sweep is
  synchronous and switchable, and R13 forbids a switchable check.
- **tool.shell_netread is best effort; the allowlist is the real gate.** The classifier (separate-segment split, wrapper
  parsing, `shell -c`, `eval`, `find -exec`, `/dev/tcp`, quote and backslash stripping, and any expanded program word
  counted as network) decides only the trust level. A miss has a stated cost: the output of an exotic disguised fetch is
  **framed, not withheld**, and the turn stays below hostile until a judged passage says otherwise. The spec's §7.2 wording
  ("its misses cost a missed `untrusted`, not a missed judgement") understated this and is corrected by a Rev note there.
  What a hostile turn may run without a tap is decided by the positive read-only list, where anything unknown asks.
- **turn.trust** is locked code: clean → untrusted (a wall read, a network shell read, a lost judgement, a framed local
  passage) → hostile (a withheld passage, an outside passage withheld unjudged, or an outside passage whose judgement was
  lost, which reaches the planner inside a "not checked" frame). A lost judgement (Jev down, timed out, partial) raises it
  already in 2a (S10; the spec placed `judge_timeout` in 2b). Trust is sticky per planner transcript: a turn starts at the
  level the transcript's last dispatched turn ended at, until the planner starts a fresh transcript. It only adds taps (ADR 0029 decision 2): untrusted
  asks before lesson_write, schedule_task, self_write_propose and skill_author; hostile also asks for every shell command
  off a strict read-only list and every write, and redirects the built-in writers to bash (the named exception). The list
  admits exact flag sets per program; globs are admitted only after `--`; device paths ask; `wc` is **not** on the list
  (macOS `wc` links libxo, and `--libxo=encoder=<path>` loads code from a path; the option is read even after `--`), and
  any word containing `libxo` asks. A trust card pauses the turn's timers for its own TTL (HOUGE_TRUST_ASK_TTL_MS), at
  most one TTL per turn, and a card whose remaining time is under 5 s is refused. Trust asks count toward the 3-a-day
  budget, which pages and never blocks.
- **Settle on a terminal agent_end** (P7, S2): a turn settles on an aborted end, a terminal end, or an end that waits on
  background work alone (the child is then stopped, since omp may still continue it, and incident `planner_async_wait`
  opens). A plain non-terminal end (late steer, omp's own retry, compaction, empty-stop) never settles it. omp's own
  retries are capped at two, each wait at 60 s (S2b), so failover to Houge's next leg happens before the frame watchdog.
  **Accepted residual (C6):** the cap is asserted by a unit test on Houge's config text and by a read of omp's source.
  The live gate cannot show it: `omp config get` does not load the `--config` overlay the planner loads, so the gate
  records that check as INCONCLUSIVE by name rather than passing it. If omp stops honouring `retry.maxRetries` /
  `retry.maxDelayMs`, a 429 with a long retry-after silences a turn until the watchdog fails it.
- **Credential stores by name** are read-denied in the bridge and both Seatbelt profiles. The spec's `id_*` and `*auth*/`
  patterns are narrowed to key files (`id_<algorithm>`) and dot-prefixed or `auth_info*` session folders under ~/Projects,
  because the literal patterns matched source directories (S3, Q2). `*token*.json`, `*.pem`, `*.key` and `.env.*` are
  narrowed the same way: tokenizers, CA bundles, Keynote files and `.env` templates stay usable. A server certificate is
  not a credential; a private key file name is.
- **The noise band.** Jev answers identical requests with different probabilities (spread up to 0.10 on one message,
  S7). A reviewed per-question band, keyed like a calibration row, makes a value within the band of a bar the decision
  uses ask Jev exactly once more: the front door decides on the mean, a judge over tool input on the more cautious call
  (a mean could loosen a withhold); a failed or overrunning second call keeps the first answer, and a failed re-ask still
  opens its outage incident. Bands are Paco's commits from a measurement script, never automatic; the decision row
  records the re-ask and the first call's p; the raw Jev rows keep the first call. Candidate bands measured on the live
  build (95th-percentile spread of repeated calls): injection 0.11; front-door tree category 0.13, confidence 0.14, gap
  0.20. They are **not committed**; they await Paco's approval (plan Q1).
- **Taps are calibration evidence.** Digest ✅/❌, Dig deeper, Undo and 认真想 write decision_outcomes rows. The calibration
  report reads them beside Paco's labelling sittings: only ✅ on a front-door lane route becomes a category label; every
  other tap is evidence and puts its turn on the next sitting's list; conflicting taps on one turn give no label. No row
  is committed and no bar moves automatically (SP4). The `lesson_undone` value is the lane the save came from (the
  Dig-deeper lane set), not the turn's `turn.handler` verdict as the plan's mapping table first said.
- **The planner never receives, as judged, text the judge did not see** (spec correction to §7.0 rule 2, S9): every
  mask sent to the judge is applied to the planner's copy too, except a mask of a run that cannot carry readable text
  (hex-only: SHAs, hashes, UUIDs; digit-only: one-time codes). The cost is stated: the planner loses base64 blobs and
  opaque letter/digit tokens in judged tool output. Masks never split the text for later rules (a masked value inside a
  URL does not end the URL). Long runs are masked only when opaque, never a joined sentence. Any value after a
  secret-named key (a whole key segment equals a secret word: `api_key` yes, `keywords` no) is masked through its
  delimiter whatever its shape or length, for both models; a value too long to delimit blocks its passage. The broker's
  values are located through its own redactor on the whole text, so a value is masked whole even when it is longer than a
  passage. In the mail extract channel a link keeps scheme, host and route words while its token-like path segments, query
  values and fragment are masked whatever their case (a narrowing of rule 5, which masked extracted links whole), and
  the escapes in a link are decoded run by run so a malformed escape cannot hide a sentence from the judge. A line of
  12–24 lowercase words without a common stopword is treated as a wallet seed phrase: withheld from outside, framed locally.
  One named exception to the mirror: a short link (≤ 512 characters, ≤ 8 query values) in the mail side channel's
  code-extracted link field reaches the planner exact (the registration loop needs it) while the judge sees it
  percent-decoded with its opaque segments masked.
- **Invariants of the redactor (I1–I4):** I1, the planner gets no text as judged that Jev did not see (above). I2, secret
  keys match by whole segment. I3, no length cap on a named value. I4, link tokens are masked whatever their case.
- **Accepted residual (R11):** a secret with no recognisable name, shape or content in redacted shell output or a fetched
  page can reach TypeSafe. Measured 2026-10-13 on random tokens (50 000 per alphabet, each in five contexts, an
  8-character slice of the token in the output counts as a leak): base64url (36 characters) 65 to 81 of 250 000 pass
  across four runs (the plan's figure 77; about 1 in 3 200), 53 to 61 of them behind a word prefix
  (`release_notes_archive_<token>`); standard base64 (40 characters, the AWS secret-key shape) 203 to 255 of 250 000
  (the plan's figure 230; about 1 in 1 090), 171 to 217 of them inside a URL path where `/` reads as a path separator.
  The fix round (malformed escapes) cannot change these: the fuzz contexts are free text. Also passing: a seed phrase
  written with capitals, digits or punctuation, and a one-time link whose token is 14 or fewer pronounceable lowercase
  letters (letters-only values: a word-bearing run is prose by design, S9). A leetspeak or otherwise opaque segment inside
  a short code-extracted link (≤ 512 characters) reaches the planner unjudged: the mail is attacker-controllable, but
  the registration loop needs the exact link, encoded sentences are decoded for the judge, and the length cap bounds it.
  A result reaches the planner with only its withheld or framed passages and its mirrored masks changed.
- **Verdict correctness is measured by C1, not C2.** The live gate's C2 checks that seeded secrets never leave and that
  a free-text passage is answered; it does not assert a verdict on a synthetic sentence. On real Jev a synthetic
  "see `<link>` now" sentence with its link masked was withheld (p 0.65) whichever of three placeholder spellings was used,
  while 0 of 46 real clean passages with masked URLs were withheld. Whether the judge's verdicts are right is measured on
  real data (C1: recall on the held-out planted corpus, false positives on clean passages captured from real tools).
- **Assumptions added:** omp marks continuations with isTerminal false (source and a live capture of the terminal form,
  2026-10-13; the non-terminal form is source-derived, since the live probe could not provoke it); Houge's spawn has no
  background tools; omp honours `retry.maxRetries` / `retry.maxDelayMs` (the C6 residual above); Jev's run-to-run
  spread is bounded by the measured band.
- **Revisit when added:** the golden set drifts twice in 30 days; omp adds background tools to Houge's spawn; TypeSafe
  ships deterministic answers (then the band goes); `omp config get` learns to show the overlay (then C6 becomes a hard
  check).
