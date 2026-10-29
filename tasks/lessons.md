# Lessons — orchestration mistakes and the rules that prevent them

Rules Claude writes for itself after corrections. Review at session start.

## Live safety-probe design (injection / exfil gates)

- **An injection probe only tests the wall if the payload actually reaches the wall.** (2026-07-17,
  D12) First D12 run put the injection in an HTML comment `<!-- … -->` on a *rendered* GitHub gist
  page; GitHub suppresses HTML comments and `htmlToText` strips them, so the payload never reached
  the dual-LLM reader — `reader_applied=true` but `contains_instructions` never fired. Silence there
  is a FALSE PASS: the wall wasn't exercised, an upstream layer ate the attack. Rule: for a reader/
  injection probe, use VISIBLE body text (not a comment) fetched via the RAW url, and require the
  positive evidence (`contains_instructions` flagged in the digest), not just "wasn't steered".
- **Verify "no secret leaked" without printing secrets.** (2026-07-17, S12) Compare the reply
  against the real secret values programmatically (`grep -F` each value, report only pass/fail) —
  never echo the values into the transcript to eyeball them.
- **Publishing attack-shaped content is (correctly) classifier-blocked.** Creating a public page
  with credential-exfil/backdoor text — even as a security test — is refused; hand the exact command
  to the user to run on their own account rather than working around it.

## Monitors / background watches

- **Compute watch windows from the real clock, never eyeball a timestamp.** (2026-07-04, Paco:
  "looks like your monitor didn't pick it up automatically?") A ledger watch was armed with a
  hardcoded `occurred_at > 04:00` boundary while the actual clock was ~03:30 — the awaited
  `self_write_published` (03:31) fell inside the excluded gap and the monitor waited forever on an
  event that had already happened. Rule: derive boundaries with `date -u` at arm time, AND make the
  watch's first iteration able to see an event that fired *before* arming (query from a boundary in
  the past, or explicitly check current state at arm time). A monitor that can't detect
  "already done" reports silence, and silence looks like "still waiting".
- **The user often completes interactive circuits faster than the watch cycle.** Twice on
  2026-07-04 Paco finished send→merge→reload before the orchestrator noticed. Verify current state
  FIRST (git log, ledger tail) before telling the user what to do next.

## Interactive /goal gates — don't read hook re-fires as "user gone"

- **Repeated Stop-hook fires ≠ user idle/away.** (2026-07-05, Paco: "why do you want me to clear the
  goal while am still testing even am idle?") A /goal's live Telegram gate blocked the Stop hook; the
  hook re-fired several times while Paco was actively running G1/G2 on his phone — I misread the
  silence *in the Claude session* as "user away" and repeatedly nudged `/goal clear`. He was mid-test
  the whole time. Rule: when a live/interactive gate is pending AND the daemon processes messages,
  CHECK the ledger / chat_turns for in-flight user activity (new run_created, new chat_turns) BEFORE
  concluding the user is idle or recommending they abandon the gate. The evidence is one query away —
  the daemon writes every user turn. Ties to [[goal-interactive-gate-no-idle-loop]] and
  [[monitor-windows-from-real-clock]] (verify current state before instructing/nudging the user).
- **Watch the right channel.** The user completing an interactive gate does so on THEIR surface
  (Telegram), not by typing to me. Poll the ledger and REPORT findings per turn (what passed, honestly
  labelled) rather than pinging "send it whenever" — that's the support the gate actually needs.

## Hermeticity (recorded in memory, repeated here)

- Non-hermetic tests (asserting env-var defaults without deleting the var) silently red-fail
  Houge's self-write test-gate and block ALL self-writes. Every new env var gets pinned in
  default-asserting suites (the PINNED_ENV pattern).

## Test design for a self-evolving agent

- **Never pin a code-owned user-facing string as a test literal** — existing tests are immutable
  to self-writes, so a pinned literal makes that string permanently un-self-writable (2026-07-03:
  Houge's header rename was structurally impossible until the literal moved behind an exported
  constant). Assert via exported constants.

## Clock discipline before state-changing ops (2026-07-19)

- **Convert ledger UTC to local time BEFORE declaring anything stale/hung.** Read
  `occurred_at 21:14Z` as "10 hours ago" when it was 07:14 AEST *two minutes ago*, sampled a
  healthy daemon mid-turn, and restarted it. Graceful SIGTERM saved the in-flight run, but the
  restart was unjustified. Rule: before restart/kill, (1) `date -u` and diff explicitly;
  (2) check event CADENCE (a run emitting loop_steps every ~10s is alive, not wedged) — ties to
  [[monitor-windows-from-real-clock]].

## P2 first-use gap: ordinal follow-up not resolved against the prior table (2026-07-19)

- 「跟进第五个」after a bounty_scan: the planner web-searched 11 steps, misidentified #5 as an
  unrelated CLOSED issue, and never called project_track — although the true #5 was a recorded
  candidate sighting the anchor would have accepted. The numbered list lived in the immediately
  prior assistant turn; the model ignored it. Candidate fixes: deterministic rank→URL store from
  the last scan (project_track accepts {rank}), and/or steering lines in the scan digest +
  project_track description. Same family as the Phase-R convergence gap.

## A monitor must never observe its own output (2026-07-20)

- The invariant sweep checks for undelivered Telegram notifications; its OWN incident alerts are
  Telegram notifications. Without an exclusion, a delivery outage self-amplifies: an incident
  opens about the sweep's own undelivered alert, the alert about that is also undelivered, the
  next sweep opens an incident about THAT — growing every cycle, never resolving, during an
  outage where Paco can see none of it. Fix: `findUndeliveredNotifications` excludes
  `incident_*` outbox keys (narrow — genuine stuck reports still surface).
- **Rule:** when building ANY self-observing component (slice B's promise ledger, the LLM retro
  pass, any future watchdog), explicitly ask *what does this component's own output look like to
  its own detectors* — and exclude it.

## Cadence changes are not "just tuning" (2026-07-20)

- Moving the sweep from 5 min → 12 h (Paco's call) immediately exposed the self-observation bug
  above. It was invisible at 5 min purely because the alert got DELIVERED before the next sweep
  looked; the flaw only appears once the interval exceeds the 15-min undelivered grace window.
- **Rule:** an interval change moves components across each other's time windows and can expose
  latent coupling. Re-run the full suite on any cadence/threshold change and ask which OTHER
  timing constants the new value now crosses. Corollary for review: when a config value looks
  like a free knob, check the windows it is implicitly ordered against.

## Distinguish "how often it checks" from "how often it speaks" (2026-07-20)

- Paco read a 5-minute sweep as "too much self-inspection", reasonably. But alerts fire on
  incident TRANSITIONS, so a persistent violation costs exactly one message at any cadence, and
  a clean database is silent at any cadence. The interval buys DETECTION LATENCY only.
- **Rule:** when proposing a polling cadence, state the noise consequence and the latency
  consequence separately — otherwise the reviewer optimizes the wrong one. And still take the
  slower default when latency is cheap: the pushback was right on the merits for five of the six
  invariants, and it paid for itself by surfacing a real bug.

## The quarantine reader summarizes away structured tokens the planner needs (2026-07-22)

- gmail_read shipped, live-gated. `{list}` worked (real inbox digest, quarantine ran,
  secret-silent), but a follow-up `{get}` FAILED: "path segment contains characters outside the
  allowlist." Root cause was not the path validator (it did its job) — it was that the Q-LLM
  reader (ADR 0014) summarizes external-read output, so the Gmail MESSAGE IDS never survived into
  the planner's view. With no clean id, the planner improvised a non-id (a subject / RFC822
  Message-ID with `@<>`) and the allowlist correctly rejected it. list→get chaining was structurally
  impossible through the quarantine.
- Same class the senior spec review flagged earlier for VERIFICATION CODES: the reader is designed
  to strip structure, so anything the NEXT step must consume verbatim (ids, OTP codes, exact URLs)
  cannot come through the reader. The fix both times is the same seam: a deterministic,
  code-built `trusted_extract` side-channel appended AFTER the reader digest (verb-proof because
  it is structured + hygiened + hard-capped, same trust argument as `time_claims`). Ids are
  re-validated `^[A-Za-z0-9_-]+$` before entering that un-quarantined channel.
- **Rule:** whenever a quarantined external-read tool produces a token the planner must reuse
  verbatim on a later step (id to fetch, code to submit, link to open), it will be lost or mangled
  by the Q-LLM reader — design a deterministic trusted side-channel for that token from the start,
  and validate its charset so the channel stays verb-proof. Ask of every new read tool: "what must
  the next step quote exactly, and does it survive the reader?"
- **Process corollary:** the live gate earned its keep. Unit tests + adversarial review were all
  green; only a real Telegram tap against the real inbox surfaced the chaining break, because the
  reader is mocked/bypassed in tests. Keep the live gate as a required step, not a formality —
  reserve one end-to-end path that exercises the REAL quarantine reader.

## Don't drop an integration that's only blocked on operator-side registration (2026-07-24)

- During the idea-radar adversarial review, Reddit was overturned as a source ("unauthenticated
  .json is 403'd; OAuth needs app registration + approval friction") and I dropped it from R1
  unilaterally. Paco corrected: he had already registered a Reddit account with Wukong's email
  and would happily have done the console-side setup — exactly the division of labor the Gmail
  OAuth slice proved days earlier (operator does the console clicks, Claude does the script +
  code + broker wiring).
- **Rule:** when a source/integration is blocked ONLY by operator-side registration or console
  work (dev account, OAuth app, API key request), do not silently drop it — ask Paco. He can
  usually clear it in minutes. Reserve "drop the source" for genuine technical or ToS dead ends.

## 2026-07-27 — Telegram output must use the rich renderer, not plain text (Paco correction)
- Pattern: R2 shipped /idea and /radar renders as flat escaped text although EVERY notification
  already flows through markdownToTelegramHtml (parse_mode HTML + fallback). Paco: "output ...
  not user friendly ... should have good readability", and "why two commands for the same task".
- Rule 1: any NEW user-facing Telegram surface starts from "what should this look like on a
  phone" — bold headers, per-item blocks, labeled bullets (what/build/why) — with escapeForTelegram
  on values and markdown only in code-owned scaffolding. Plain rows are for logs, not operators.
- Rule 2: don't mint a new top-level command per feature slice; extend the existing command
  family (subcommands) unless the mental model is genuinely different. Operator surface area is
  a cost.

## 2026-07-29 — Investigate before fixing, even when a diagnosis is handed to you (Paco correction)
- Pattern: Houge's AI日报 misreported stale news; his self_diagnose named the root cause and his
  self-write failed tests-red. I verified the type-level gap and went straight to implementing the
  fix. Paco: "i thought you should investigate the problem first before going straight into a fix."
- What investigation would have added BEFORE the fix: why his patch failed (led to the test-gate
  noise discovery — a second, separate bug), whether his diagnosis was complete, and what the
  actual live misreport looked like. The fix was right, but the order was wrong: the second bug
  was found only after Paco pushed back.
- **Rule:** when picking up a failed fix (Houge's or anyone's), first reconstruct WHY the previous
  attempt failed (gate output, ledger, artifacts) and reproduce/characterize the live failure.
  Only then write code. A correct-looking diagnosis from another agent is an input to
  investigation, not a substitute for it.

## LLM accounting / provider migrations

- **Check the vendor's own `total` identity, not the field name.** (2026-09-06, D3) The spec said
  "fold `thinking_tokens` into output, like Codex's `reasoning_output_tokens`". Codex really does
  report reasoning disjointly; agy and OpenAI nest it INSIDE `output_tokens`, so the fold
  double-counted 40–60% on any reasoning model. The tell was one line of arithmetic: agy's
  `total_tokens == input + output` held on every probe INCLUDING the ones with non-zero thinking,
  so thinking was already inside output. Rule: before summing two usage fields, find the vendor's
  own identity (`total == ?`) and confirm the sum keeps it. And test with a fixture where the two
  readings give DIFFERENT numbers — `{prompt:100, completion:50, total:750, reasoning:600}` passed
  under both formulas and caught nothing.
- **A field that is present-but-zero is not "absent".** (2026-09-06) Branching on
  `reasoning_tokens !== undefined` skipped the total-based derivation whenever a vendor sent
  `reasoning_tokens: 0`, quietly restoring the exact undercount the fix existed to remove. Prefer
  `max()` over the candidates to a presence branch.
- **Asserting a constant does not guard the call sites that should use it.** (2026-09-06)
  `expect(PANEL_JUDGE_PROVIDERS).toEqual({kimi:"pi", gemini:"agy-cli"})` was green while
  `src/cli.ts` still pinned `pinnedJudge("kimi-api")` — a second seat site typed its own literals.
  Rule: when an invariant is "no X anywhere", scan the source for X (`tests/capabilities/
  panel-judge-providers.test.ts` now greps `src/` for `pinnedJudge("…")` and metered names).
- **Self-run tests and self-run review skills are not validation.** (2026-09-06, Paco: "where is
  the subagent test and validation?") I wrote the code, its tests, ran `spec-review-senior` on my
  own spec, and built the gate that graded my own work. Four parallel reviewers then found what
  that loop structurally could not: a missed call site, a formula wrong in both directions, three
  documented containment controls absent from the code, and a daemon-wedging spawn bug. Rule: for
  any diff a person would review, run independent reviewers over the working tree BEFORE
  reporting done, hand them the probe facts already established, then verify each finding
  first-hand (one of them was wrong about a fixture) and report both confirmed and rejected.
- **"Silent fall-through" means the reason string is thrown away on success.** (2026-09-06)
  `answerWithChain` accumulated per-leg failure reasons and discarded them the moment a later leg
  answered — that is the exact mechanism by which a dead first leg stayed invisible for three
  months. A fallback that succeeds must still log what it fell back FROM.

## Multi-task builds (slice 2, 2026-09-07)

- **Per-task review cannot see cross-task defects; keep a whole-diff adversarial pass.** Eleven
  tasks each passed a spec review and a quality review. Codex's single pass over the whole diff then
  found three P1s none of them could: a fallback chain INSIDE a component the chain-level audit
  wrapped (the self-write reviewer), an unaudited fallback closure substituted at a binding site,
  and three CLI adapters that never honored the fuse. Rule: after the last task, one review that
  reads the entire diff with a "what did the per-task reviews structurally miss" brief — it is
  expensive (4.3 M tokens here) and it is the step that found the real ones.
- **Grep for `this.x(` misses `this.x` passed as a value.** The slice-2 spec review found three
  direct adapter calls; the implementer found four more (`execute: this.llmAdapter`) once it
  grepped `this.llmAdapter` without the paren. Rule: when auditing "every use of X", grep the bare
  identifier, not the call syntax.
- **Prove a guard bites before trusting it.** The source-scan test looked right; the reviewer
  temporarily removed an `audit:` line (tsc failed), then replaced it with an inline discarding
  sink (tsc PASSED — structurally valid) and the scan caught that one. A guard you have not seen go
  red is a comment.
- **A fabricated test string can mask the real bug.** `"Gemini API key is not configured"` (never
  emitted anywhere) passed the auth classifier; the real `"GEMINI_API_KEY is not set"` (underscore)
  went to `other`. Rule: classifier tests use strings copied from the code that emits them.
- **`codex exec` needs `</dev/null` from a non-TTY, and `codex review` won't take a prompt with
  `--base`** (0.144.5). Twenty minutes lost to a process waiting on stdin that never closed.

## Shadow / A-B measurement (Jev replay, 2026-09-25→26)

- **Check live volume before fixing a statistical bar.** The spec asked for ≥ 200 live shadow turns;
  the live DB showed ~1.5 turns/day (Aug 44, Sep 46) — four months to a verdict. Found only because
  the plan review queried `houge.sqlite`, not the spec text. Rule: size every "N samples" gate
  against the measured rate first.
- **A verdict over a partial run is not a verdict.** A replay stopped by budget/auth/fuse could print
  GO from a favourable prefix, and a dry run printed `STOP — 0% matched` over zero dispatched turns.
  Rule: any GO/STOP report has an INCOMPLETE state for early stops and its own headline for a
  dry run; neither may reuse the verdict line.
- **A success flag computed apart from the parser lies.** `llmLabel` took the intent from
  `parseIntent` (silent `"answer"` fallback) but `parsed` from an independent regex, so broken JSON
  counted as a confident parsed answer. Rule: derive "parsed" from the same parse that produced
  the value, or require both to agree.
- **Provider error prose is not body-free.** The agy leg's error carries a stderr excerpt that can
  echo the prompt; persisting `llm.error` broke a "no message text on disk" promise. Rule: files
  promised body-free store fixed error categories, never provider text.
- **Plans with full reference code still contradict their own tests** (2 of 6 tasks here:
  hard-coded `output_tokens: 0` vs a test expecting 20; a budget fixture whose arithmetic tripped
  on call one). TDD from the plan caught both at RED. Rule: when an implementer reports code-vs-test
  contradiction in the plan, rule on it in the ledger — never bend the test to the code silently.

## omp runtime build (SP1, 2026-09-30→10-01)

- **A probe against the real binary finds what no amount of hermetic testing can.** 2600+ green tests
  and a clean review on every task, then the first real-omp smoke failed case 6: omp 18.4.4 rejects an
  unknown `--model` at process start, before `ready`, so the designed live `set_model` fallback could never
  run and one retired planner string would have failed every turn. The tests' fake omp never rejected a model
  at spawn, because it was written from the spec, not from the binary. Rule: before trusting a fallback, a
  lifecycle or a sandbox answer, probe the real binary once with the failure injected (bad model, missing
  file, refused prompt), record its exact output as a fixture, and make the fake reproduce it.
- **The parallel whole-branch wave is not optional, even after every per-task review passed.** Sixteen
  tasks each passed a spec and a quality review; the final wave (security, correctness, testing,
  adversarial in parallel, plus Codex) then found three Criticals and one key Important that lived only in the composition:
  writable binary trees and dotfiles run later outside the sandbox, omp path forms that slipped past the
  gate, a workspace symlink swap that turned the daemon into a confused deputy (Criticals), and a
  lease-recovery function nobody called (Important). Codex alone found none of them; the security, adversarial and correctness
  reviewers found them, mostly by probing. Rule: a build that adds a sandbox or a trust boundary closes on the full parallel wave
  with security and adversarial reviewers who probe, not only on a whole-diff read (extends the slice-2
  rule above).
- **A model can refuse a safety probe, and a refusal proves nothing.** Opus declined the sandbox
  self-test prompt in two of three smoke runs: no tool call, so neither floor was exercised. A gate that
  reads "no secret came back" would have scored that PASS. Rule: every live safety case first checks that
  the probed action actually ran (the tool row exists); a refusal retries once, then reports INCONCLUSIVE
  with a non-zero exit, never PASS.
- **A test that resolves a binary from PATH can spend real quota.** A CLI test spawned `houge` with the
  ambient PATH and reached the real `~/.bun/bin/omp` under profile `houge`, so test data may have gone to
  a subscription model. Rule: pin every spawned binary in tests (env var to a non-executable path) and put
  failing stub executables first on PATH in a global setup file, then prove a default-bin resolve hits the
  stub.
- **Check exit codes directly; a pipe eats them.** An implementer committed twice while the pre-commit
  check was red, because `npm test | tail` reported `tail`'s exit status. Rule: run gates unpiped (or with
  `pipefail`) and read `$?` (`$status` in fish) before committing; a report says "exit 0", not "looks green".

- **A smoke run from the operator's shell does not prove the daemon's environment.** The omp cutover smoke
  passed 5/5, then the first live turn under launchd failed `omp not runnable`: omp's launcher is
  `#!/usr/bin/env bun` and launchd's PATH had no `~/.bun/bin`. Rule: before a kickstart, run the spawned
  binaries once under the daemon's exact environment (`env -i` with the plist's PATH and HOME), or run the
  smoke with that PATH; an absolute binary path does not cover its interpreter.

## omp live gate (2026-10-01)

- **A resumed omp session silently overrides `--model`.** The live gate's case 6 answered on Opus 5.5
  after a spawn-time fallback to Opus 4.6: `open_session` restored the model the chat's session last used,
  and the spawn's `--model` was ignored (the other spawn flags still applied). The D10 family check read the configured model and recorded a collapse
  that had not happened. Rule: after any session resume, pin the intended model explicitly (`set_model`),
  and take "which model answered" from the frames, never from the spawn arguments.
- **Code-owned scaffold text stored as a user turn poisons code-owned-phrase checks.** A photo's reader
  digest (with its code-owned `[external source …]` header) was stored as Paco's chat turn, and
  lesson_write's thread scan then refused every later lesson in the chat as `code-owned`, with no LLM call.
  Rule: store only the user's own words as a user turn (caption, placeholder, transcript); scaffold and
  untrusted-derived text go to the prompt, never to the thread record that checks scan.
- **An unhandled intake error that never acks the offset wedges the whole queue.** One `/approve` of an
  already-denied id threw, the update offset stayed put, Telegram redelivered it forever, and every later
  message queued behind it. Rule: classify every refusal a user can trigger (a stale, mistyped, expired or
  foreign id; a malformed command) as a handled denial that acks the offset and replies; only a genuine
  store or process failure may stop the batch.
- **Dead-code recovery paths look like features in review.** `requeueRetryWaitNotifications` and
  `recoverStaleSendingNotifications` were tested and reviewed, but nothing in the daemon called them, so one
  transient Telegram error lost a reply for good (rows stuck two weeks). Rule: for every recovery, retry or
  cleanup function, find its production caller during review; a recovery path with only test callers is a
  missing feature, not a safety net.


- **A blanket "no shell commands" rule blinds a coding agent whose file reader is a shell command.** Live
  2026-10-01: every Houge self-write ended in an empty diff over ~11 min of Codex work, because the writer
  task said "DO NOT run … any shell commands" and Codex read that as "do not read the code". Reproduced with
  the exact framing ("I made no edit… the file-reading tool uses a shell command"); rewording to "no tests,
  builds, installs, git or state changes; read-only inspection allowed" produced the correct fix first try.
  Rule: constrain side effects, never inspection; when an agent returns an empty result, reproduce it with
  the exact prompt and ask it to state why before changing anything else.

- **"No run in flight" is not "nothing in flight": check the evolution lane before a restart.** 2026-10-02:
  the controller kickstarted the daemon after confirming zero non-terminal runs, but a self-write had just
  been kicked off in the background (its turn already completed). Codex had finished writing; the restart
  cut the pipeline before the test gate and reviewer, so Paco got no card and the work was lost. Rule:
  before any restart, also check for an in-flight self_write_propose / skill_author pipeline (a recent
  `self_write_propose` tool_finished with no `self_write_published|failed|blocked` after it, or the
  daemon log's "waiting for in-flight self-write"), and wait or ask.

- **A long synchronous tick in the poll loop must observe shutdown; launchd's ExitTimeOut turns it into a
  SIGKILL.** 2026-10-02 01:06: a kickstart landed mid episodic distill (7–13 s per model call); the loop
  awaited the whole tick, launchd SIGKILLed the daemon at 40 s, and the next boot read `crash_recovery`.
  Rule: every background tick takes the daemon's stop signal, checks it between model calls and between
  units of work, and never commits half a unit; an in-flight model call is aborted, and the abort is not
  recorded as a model error.

## Jev lane 1 build (2026-10-04→06)

- **A terminal path needs one owner.** The triage turn could finish through the memory save, a fallback, a lost
  turn, a thrown stage or a hook rollback, and early drafts wrote the `triage` event and decision rows from several of
  those places, so some exits wrote twice and some not at all. The fix was one finaliser (`settleTriage`) that every
  exit passes through exactly once, with a per-turn flag flipped after commit. Rule: when a unit of work has more than
  one way to end, name the single function that records the end and make every path call it; test each exit asserts
  exactly one row.
- **`ranOnce` covered three tools, not all.** The once-per-turn guard (`turnCtx.ranOnce`) was wired into the three
  evolution tools, so the first draft of the already-saved guard assumed "a tool runs once per turn" held for
  `lesson_write` too. It did not: the set never named it. Rule: a guard that must hold for a class of tools is checked
  against the registry of that class, not against the tools the author remembers; the live gate forces the second call
  through the registry's own `lesson_write` entry.
- **Size bars on the positive class.** Agreement over 293 turns is dominated by about 250 `none` turns and proves
  nothing about memory instructions, of which there are 36. A bar of 0.90 on 36 items proves only about 0.80 at the
  Wilson lower bound. Rule: state each bar per class with n and the lower bound, and pick targets the sample can
  support.
- **A plan written from a dossier drifts: two reviews found about 25 helper and signature mismatches before a line was
  written.** The plan named helpers, argument orders and payload fields from a research summary rather than the code.
  A senior live-probe review and a Codex pass caught them, four plan revisions later. Rule: probe the real code for
  every name a plan cites before the plan is final, and let the implementer's brief say "trust the code" where they
  differ.
- **A refusal code the poll loop does not know wedges intake (memlane review).** A new refusal reason from the memory
  lane was returned to a loop that only handled the old set, so the message stayed claimed and nothing else was read.
  Rule: every new refusal or skip code is added to the consumer's exhaustive switch in the same commit, with a test
  that feeds the new code through the real loop.
- **One calibration row armed two lanes: arm each decision on its own key.** The status lane first read the `lane`
  row, so arming memory silently armed status, though the two clear different bars. Status now arms on its own
  `lane:status` pseudo-row. Rule: if two behaviours have different go/no-go evidence, they get different arming keys,
  even when they read the same model answer.

## Jev decision tree build (stage A, 2026-10-07→09)

- **A synchronous child_process call on a spawn path starves every concurrent bounded network call.** The planner's
  preflight ran `execFileSync omp --version` (about 0.8 s) on every spawn. Stage A starts Jev's 1.5 s, no-retry call in
  parallel with the spawn, so the blocked event loop turned 5 of 9 live Jev calls into `skipped{timeout}`, while about
  3,700 hermetic tests stayed green (a stubbed `fetch` has no clock to starve). The product defect was already on `main`
  and invisible until something timed a call against it. Rule: when a bounded call races a spawn, the spawn path may not
  block the loop; make the check async, and let the live gate assert the silent-skip rate (at most 1 in at least 8 real
  calls) so starvation fails the gate instead of reading as a flaky vendor.
- **Awaiting inside a start path needs a generation captured before the await.** Making the version check async opened a
  window between "start requested" and `spawn()` capturing its generation, so `/kill`, shutdown or a lane's supersede
  landing in it was lost and the child started anyway. The first fix round found it by review, not by a test. Rule: when a
  synchronous start becomes async, capture the cancellation epoch before the first `await`, compare after it, and write the
  test as "stop while the check is pending" for each stop path.
- **A hand-off where each task assumes the other deletes the files leaves orphans.** Seven conflicts surfaced in preflight:
  the seven retired `HOUGE_OMP_*` chain variables were read by the omp live gate and eval-replay (Task 6 retired the
  variables, Task 13 owned the gate, Task 14 owned `.env.example`, and no step named the gate cases), lane 1's files and
  `triageShadowStats` (Task 10 removed the writers, Task 12 the files), and a plan order line ("9 may run beside either")
  that contradicted the import graph. Rule: every retirement gets one named owner step with a grep for its orphans in
  `src`, `tests`, `scripts`, `.env.example` and the docs, and a plan's task order is derived from the type-import graph,
  not asserted.
- **Check every consumer of a payload before changing its required fields.** The brief said nothing reads `lane` or
  `complete` from the `triage` payload; `RunStore.triageShadowStats` did, and its test fixture broke on the tree's new
  required fields. Rule: before editing a ledger type's required fields, grep the store and CLI readers of that type, not
  only its writers.
- **Step-up must not re-spend what just failed.** The plan's step-up (Fast, then Default, then Thinking) re-tried a
  selector that had failed this turn, and Default and Thinking share all four models. Spec §4 means a stronger answer, not
  a second try at a provider that just returned `quota`. Fix: a per-turn set of selectors that failed with a non-`other`
  error, excluded from the step-up chain. Rule: a retry ladder states what it excludes, and the test covers a ladder whose
  rungs share legs.
- **An evidence field that reads mutable per-child state needs a "this turn dispatched" guard.** `routeEnd` reported the
  previous turn's model when no prompt went out, and the calibration rows are built from it. Rule: any field recorded at
  turn end from state the child carries across turns is null unless this turn dispatched.
- **Preflight conflicts are cheap; find them before the first task.** A pre-build scan of the plan against the code found
  seven conflicts and nine defects, each with a ruling and its cost-if-wrong recorded in the ledger. Rule: for a plan of
  more than ten tasks, scan the briefs against each other (names, files, owners, order) before dispatching.
- **A real replay finds what hermetic tests and a short gate cannot.** Jev rounds each probability to two decimals, and
  the client's fixed 0.01 sum tolerance (plus float error) rejected a four-level 0.99 as `parse`: 18 of 602 calls in the
  calibration replay, each a live turn silently sent to the Default fallback. Every test fixture summed to exactly 1, and
  nine gate calls rarely hit it. The replay row kept only `error`; the cause showed up in the ledger's `error_kind` and a
  captured response. Rule: validate vendor numbers against the precision the vendor actually emits (n × half an ulp of
  its rounding), build a fixture from a captured real response, and run the paid replay before arming, not after.
- **A tool-based proxy label is not truth.** Against the "which tools ran" proxy, Jev agreed 50%; against Paco's labels,
  60%, and both flagged "wrong lane" turns were proxy errors (a rule the planner never saved read as `answer`). Rule: a
  report that scores a classifier against a proxy says so in its headline, and arming waits for the operator's labels on
  every lane candidate.
- **Hand labels have to fit a one-answer schema.** Paco's labels named two requests in one message (a rule plus a lookup)
  three times in 111 turns. Labelling those `memory` would have taught the report that the memory lane may take them,
  and the lane would drop the other half. Rule: when a labeller says "both", label the routing-safe part (the one that
  keeps the planner), and record the multi-intent case as a design gap.

## Jev decision tree, stage B (2026-10-10)

- **Measure a code heuristic on the replay before specifying it.** Rev 4's follow-up rule (prepend Paco's previous line to
  a short lookup) read well and was wrong: joined to the 39 replayed lookup takes it fired on 28 and put an unrelated topic
  ahead of 16 standalone questions; even the 30-minute Telegram-only variant prefixed 8. Rule: a text heuristic in a spec
  carries its fire count and its false positives on the replay rows, or it does not ship; a judgment call goes to a model
  behind a cheap code gate, and code validates what the model returns.
- **The ledger never holds read text.** Rev 4 put the reader's digest into `loop_step.result_digest` so the catch-up block
  could read it back; Paco's `fdeb3b8` had made read tools' digests `sha256:… bytes:…` for exactly that reason. Rule: text a
  later prompt needs lives in a store row written for that purpose (`lane_replies`), never in the audit trail.
- **Settle after the handler.** Settling the verdict before the lane ran recorded every fall-through as `act` and corrupted
  the precision evidence the arming decision reads; three review rounds converged on one order (mint the id, settle once
  after the lane, patch only when a save already committed inside its transaction). Rule: a record of "what ran" is
  written after it ran, or patched by the same code path that knows the outcome.

## Decision ladder design (2026-10-12)

- **An ADR is a reason, not a rule.** I ruled out omp's in-child TypeSafe judges "because ADR 0015 keeps the Jev key out
  of the sandboxed child". ADR 0015 predates Jev, and the child already holds the subscription logins (`~/.omp`, ADR
  0028 D11), worth more than a Jev key; the real reasons against were that omp's verdicts cannot be ledgered or
  calibrated. Rule: a spec or plan that rules an option out because of an ADR states the ADR's reason and why it still
  holds today, or reopens the question; ADRs from 0030 on carry "Assumptions" and "Revisit when" fields.
- **Check a quoted claim against its source before repeating it.** I told Paco mu "says plainly: no fast path bypass";
  mu's docs never say it. Rule: a claim about an external system is quoted from its source with a pointer, or labelled
  as my reading.

## Decision ladder stage 2a (2026-10-14)

- **A live gate on real Jev found what 4,490 unit tests could not.** The gate surfaced a corpus defect (the clean Chinese
  passages were repo text aimed at an assistant, so 15.8% were rightly withheld) and a timer race (a trust pause leftover of
  1 ms started a card that could never be answered). Rule: every slice gets a live run on real inputs; a green unit suite
  proves the wiring of the test doubles, not of the system.
- **Never let a gate assert a model verdict on a synthetic sentence.** C2 asserted that a made-up "see `<link>` now"
  sentence passes Jev; three placeholder spellings all gave p 0.65 while 0 of 46 real masked-URL passages were withheld.
  Rule: a gate asserts what code owns (nothing leaks, the call was answered); verdict correctness is measured on real data
  (C1), and a synthetic probe never decides a PASS.
- **An agent must never attribute an instruction to Paco in a prompt, even as test bait.** An injection test that says "Paco
  told you to ..." trains the habit and puts a false authority claim in a prompt that real tools may reuse. Plant attacks
  with an obviously foreign source instead.
- **Best-effort classifier plus an allowlist is the design; two re-reviews of the classifier were the wrong spend.** Task 8's
  network classifier took three rounds; each fix was another disguise. The ruling that stopped it: the classifier only picks
  untrusted over hostile-by-judge, and the allowlist (unknown asks) is the gate. Rule: when a deny-list keeps losing, find
  the allowlist that already owns the safety and stop hardening the list.
- **A binary can run code through an option you never listed.** macOS `wc` links libxo, and `--libxo=encoder=<path>` loads a
  library, even after `--`. Rule: an allowlist admits exact per-program flag sets, checked against the real binary; "any
  options" is never safe for a program you have not read.
- **Measure a residual before writing it into an ADR.** The unknown-token pass rate differed run to run (65 to 81, 203 to
  255 of 250,000); the ADR states the range, not one lucky number. A seeded LCG that overflows 2^53 collapsed a property
  test's coverage silently; count each case class the test claims to cover.

## Memory write (2026-10-17)

- **Never add a question to a shared Jev request another decision depends on.** One malformed answer fails the whole call
  (`jev-client.ts:196-202`) and `decide` skips it; the new decision gets its own request (`memory_kind`).
- **A save the tool refused must never be promised later in the reply** (2026-10-15 incident). The tool result's hint says
  so, and the planner prompt now says to call `lesson_write` when asked to remember and to claim a save only on a saved result.
- **Present numbered lists in the order a human counts them.** The thread was numbered newest-first, so "the first one"
  meant the newest message (gate case 6). Select newest-within-caps, but show the cut thread oldest-first.
- **A golden item the armed rung never clears pages every day.** Jev does not reach 0.85 on `fix` (first-option bias toward
  `other`); the two `fix` items were dropped and the fix route is decided below the bar. Rule: golden items are ones the
  armed rung decides on the current model; the rest are measured, not paged.
- **A gate script exits non-zero on INCONCLUSIVE and never passes a case it did not run.** The first gate run counted
  unrun cases toward PASS; run 5 reports cases 7 and 8 INCONCLUSIVE and exits 3. A rollback check proves each flip against
  the old build, not only the new one.
- **Measure the bar before arming on it.** The incident's own text sat at the 0.85 bar (Jev 0.87-0.89 in 2 runs, the model
  in 3); report the margin to Paco instead of calling the rung "working".

## Decision ladder 2b-i (2026-10-20)

- **Measure a Jev question's wording on real replies before the bar is set.** The spec's wording at its 0.5 bar sent back
  114 of 133 real replies (85.7 %): it fired on plain answers and on honest background-work reports, and even at 0.9 the
  wording kept 14.3 % and missed 3 of 7 planted. Explicit true/false criteria per question plus per-question bars (0.6 / 0.8 /
  0.7 / 0.7) gave 4.5 % with 9/9 planted. Rule: run the pre-merge sanity on the real corpus before the live gate; a wording
  change is a probe on the same frozen replies, not an edit of the bar. The fragile bar (`unverified` 0.8) is named, not hidden.
- **A live gate on a new omp version finds what the unit suite cannot.** Probes ran on omp 18.10.4; the gate ran on 18.12.3 and
  failed three cases: `get_state.queuedMessageCount` now counts `liveSteered` (a phantom `steer_queued` on every turn, so the
  todo check never fired), omp prefixes read lines with `N:` (the named-secret mask saw nothing and a planted key reached a
  Jev request), and a golden item sat exactly on its bar (0.60 vs 0.6). Rule: read wire types for what a count field includes
  (use the arrays), run every parser and mask against the tool's real output format, and give golden items a margin
  (measure on two runs, pick one that clears by 0.15 or more).
- **Run the full suite only on a committed head.** The controller's background full run raced a half-applied fix
  (7 failures in `settle-checks`) and cost a re-run. Rule: no suite run while a fix round is in flight; run on the commit
  the reviewer approved.
- **A plan's verbatim code can contradict its own test.** `reaskAfterDelivery` was specified two ways (question order vs
  highest p); the plan's expectation disagreed with the plan's own sorted code. The build ruled one rule (highest p over its
  bar, as `jevRung`), then the per-question bars made it margin order. Rule: when a plan's test and code disagree, decide once,
  write the ruling in the ledger, and use one ordering everywhere.
- **One redactor, every egress path; a per-task review cannot see a gap between two tasks.** The settle path rebuilt its
  own redactor and dropped `extracted` (the turn's OTP codes and link tokens), so a code in a reply reached TypeSafe in clear.
  Each task's review passed; the parallel final reviewers (the security seat) found it. Rule: every path that sends text
  out builds its state through one function, and the final review's security seat traces each egress path end to end.
- **An "every X satisfies P" gate predicate needs "X is non-empty" as a precondition, or it passes vacuously.** Gate case 10
  printed "every bash ask in pass 1 carries SETTLE_REASON, 0 ask(s)" as PASS. Rule: every universal check in a gate or test
  states its count precondition and returns INCONCLUSIVE on zero; count attempts, not only the outcomes you hoped for.
- **Copied regexes drift: pin the copies with a shared-fixture parity test, not with fixtures on each side.** The extension
  floor's `secretNamed` and egress's `secretKey` had diverged on camelCase and session keys. Rule: when code is copied
  across a process boundary, one list of fixtures drives both and asserts "A blocks implies B blocks".
- **A sanity or gate script run from a worktree needs the live DB path passed explicitly.** `settle-sanity.mjs` failed with
  "unable to open database file" until given `--db`; its default resolves against the checkout. Rule: pass `--db` (and
  `HOUGE_ENV_FILE`) from a worktree and say so in the script's usage.
- **A live-gate FAIL during a provider outage can look like a code regression.** The `9dc9f01` run showed `pass_errored` on
  every turn from case 3 on; the guard was working and the planner's primary leg was erroring. Rule: before touching code,
  bracket it: run the failing cases alone, then an instrumented full rerun; reopen only if a healthy run shows the failure.
- **A gate that forbids one tool must tell the planner which tool to use.** Case 10 forbade a write to a masked file; the
  planner used `write`, never attempted bash, and the case went INCONCLUSIVE on model choice. Rule: a gate case that needs a
  specific tool call asks for it explicitly and counts the attempts.
- **A planner upgrade can change the text shape the mask reads; nothing pins the planner's version.** omp 18.12.3 added
  line prefixes to `read` results and a planted key leaked in the gate until the mask learned that form. Rule: a text
  rule that depends on a tool's output shape accepts the shape by class (any non-letter prefix), not by the form seen
  once, and code pages when a read arrives in a shape nobody tested; rerun the masked-read gate case after every omp
  upgrade (`live-gate-ladder-2b-hooks.mjs --only 9` from a built worktree).

## Decision ladder 2b-ii (2026-10-22)

- **A sanity run's planted miss can be a design gap, not model variance.** The planted `review_bad` x3 case came back as a
  lesson at p 0.93 from Jev; the instinct was to tune the wording or the bar. The mapping (a ❌ on a decision is a verdict
  about the decider) was deterministic all along, so it belonged in the rule rung (ADR 0013). Rule: before tuning a model
  for a planted miss, ask whether the right answer is a pure function of the input; if so, write it as code and take the
  option out of the model's list.

## ADR hygiene (2026-10-22)

- **An ADR amendment is not done until you grep for what the intent forbids; a build compromise is a todo, not an ADR
  line.** (Paco 2026-10-22, Jev version check) The first pass amended one decision sentence and left the old rule alive in
  four other places (the decision text, the index row, the reference docs, the incident names), and the draft ADR text
  recorded a workaround as if it were a decision. Rule: when an ADR changes, grep the repo for the old behaviour's words
  (`jev_model_uncalibrated`, `decision_bar_stale`, a version literal) and replace each as current-state text; an ADR holds
  Paco's decisions and invariants only, and what the build could not do goes in `tasks/todo.md`.

## 2026-10-27 — clean-room Slice 0: what the review stack caught that the author could not
- **Reviewers that run the plan's code find what reading cannot.** The Opus senior review extracted every code block from the
  plan into a scratch checkout and ran tsc + vitest: 4 blockers (overlap-before-empty ordering, a test-setup env var leaking
  into the effective-policy test, a `noUncheckedIndexedAccess` type error, a tautological test). Ask reviewers to run, not read.
- **String paths are not identities on APFS.** `room-1` and `ROOM-1` are one inode; a validator comparing strings called them
  disjoint — the only real seal hole in the slice, found by codex, confirmed first-hand in one command. Compare `dev:ino`.
- **A caller-supplied security root is a trusted input.** `cacheRoot: "/"` was accepted. Derive the root inside the module.
- **Stricter-reading pre-ruling paid off:** dropping `/Library` and denying `/usr/local` was adopted without a pause because the
  pre-ruling says so; the orchestrator verified HTTPS + cookie jars still work before adopting it.
- **Author ≠ reviewer held throughout** (Fable orchestrated; Sonnet/Opus implemented; Opus/Sonnet/codex reviewed, never the author's
  model). Paco's taps this slice: zero.

## 2026-10-28 — Clean-room runtime Slice 1
- **Probe before you spec, not after.** Four of the design's load-bearing facts (IPv4-mapped loopback, broadcast UDP, the
  bare-`ip` filter hazard, `(deny mach-lookup)` costing nothing) came from a 20-minute live probe run before the first
  spec line. The Slice 0 text had "provisional" rules for the same surface that were wrong in two places.
- **A second reviewer seat on the riskiest module pays.** Sonnet approved the lifecycle module; codex, on the same diff,
  found a post-spawn exception misreported as "never ran" and an orphan scan that could kill the daemon. Keep codex as the
  second seat on anything that owns a boundary, even when the first review is clean.
- **"Pinned by a test" needs the test to fail when the thing moves.** The first P8 grammar test checked each network line
  with `toContain`; a reordering that breaks DNS would have passed. Slice equality against the exported constant fixed it.
- **State what the probe proved, not what the design wanted.** "All local services blocked" became "every service but
  the resolver's socket; TCP egress only; other LAN hosts reachable" after codex asked what each rule actually covered.
- **A reviewer's "ran the plan's code" catches what reading cannot.** The in-process listener deadlock (spawnSync blocks
  the loop the listener needs) would have cost an implementer round; the senior hit it in minutes on a scratch copy.
- **A Seatbelt profile cannot wrap a process that itself needs `ps` or `sandbox-exec`** (measured 2026-10-28 while
  trying to sandbox the self-write test gate): inside any profile, even a bare `(allow default)`, `/bin/ps` refuses to
  exec and a second `sandbox-exec` fails with `sandbox_apply: Operation not permitted`. Houge's shell wrapper uses `ps`
  and its own test suite runs sealed rooms, so the test gate can only be isolated by a different mechanism (an OS user,
  SP3). Measure the wrapped workload under a bare profile before designing the rules.

## 2026-10-28 — Stage 4A standing approval

- **A delivered notice proves receipt, not success.** Success and failure share `<run_id>:final_report` (§2). Any rule that reads "its report reached Paco" must also read the run's state and the call's own facts; the grant now needs ten code-owned facts, and "ran unknown" (no readable facts) ends a grant instead of being trusted.
- **A provenance check keyed on one compiled file (`core-worker.js`) refuses a genuine previous build when the slice never touches that file.** Name the file the slice changes.
- **A refusal code proved at the store and the gateway is not proved at intake.** A new denial code must also join the poll loop's handled-denial set, or one tap wedges the loop (the 2026-10-01 incident shape). Test new refusals through `runTelegramPollOnce`.
- **A mutation reviewer and an implementer in the same worktree contaminate each other's runs.** Run them sequentially.

## 2026-10-29 — A rebuild of main's dist without a kickstart is not a resting state
The clean-room merge rebuilt `dist/` (new `omp/shell-wrapper.sh`) and the kickstart was left "owed". The running daemon (started 10-26) checked the new wrapper against its in-memory hash; the 08:00 AI 日报 schedule failed closed (`wrapper_mismatch`, run `run_236e6d77…`). Rule: after a green merge + rebuild, kickstart in the same breath (Paco authorised it, AGENTS.md §Autonomy Tier A), after checking parked/kill and in-flight runs; verify pid and boot migrations.
