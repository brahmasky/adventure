# Sessions

## 2026-06-19 — Learning v1 (prompt composer + /teach + STORM self-critique)

Built the learning loop's runtime spine (per the learning-mechanism v1 spec; ADRs 0007/0009,
0006 amendment). Branch `feat/learning-v1`.

- **Prompt composer** (`src/prompt/composer.ts`): single place assembling every system prompt =
  Core Identity (`memory/core/houge.md`, loaded not duplicated) + per-surface discipline +
  learned lessons (`memory/skills/<scope>.md`) + guardrails. `/ask` and `/research` both source
  from it; the old hardcoded persona constants are gone (`llm-answer.ts`, `web-search.ts`).
- **Lesson store** (`src/memory/lesson-store.ts`): inspectable per-scope markdown; append/read.
- **`/teach <scope>: <lesson>`**: parser variant → `teach` event → `Gateway.handleTeach`
  (control command, no run/budget, idempotent) appends + acks `Learned ✓`. High-trust:
  activates immediately; next matching run applies it.
- **STORM self-critique**: web-research synthesis now followed by a `research-critique` pass
  (grade figures/weakest-claims/source-bias → corrected answer; best-effort).
- gitignore: `memory/{skills,user,wiki,journal}/` runtime; `memory/core` committed.
- Docs: README "Learning" section + configuration.md composer/teach/critique.

Gate: typecheck clean · test 272/272 · build OK · zero runtime deps. LIVE
(`scripts/live-learning-v1.mjs`, real Gateway + CoreWorker + pi/kimi + Tavily): a
`/teach`-taught `🐒 Houge-confidence:` trailer was absent pre-teach and present post-teach
in real `/research` output. Telegram transport leg was event-equivalent (harness can't type
into Telegram); every other leg live.
