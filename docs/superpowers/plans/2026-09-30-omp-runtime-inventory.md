# omp runtime: test deletion inventory (Task 0)

Rule: Task 14 may `git rm` a test only if its row says `retired with feature`. Every file matched by the Task 0 `ls` and `grep -rlE` commands appears once (33 files). Paths are under `tests/`.

Fate values:
- `retired with feature`: the behaviour is deleted with the code it tested.
- `replaced by <file>`: the behaviour survives and a new test covers it. Test names inside the successor file are fixed when that task writes it; the successor file and its `describe` title come from the plan.
- `kept (<reason>)`: the file stays. If the reason starts with `edit in T14` the file needs a named edit, not a deletion.

Frame facts captured from omp 18.4.4 (fixtures in `tests/fixtures/omp-frames/`) that the replacements must honour:
- `json-error-bad-model`: omp exits 1 with EMPTY stdout and a two-line message on stderr. The script stores it as one `{"type":"stderr","text":...}` line, so T1's `summarizeAssistantMessage` and T2 must treat a lone `stderr` frame as a failed leg.
- `rpc-open-session`: `open_session` fails with `open_session requires session persistence (omit --no-session)` if the child was started with `--no-session`. T10's spawn args must omit it.
- `rpc-prompt`: `response` (`prompt`, success) arrives before the turn's events, then `prompt_result`, `agent_end`, `session_settled`.

## Table

| test file | behaviour it protected | fate |
|---|---|---|
| core/inner-loop.test.ts | tolerant JSON action parser, echo defence, step/denial/parse caps of the planner loop | retired with feature |
| core/inner-loop-budget-tail.test.ts | B7 tail rendering and mechanical tail enforcement of the step budget | retired with feature |
| core/inner-loop-relative-day-guard.test.ts | convert-before-final guard: a relative-day final bounces until `to_local_time` ran | retired with feature |
| core/tool-manifest.test.ts | contract-derived manifest, evolution-tool arming flags, P2 bounty tools arming | replaced by omp/tool-decls.test.ts and omp/capability-map.test.ts (arming, contract as envelope) |
| core/planner-timezone-discipline.test.ts | timezone rules in `LOOP_DISCIPLINE`/`READER_DISCIPLINE` constants and in the `to_local_time` manifest line | replaced by omp/turn-context.test.ts (loop discipline rewrite, T11); the manifest-line case moves to omp/tool-decls.test.ts (edit in T14: drop the `inner-loop`/`tool-manifest` imports) |
| core/quarantine.test.ts | dual-LLM flag/provider resolvers, `UNTRUSTED_READ_TOOLS`, reader-extraction parse and digest wall; one case drives `runInnerLoop` | replaced by omp/external-read.test.ts for the `runInnerLoop` wall case; the resolver/parse/digest cases are kept (edit in T14: remove the `inner-loop` and `ToolManifestEntry` imports) |
| core/core-worker-turn-loop.test.ts | `executeTurn` loop: answer, web_search, http_fetch, to_local_time, dual-LLM, lesson_write, episodic retrieval and attribution, schedule_task, skill_author gate stack, refine feed, skill retire/restore | replaced by core-worker-omp-turn.test.ts and omp/planner-supervisor.test.ts (turn path); episodic attribution by omp/turn-context.test.ts. Gate-stack cases (schedule_task, skill_author, refine/retire) have no named successor in the plan: see Concerns |
| core/core-worker-external-work.test.ts | `external_work` pipeline: clone, codex, container gate, patch card, SSRF | retired with feature (external_work / money track deleted) |
| core/core-worker-jev-shadow.test.ts | live Jev intent shadow inside `classifyIntent` (rows, concurrency, never blocks the turn, flag read live) | retired with feature (classifier call and Jev live shadow deleted) |
| core/project-tools.test.ts | `project_track` anchor, `project_update`, `project_list` tool execution | retired with feature (imports `bounty-intake`; bounty money track deleted) |
| capabilities/llm-answer.test.ts | `llm_answer` adapter: system prompt precedence, chain failure mapping, audit sink, media forwarding | replaced by llm/providers/omp.test.ts (one-shot seat: prompt/system fold, media file, audit per leg) |
| capabilities/bounty-intake.test.ts | bounty scan: env resolvers, venue allowlist, hygiene, candidate normalisation, fork-fake reject | retired with feature |
| capabilities/anchor-verify.test.ts | independent skill/anchor verifier: strict JSON, passes only when+body, scores good vs bad | kept (live Gate B: `skill_author` via `verifySkill`, the weekly skill re-verify tick, and the Task 13 omp-tools port all use `src/capabilities/anchor-verify.ts`; the earlier "retired with feature" was a mix-up with the bounty `project_track` anchor. Corrected in Task 14 fix round 1) |
| capabilities/external-workspace.test.ts | `resolveExtWorkEnabled`, manifest arming, clone URL SSRF floor, private-IP refusal | retired with feature |
| capabilities/intent.test.ts | `parseIntent`, `INTENT_DISCIPLINE`, `buildIntentQuestion`/system prompt, clarify-loop cap, chat-context caps, self-write flag | kept (intent.ts survives). Types, `parseIntent`, `countTrailingClarifyTurns` and the context resolvers stay live; only the `INTENT_DISCIPLINE`/`buildIntent*` cases test the removed classifier call path and may be trimmed in T14 by hand, not deleted as a file |
| capabilities/time-convert-evidence.test.ts | zone_evidence gate on `to_local_time`; `runInnerLoop` evidence wiring | first two describes kept (adapter survives); third describe (`runInnerLoop to_local_time evidence wiring`) retired with feature. Edit in T14: drop the `inner-loop`/`tool-manifest` imports |
| capabilities/idea-panel-seats.test.ts | contained chair/judge seat spawns, argv and env allowlist, seat audit | kept, edit in T14: import `buildChildEnv`/`SpawnImpl` from `omp/child-env`; chair cases replaced by llm/seat-routing.test.ts once the chair moves to the omp seat |
| capabilities/panel-judge-providers.test.ts | judge seats pinned to flat-rate CLI legs; no metered provider outside the LLM layer | replaced by llm/seat-routing.test.ts (judges by index from `cfg.judges`); edit in T14: drop the `llm-answer.ts` path filter |
| capabilities/gmail-read.test.ts | gmail caps, verification extraction, body decode | kept (only a comment mentions "bounty fakeDeps pattern") |
| capabilities/google-api.test.ts | Google API gate, allowlist, registry | kept (only a comment mentions tool-manifest) |
| capabilities/http-fetch.test.ts | http_fetch adapter, SSRF refusal, HTML strip | kept (only a comment mentions inner-loop) |
| llm/providers/pi.test.ts | pi JSONL parsing, usage normalisation, last `message_end` wins | replaced by omp/omp-frames.test.ts (frame parser from real fixtures) and llm/providers/omp.test.ts |
| llm/providers/agy-cli.test.ts | agy argv shape, env override, injection-safe prompt, secret-free env | replaced by llm/providers/omp.test.ts (argv shape, stdin prompt, child env) |
| llm/providers/kimi.test.ts | Kimi API request shape, usage, missing-key unavailable | retired with feature (metered API leg deleted; kimi now via omp `kimi-code` subscription, covered by omp/omp-config.test.ts) |
| llm/providers/gemini.test.ts | Gemini OpenAI-compat request shape, thinking-token accounting | retired with feature (metered API leg deleted) |
| llm/providers/cli-spawn.test.ts | `defaultSpawnImpl` clean exit, ENOENT, timeout kill; `buildChildEnv` | replaced by llm/providers/omp.test.ts for spawn behaviour, with `buildChildEnv` moving to omp/child-env (T2). Not deletable in T14 unless `toolchain-gate.ts` and `coding-agent.ts` no longer import `cli-spawn`: see Concerns |
| llm/registry.test.ts | default `pi,agy-cli` chain, metered escape hatch, ceiling latch, chain budget, `answerWithChain` fall-through, audit rows, media eligibility | replaced by llm/seat-routing.test.ts (`seatChain`) and llm/providers/omp.test.ts (chain fallback, audit per leg, media); the `answerWithChain` audit/media cases must be ported before `registry.ts` is rewritten |
| llm/audit-coverage.test.ts | structural scan: every seat/adapter construction passes a store-built sink | kept, edit in T14: remove `llm-answer.ts` exclusions and add `src/llm/providers/omp.ts` and `src/omp/planner-supervisor.ts` to the scan (the plan already says so) |
| config/secret-firewall-wiring.test.ts | broker key reaches `kimi`/`gemini`/tavily/firecrawl `Authorization` header; no env fallback | kimi/gemini cases retired with feature (providers deleted); tavily/firecrawl cases kept. Edit in T14: drop the `openai-compat` import and the `buildLlmChain` cases |
| config/disarm-posture.test.ts | disarm flag set, posture file lifecycle, posture outranks `.env` | kept, edit in T14: remove `HOUGE_JEV_SHADOW_ENABLED`, `HOUGE_BOUNTY_ENABLED`, `HOUGE_EXTWORK_ENABLED` from the expected set (the plan lists this) |
| contracts/task-contract.test.ts | compile contracts per program; turn envelope allowed_actions incl. `bounty_scan` | replaced by contracts/turn-contract-omp.test.ts for the turn cases (T13 amends the envelope); other programs kept, edit in T13: remove `bounty_scan` from expectations |
| run/container-runner.test.ts | container argv hardening, runtime detection, `runInContainer`, ext-work image | retired with feature (`container-runner.ts` deleted with `external_work`) |
| run/toolchain-gate.test.ts | ecosystem stage-plan detection and container-run gate for external repos | deleted in Task 14 as an orphan: `src/run/toolchain-gate.ts` had one consumer (`external-workspace.ts`, deleted with `external_work`) and imports `container-runner.ts` (deleted). Not in the Task 0 scan because it never imported a listed module by name |
| run/projects-store.test.ts | projects table state machine, bounty sightings scan memory, ledger events | kept (store is not on the delete list; the word "bounty" is data here). Flag: the sightings and `bounty_scan_completed` cases have no live writer after T14; retire them only by a later decision |
| run/b10-verifier-probes.test.ts | scheduler self-replication, breaker, DST probes | kept, edit in T14: `CONVERTED_ROW` import from `inner-loop` must move or the constant be inlined in the test |

## Concerns for the reviewer

1. `core-worker-turn-loop.test.ts` (about 2300 lines) carries the only gate-stack coverage for `schedule_task`, `skill_author`, refine feed and skill retire/restore on the loop. The plan's successors (`tool-decls`, `capability-map`, `core-worker-omp-turn`, `planner-supervisor`) do not name equivalent cases. T13 should list these behaviours explicitly before T14 deletes the file.
2. `src/run/toolchain-gate.ts` and `src/capabilities/coding-agent.ts` import from `llm/providers/cli-spawn`. T2 repoints `coding-agent.ts`; `toolchain-gate.ts` (type `SpawnImpl`) is not in the plan's file lists and would dangle when `cli-spawn.ts` is deleted.
3. `idea-panel-seats.test.ts` and `b10-verifier-probes.test.ts` are not deleted but break on the T14 deletions and need import edits (rows above).
4. Task 14 changed the `milestone-2-ask-path` eval golden (`program: "turn"` → `"ask"`): a Telegram text message is a planner turn after the cutover and cannot run deterministically in the eval, so the case now enters through the typed `ask` event. This LOST the eval's coverage of the Gateway text path (Telegram update → normalize → `turn` run → reply). Follow-up: a fake-omp turn eval that drives a text update through `submitTurn` against `tests/fixtures/fake-omp.mjs` (or an eval-local fake PlannerSession) and restores that path's golden.
