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

## 2026-10-29 — Stage 4B bind + redact (differential gate)

- **"No row" is not evidence that the code ran.** A recorder that skips default verdicts makes every plain or allowed item pass on absence; an early return would pass too. Every gate line that relies on an absent row needs positive per-call evidence that the path executed (a counted probe, an adapter-only field), and a planted early return that proves it.
- **A copy of the live DB is private data with a lifecycle.** Every script that VACUUMs Paco's DB deletes the copy in a `finally` on every exit path, `--keep` included, handles SIGINT/SIGTERM/SIGHUP, and sweeps stale roots at start. Prints carry counts and labels, never content; detail only behind `--debug`.
- **Implementers' sandboxes and a loaded machine produce false signals.** Socket EPERM inside a reviewer's sandbox and vitest timeouts under an external runner's load both looked like defects. The orchestrator reruns gates and the suite outside the sandbox before ruling, and checks `uptime` / `ps` before blaming the diff.
- **A plan's own test code can carry the defect the rubric names.** Task 2's plan text collected recorder rows and never asserted them; follow the spec's intent over the plan's literal code, and ledger the ruling.

## 2026-10-30 — Stage 4C admits (differential normalisation)

- **"The next Stage N item" is defined by the specs, not by a numbering in a delta.** The ladder's own §13 row was fully shipped; the remaining Stage 4 work was what the Stage 3 spec had moved there by name (B23) plus an unclaimed row (B9). Before declaring a stage done, read every stage spec's "out of scope, later stages" list.
- **Every normalisation in a differential must keep what behaviour depends on.** This slice went strip → presence → ordered relabel → ordered relabel with the value's shape, each step after a reviewer showed the previous one hid a real change (a timestamp no longer equal to its row's `created_at`; JSON key order; a non-instant under a clock key; `Z` vs `+00:00`). Default to relabelling, never to dropping; filter new rows per pair, never globally.
- **A test hook "inside the save" must be proven to fire.** The plan hooked the fact-reconcile call, which only runs when a similar fact exists, so the abort tests passed vacuously; assert the hook's own counter.
- **A pin to "the merge base" must also work after the merge.** On `main`, `git merge-base HEAD main` is HEAD; gates need an explicit `--old-base`.
- **Only the orchestrator runs the full suite, and only on a quiet machine.** An implementer's full run under concurrent agents and codex reported 49 failures; the same head on a quiet machine passed 5850/5850.


## 2026-10-30 — Stage 3 remainder slice R1 (gateway intake)
- **A test that drives `kill` from the repo root stops the live daemon.** `handleKill` writes `houge.kill` at a cwd-relative default; the plan's exemption test iterated `RATE_LIMIT_EXEMPT` (which contains `kill`) with no tombstone pin. Codex caught it at plan review; no tombstone was written. Rule: any test, corpus or gate that can intake `kill` pins `HOUGE_TOMBSTONE_PATH` and `HOUGE_DISARM_PATH` to a temp dir first (the `kill-switch.test.ts` `PINNED_ENV` pattern) and asserts no `houge.kill` in the cwd or the main checkout afterwards.
- **Re-walk "the remainder" against `ENTRY_IDS` before counting.** The delta said 20; the registry said 19, and two of those failed §6.1's own entry test once probed (one absorbed, one not a path decision). Probes before the spec also found a widened exemption set (four commands, two literals), an inventory row that writes no audit, and decision points with no run — each became a spec line, not a build surprise.
- **A whole-DB dump is only a differential if it is deterministic.** Store writes stamp the wall clock in many tables; two identical runs differed in clock ranks. Run each item under a counting fake clock, drop the new rows *before* relabelling clocks (a dropped row still occupies a rank), keep `_json` columns raw, and self-test both coverage and determinism (each shown failing once).
- **A masked value must be proved, not blanked.** The corpus first replaced every uuid-bearing outbox `payload_hash`; review showed that hides a real hash change. Recompute it with the dist's own `stableHash` and mark it only when it matches.
- **Each gate takes its own old build.** The 4C gate compares against its own merge base (`c558413` + `--old-base`), not the current branch's; pointing it at the new merge base fails `same_build` and reads as a regression. Record each gate's exact invocation in its header and the slice report.
- **PASS lines that count or `every()` over a possibly empty set pass on nothing.** Task review found three such lines in the live gate (a kill that failed for another reason, an ack counted before the replay, an alert check over zero alerts) and three in the rollback (at-least-one seed rows, row count without content, a dropped A/F render comparison). Every PASS line names the exact expected value, and each is shown failing once.

## 2026-11-01 — Stage 3 remainder slice R2 (sender + contract)
- **Probe the poll loop for every refusal a parsed command can earn.** Reading the contract compile for R2 found `/run <unknown program>` → `TASK_CONTRACT_INVALID`, missing from the handled-denial set: one typo would have wedged Telegram intake (the 2026-10-01 shape, a third time). Before speccing any intake-side entry, list every error code the path can return and check each against `HANDLED_INTAKE_DENIAL_CODES`.
- **A new row on a common path ripples into every exact-row assertion.** `turn.contract`'s `restrict` row on every scheduled turn broke 7 unit tests and 4 differential corpora the plan never listed; the plan reviewer found it only by running Tasks 1–6. Before planning an entry that records on a hot path, grep every test and corpus that drives that path and asserts whole `decisions` tables, and update each to expect the row exactly (never filter).
- **"Exact" needs a mutation per PASS line.** Six of ten tasks needed a fix round, nearly all for checks that passed on too little (a total instead of per-intake counts, a lower bound, a timestamp-normalised digest, a baseline outside the `/status` window, a fixture that a narrowed predicate still satisfied). The final mutation pass still found one surviving mutant (the restriction re-derived from the event). Plant a mutation for each new assertion, not one per file.
- **Gates that read live data drift.** The `command`/`path` corpora pin exact counts over Houge's live omp transcripts, and the 4B gate refuses a live copy holding rows it expects to write: both failed for reasons outside the slice. Gates should snapshot or baseline live state, not assume it is frozen.

## 2026-11-01 — Stage 3 remainder slice R3 (bare ack + steer/queue)
- **Read the ADR's recording rule before placing a call site.** The first R3 spec recorded at the decision point; codex cited ADR 0030 §5 ("a turn that is lost writes no row") and the design moved every row to the incoming run's claim. Check the ledger rule for where a row may be written, not only where the decision is made.
- **"Not live" is not "idle".** `this.turn` exists before it is live and after; a drain is busy between turns. When mirroring a branch, enumerate the object's lifecycle states, not just the predicate's operands.
- **A plan reviewer's passing draft is worth keeping.** The senior ran Tasks 1–2 and left green code; saving it to the scratchpad and pointing implementers at it cut both tasks to a check-and-tighten pass.
- **A comparator that strips ids by key name hides ownership.** The shared differential drops every `run_id`; a corpus about which run owns a record must add its own stable label beside the id.

## 2026-11-01 — Stage 3 remainder slice R4 (crash guard + retry)
- **A decision read through `this.turn` after an await can belong to another turn.** The crash guard sits behind two awaits in `ensureSession`; the senior spec review showed `this.turn` could be the next turn by then. Thread the consulting turn as a parameter into every caller, and record only while it is unfinished.
- **Capture and decide from one clock read.** `crashLooping()` read its own `Date.now()`; a capture with a second read can disagree at the window's edge. Pass one `now` to both, and test it with a clock that advances per read — a frozen fake clock cannot see two reads.
- **Share the predicate instead of mirroring it.** `mayRetryOf` is called by the supervisor and by the entry's rule, so the record cannot drift from the decision; the ⇔ test over all 72 inputs is then a check, not the only guard.
- **A guard on every spawn changes every exact tally on a spawn path.** Measured, not inferred: one extra call per spawning turn in 17 corpus items and 3 unit cases. The plan reviewer ran the corpus against the old build to get the numbers.
- **Mutation testing finds call sites the scenarios never reach.** Three of five survivors were `ensureSession` callers whose threaded turn no test pinned; each needed a seam test that halts on that path.
- **Gate prints: fixed codes only, everywhere.** Two task reviews in a row found `error_ref` / `e.message` in a failure path; audit every print in a new gate and its shared helpers, not only the lines the brief names.

## 2026-11-02 — Loud degradation (tiers, reminders, trust carry with an exit)
- **Exact version strings break Houge; name a tier and probe before adopting.** Four breakages (a retired planner string, a pinned omp and voice model, a pinned Jev version, judge seat 2 five days after the lists were edited). The catalog is not the subscription, so a listed head is adopted only after a one-leg call passes, and the previous adopted head is the fallback.
- **A page that fires once per open is not enough for an actionable incident.** `role_unresolved` paged once on 2026-10-13 and said nothing for three weeks while every weekly panel ran two judges. Actionable kinds need a daily reminder; kinds that re-detect or page on their own path, and delivery-health kinds, stay out (a reminder about undelivered alerts multiplies in an outage).
- **A carried level needs an exit command, not only a better rule.** D2-A lowers new withhold-only carries, but the 19-day `hostile` transcript stays hostile until something starts a new one; `/fresh` is the exit, with a persisted marker and a commit condition tied to the request, not to whichever reset happens first.
- **Read the producer's error format before classifying it.** The spec's "classify the adapter's error" was wrong against the code; the probe's failure kind had to be parsed from what the one-shot adapter actually throws (P6).
- **An implementer's report can claim a test a failed `sed` never wrote.** Task 9 reported bridge double-raise tests that were absent. Check `git show --stat` and `grep` the test names against the report before accepting it.
- **A gate must assert the live checkout gains nothing.** The Task 13 gate wrote 13 `runs/<id>/report.md` directories into the main checkout through `CoreWorker.projectRoot`. Run gates with a scratch `projectRoot` and assert the live `runs/` count is unchanged afterwards.
- **A gate check that reads its own output proves nothing.** Task 12's line 5 failed on a same-day card that already existed, and the secret-scan line needed a minimum value length so a `"true"` cannot pass for "not found". Show a check both ways (fails when the fault is planted, passes when it is not).
- **Never force-add scratch to a public repo.** `task-10-report.md` was force-added past `.gitignore` and stayed in history; a reviewer must reject any `.superpowers` path in a diff, and the content check (no secrets, ids or message text) came only after the fact.
- **A bounded loop around an await needs the stop signal.** The tap's probe ignored the daemon's stop until a plan review caught it; thread `signal` into every probe and await settled taps at shutdown with a cap.
- **A partial catalog read must not wipe a tier.** If the catalog lists nothing of a provider, the tier stays and no probe runs (W1); otherwise one bad read empties every role on that provider.
- **Mutation testing again earned its cost.** 79 of 107 killed; 18 real gaps became tests. Equivalent mutants were named rather than ignored.

## 2026-11-03 — Stage 3 remainder slice R6 (lookup rewrite/thin + model pin)
- **Writing a row is not free inside a time budget.** A synchronous insert between a decision and the next budget read can turn a search into a timeout. In a budgeted path, decide at the branch and write at the end; then say the residual that remains (the turn deadline) instead of claiming an unconditional zero.
- **A "liveness" signal that is a promise race can still lose.** `step()` races the work against `ended`; a pin can win that race after `done()` fired in an earlier microtask. A guard on the end flag that looked defensive was load-bearing; the mutation pass found it, a queued-microtask test pins it.
- **A plan reviewer that runs the tasks finds the harness's blind spots.** Fable applying Tasks 1–3 for real measured 20 TS tallies the plan said would not move and found new rows shifting the differential's clock labels before the id filter ran. Measure before writing literals; drop new ids at the dump.
- **Check what a live gate's real-system line actually depends on.** `live-gate-jev-tree` case 9 failed on live data (the daily tier tick moved Kimi to `k3.1-pro`), not code; R6 changed no resolution file. Compare a rerun against the data's moment, not only against `main`.

## 2026-11-04 — Chat is for Paco (topic router + change log)
- **Every channel needs an audience rule, written down.** Background notices accreted in Paco's chat one slice at a time, each reasonable alone. The rule ("act, affected now, or a locked rule") is now ADR 0031 and a closed topic table; a new notification without a topic is a type error.
- **Moving a notice out of chat must not depend on chat.** The first build still gated the log write on flap damping and a configured chat id; leaving chat is what writes the log, so the route decision goes above every chat check.
- **Hiding model text is not the same as removing an action.** The skill re-check was cut to a count-only log line to keep model-written criteria out of the log; the re-review saw the line pointed at a view with no failed marker, so the retire decision had nothing to act on. A notice that asks Paco to do something stays in chat with what he needs.
- **A rewritten history must build at every commit.** The fix wave left an intermediate commit that did not typecheck; a soft reset into two commits (tree identical, checked by hash) restored bisectability before review.
- **When codex is out, say so and hold.** A Sonnet pass in codex's seat is a different reviewer, not the same check; the merge waited for the real codex whole-diff rather than relabelling the substitute.

## 2026-11-02 — Stage 3 remainder slice R5 (context decisions + clarify cap)
- **`finished` is not the end of a turn.** `done()` resolves `turn.ended` at once, but `finished` is set only after settle awaits the judge drain and the todo snapshot; a guard on `finished` lets a consult in that interval record for a dead turn. The codex re-review of the spec's own fix found it. Guard on the end signal itself, set in the same tick, and re-arm it where the end signal is replaced.
- **A planted fault inside the recorder proves nothing about the real path.** The recorder runs after the rule has answered; deciding a throwing copy there produces the expected row without exercising production. Replace the real entry's rule for the case and restore it in `finally`.
- **A gate that compares shapes passes on changed values.** The live gate's first draft compared `loop_started` keys; codex's whole-diff pass showed an extra page or a changed score would pass. Compare the prompt bytes and the payload values against the merge-base build, and seed a positive probe so lost retrieval fails.
- **A new worktree needs its own `npm ci`.** Packages resolved from the parent checkout, so the suite ran, but `node_modules/.bin/tsx` was missing and four CLI tests failed as if broken. Install in the worktree before trusting a whole-suite run.
- **Cleanup on a signal must wait for teardown already in flight.** Three rounds on the rollback check: the fixture spliced its callbacks before awaiting them, then a 5 s bound was shorter than the supervisor's own drain wait. Track in-flight teardowns, bound the wait above the slowest step, then remove the known dirs synchronously.
- **Mutation testing on input capture finds the untested side.** Five survivors were all recall's pages side (pages-only admission, the pages-side best score, max vs min); the scenarios had only exercised facts.


## 2026-11-05 — ADR consolidation (0032/0033/0034) and the Node2Shell hotfix
- **Two in-force ADR rules contradicted each other for weeks.** ADR 0029's 2026-10-10 amendment added `HOUGE_JEV_LANES_OFF`; ADR 0030 R13 (2026-10-12) said "no off switch, nothing in shadow". Each amendment was right for its slice; nothing checked an existing mechanism against a newer rule. Codex's whole-set pass over the consolidated ADRs found it. A checkable ADR rule gets a test in `tests/adr/` named after the rule id, a decision made in chat is logged "decided, not shipped" until the code ships, and the final review asks whether any rule now contradicts the code or another ADR.
- **Docs sync by append lets every slice be locally right while the front door drifts.** Each slice added its own README line; none re-read what it made false (README called Jev dormant a month after arming; `decision-map.md` listed 9 of 39 entries; the chat-is-for-Paco slice left "one Telegram line" per incident). Paco noticed first. Docs sync is a grep of every repo doc for what the slice touched, and `tests/docs/` holds the mechanical parity.
- **An ADR amended seventeen times is unreadable, but a restatement is a meaning change waiting to happen.** Each consolidated draft (Opus) came back NOT FAITHFUL from its Fable reviewer (2, 2 and 5 Important) before one fix round made it faithful; a traceability table per old bullet and a Reference map for cited locators are what made the review checkable.
- **A dependency on the runtime's bundled codecs is a dependency.** `dependencies: {}` did not protect `http_fetch` from Node's own Brotli decoder (CVE-2026-111497). Ask for identity and refuse what was not asked for, before a byte is decoded; check every header value, not the first.

## 2026-11-05 — Jev: no off switch, no shadow
- **A subagent's "full suite" can be a subset.** The final fixer reported "full npm test: 198 files" — the full suite is 475. Counts that do not match the last known full run are a subset; the controller re-runs `npm test` itself before trusting "full".
- **A parity gate that flakes is a gate nobody believes.** `memory.kind` stamped `age_s` from the wall clock while triage used the gate's clock; three replay misses looked like a branch regression until a hermetic old-vs-old control reproduced them. Before blaming the branch, run the control (old vs old) without real calls.
- **Plan wording that restates the spec can still be false.** The plan's ADR 1.6 text said "armed whenever Jev runs"; the calibration-file and marker caps contradict it. Task reviewers caught it; the ADR text is checked against the resolver, not against the plan.

## 2026-11-07 — Improve auto-apply
- **A spec's file citation is checked against the tree before the plan.** The spec cited `src/core/standing-approval.ts` for the standing-grant end; the file and the real transaction (`endStandingTx` in the run store) were looked up first, and the plan cites the real ones. A cited path that does not exist is a spec bug caught for free at plan time, expensive in Task 6.

## 2026-11-08 — Block only repeats
- **A rule removed exposes the rule behind it.** Accepted proposals blocking the pair hid `lessonRewrite`: once the block went, a different second lesson within 30 days would have reached the rewrite rule and become a card, against Paco's intent; the rewrite moved behind the repeat check (near-copies only, ruling R1'). Before planning a removal, trace what the removed gate used to keep from running.
- **A gate that counts groups counts every planted group.** Case 8's "5 groups from 4 topics" INCONCLUSIVE was case 4's correction sharing the tick, not the embedder.

## 2026-11-08 — Remainder R7 (attach.path)
- **A spec's "not protected" claim is checked against `PROTECTED_FILES`, not assumed.** The R7 spec called the Telegram adapter self-writable; it was already protected since `6ac4b0d2` (defect D1). The plan grepped the guard before touching it.
- **An ADR sentence that adds an exception is checked against its neighbours.** Appending the settle-stage rows to rule 3.2 would have left "only while the turn is live", "follow the incoming run's successful claim" and the heading "a lost turn writes no row" contradicting it; the plan review found all three, and the ADR test asserts both the qualified wording and the absence of the bare one.

## 2026-11-09 — SP2 mail triage
- **One implementer at a time on a shared worktree.** Pipelining two implementers let one's full test run fail on the other's half-written code and land its fix (six config rows) in the wrong commit. Reviewers may run beside an implementer; implementers (fix rounds included) never beside each other.
- **A gate that drives a scheduler must follow the scheduler's own clock rule.** The final fix wave changed the poll cadence to count from the later of two stamps; the gate rewound only one, and its later ticks silently skipped. When a fix changes a predicate, grep the gate/harness scripts for every place that fakes its inputs.
- **Live-gate instructions name the sender, not just the subject.** Two of three gate runs were spent on mails from the wrong account (Houge's own address hits the `own_output` floor) or with the wrong digits; the gate prompt should print the exact subjects and "send from an address that is not Houge's".

