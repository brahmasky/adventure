# Direction review — 2026-11-12

A review of Houge's goal, design and architecture against six months of its own data and the 2026 field of
personal agents. It is the evidence behind the priority queue at the top of [`tasks/todo.md`](../../tasks/todo.md)
and the 2026-11-12 delta in [`ROADMAP.md`](../ROADMAP.md). The queue is the plan; this file is why.

**Limits.** One model wrote it (the orchestrator seat, Claude Code) and no second model reviewed it. Architecture
was judged from structure, docs and the live database, not from a source audit. Web claims marked [S] come from
secondary sources. OpenAI's and Google's consumer agents of late 2026 were not researched.

Tags: **[M]** measured 2026-11-12, read-only, on the live `houge.sqlite`, git and the tree · **[P]** primary
source · **[S]** secondary source · **[I]** inference.

## 1. Finding

Houge's floors are stricter by design than those of the open-source personal agents compared here. Houge as a
product is lightly used, and Houge has not changed himself since 2026-10-08. Most build effort since October went
into governance of a system that handles about ten messages a week. The repo found the same thing twice
(2026-09-30: use had collapsed; 2026-11-10: the orchestrator evolves Houge, Houge does not) and both times the
answer was more machinery.

## 2. Charter against data [M]

| Charter | Data |
|---|---|
| Self-evolving | 19 `houge self-write` commits: 2 in June, 15 in July, 2 in October, none after 2026-10-08. `improvement_proposals` 0 rows, `improvement_jobs` 0 rows, 12 session ratings. 4 grow items: 1 exemplar, 3 migrated. |
| Nets, not approval | 35 ADRs, 50 specs, 49 plans, 33 live gates, 185 documented env vars, 97 tables; every self-write merge is tapped. |
| Not a chatbot | Telegram turns per week from the omp cutover: 76 (47 on the gate day), 27, 19, 7, 9, 9. Commands: 94, 49, 29, 16, 15, 15. Standing use: a daily brief, a weekly brief, the idea shortlist, mail triage since 2026-11-09. |

Since 2026-10-01: 1,589 commits (514 `docs`, 446 `fix`, 280 `feat`, 259 `test`) against about 138 Telegram turns.

The 2026-09-30 diagnosis named the runtime as the bottleneck. The omp runtime replaced it and use returned to the
earlier level. The constraint is demand: Houge has few jobs a phone chat app cannot do. [I]

**Open question for Paco:** is Houge a product for his day, or a harness-engineering lab whose output is the
build process? Either is a fair goal. It is run with product-grade ceremony and measured as neither.

## 3. Design and architecture

**Assets to keep.** Floor A (Seatbelt plus the policy hook) and floor B (`/approve`); the quarantined reader;
verify-before-live in the grow zone with a reviewer of another family (ADR 0035); chat carries only what needs
Paco (ADR 0031); loud degradation and the incident sweep; the ledger, outbox, leases and hermetic tests.

**Overbuilt for the volume.** [M] `src/decisions` and `src/jev` are about 8.5k lines. Their output to date: 1,171
decision rows (12 at the model rung) and 12 lane replies. Seven remainder slices (R1–R7) each shipped rows that
record and never steer, each with a spec, a differential gate and a rollback check. Jev earns its place on mail
triage (112 items in two days), not on chat routing at this volume.

**Open holes the repo already lists.** The planner can read its own OAuth store (ADR 0032 D11, accepted until
SP3). Outside text can reach a clean turn through memory (ADR 0035 residual R1). Headless agy auto-allows
`search_web`. SP3 hardening has waited since September while the record-only slices shipped.

**Structure.** [M] `src/run/run-store.ts` is 11,250 lines and `src/core/core-worker.ts` 4,468: a quarter of
`src/` in two files. Split by table family when a slice touches them, not as a project. Remove tables and flags
that nothing arms.

## 4. Provider exposure

Non-Jev model calls since 2026-10-15 [M]: `google-antigravity` 280 (272 of them the reader), `anthropic` 183
(167 compose), Kimi 97, Codex 5, `agy-cli` 3. So 463 of 568 calls ride on two OAuth legs inside omp.

- Anthropic's page says OAuth is "intended exclusively" for subscribers' "ordinary use of Claude Code and other
  native Anthropic applications", enforced "without prior notice". [P] ADR 0032 D7 records this terms risk as
  accepted.
- The omp issue thread quotes Antigravity's terms: third-party use of its OAuth is a breach that "may lead to
  suspension or termination". One user there reported a suspension on 2026-11-06. [S, one report] This postdates
  the ADR.
- The planner's leg after Anthropic is `opus@antigravity`, then Kimi (`src/omp/model-roles.ts`). The `vision`
  role has only the Antigravity leg. Kimi leaves next year. [M]

A block is handled (ADR 0032 7.9). A suspension is not: it reaches beyond Houge (Paco, 2026-11-12). This is the
one finding that can end Houge overnight, so it is first in the queue.

Options, none probed yet:
1. Move the Gemini legs to `agy-cli`, the official headless client that already carries voice. Cost: SP1 moved
   seats off agy on purpose, and agy's `search_web` egress would sit on the reader leg.
2. Re-open the rejection of `claude -p` (ADR 0032 D7, "Rejected" column). Anthropic's page permits signing in to
   the unmodified Claude Code binary with one's own subscription; it does not speak to an always-on daemon. [P]
3. Keep the legs and sign the risk, with a tested chain that uses neither.

A chain that uses neither falls onto Kimi Code and OpenAI Codex, also subscription OAuth inside omp. Their terms
were not read for this review; the probe reads all four.

## 5. The field, three facts

1. **OpenClaw** (about 390k stars, foundation-run, 2.0 in August 2026) proved the demand for a messaging-first
   personal agent, and the cost of no floors: hundreds of malicious marketplace skills carrying infostealers, and
   a one-click remote code execution flaw (CVE-2026-25253). [S]
2. **Hermes Agent** (Nous Research, February 2026) is the closest comparable. Its self-improvement is skills
   written after tasks of five or more tool calls, plus memory; no code rewriting. [S] It has a producer. The
   grow zone has a door and little to feed it: in the last 30 days 4 Telegram turns used five or more tools (33
   scheduled runs did, and rule G7 bars them from submitting). [M]
3. **The gateway and cron are commodity.** Claude Code Channels and Routines give a first-party Telegram agent
   with schedules. [S] Google ships remote Workspace MCP servers for Gmail, Drive and Calendar in developer
   preview. [S] SKILL.md is a cross-vendor format; the seed skill in `grow-seed/` already has that shape. [M]

What stays Houge's own: the floors, the reader wall, verified growth, incident discipline, and Paco's state
(memory, mail rules). [I]

## 6. What the watcher showed [M]

One scheduled availability check ran daily from 2026-10-05 to 2026-10-26. It took 31 of the 58 approvals ever
requested; 28 were `shell_external` "HTTP write". Standing approval (Stage 4A) shipped on 2026-10-28, two days
after the schedule was disabled. `standing_approvals` has 0 rows. The feature built for this job has never run. The schedule was
disabled because the need ended, not because of a fault (Paco, 2026-11-12).

## 7. A recommendation withdrawn

The first draft proposed the post-turn nudge (grow slice 3) ahead of delegation (1b). The probe in §5.2 shows a
nudge would have had four turns to work with in a month. Order within the grow sequence is not the problem; input
is. Paco's decision of 2026-11-12 puts use ahead of both.

## 8. Decisions taken on this review (Paco, 2026-11-12)

Paco decided these four. The rest of the queue in `tasks/todo.md` (its other items, dates and done criteria) is
the orchestrator's draft.

1. **Use first.** After the provider item: the SP2 Workspace MCP slice through to actions, and a watcher under
   standing approval. Grow 1b waits. This changes "delegation first" of 2026-11-10.
2. **The Mandate spec is held** until 1b starts.
3. **Governance freeze for 30 days**, to 2026-12-12: no new ladder entries, no record-only slices, a lighter flow
   outside the protected surface. Floor work is exempt.
4. **Provider exposure is urgent**: probe, then Paco picks an option, before any other build.

## Sources

- Anthropic, Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- oh-my-pi issue 12487: https://github.com/can1357/oh-my-pi/issues/12487
- The Register, 2026-02-20: https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546
- Snyk, ToxicSkills: https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/
- MIT AI Risk incident 1368: https://airisk.mit.edu/ai-incidents/1368-malicious-openclaw-skills-reportedly-delivered-amos
- OpenClaw: https://en.wikipedia.org/wiki/OpenClaw
- Hermes Agent: https://github.com/nousresearch/hermes-agent
- Hermes architecture audit: https://saulius.io/blog/hermes-agent-self-improving-ai-architecture
- Claude Code Channels guide: https://claudefa.st/blog/guide/development/claude-code-channels
- Google Workspace developer update, May 2026: https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html
- SKILL.md adoption: https://www.noqta.tn/en/news/skill-md-open-standard-30-ai-coding-tools-adoption-2026
- dsh-superagent: https://github.com/deepseek-ai/dsh-superagent-prototype/
