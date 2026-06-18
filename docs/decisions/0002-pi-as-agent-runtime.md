# ADR 0002: Pi as agent runtime — inference vs agentic modes

- **Status:** accepted
- **Date:** 2026-06-16
- **Deciders:** Paco

## Context

`/ask` needs an LLM. Paco's environment has both CLIs (pi, agy, codex) and APIs
(kimi, gemini). pi is an open, extensible agent (built-in tools, skills, extensions,
`pi install`) and is intended as the eventual core agent runtime. But [ADR 0001](0001-deterministic-harness-governs-everything.md)
denies any `coding_agent_cli` delegation until V2 deterministic containment exists.
Spawning pi naively (full tools, inherited env, project cwd) would be exactly that —
and would also leak secrets and be injectable via the untrusted question.

## Decision

**Pi serves Houge in two distinct modes, and the boundary between them is a safety
boundary — not an implementation detail.**

- **Inference mode (V1, shipped):** pi invoked single-shot with **tools disabled**
  (`--no-tools`), no session, no context files, the prompt delivered on **stdin**
  (never argv — so a flag-looking question can't be parsed as a flag), under an env
  **allowlist** (`PATH, HOME, TERM, LANG, USER` + opt-in passthrough), in a neutral
  temp cwd, with an authoritative timeout + SIGKILL and an output cap. This is a pure
  prompt-to-text call, classified **`external_read`** and run **ungated**. `/ask`
  uses this via the LLM provider chain (default `pi,kimi-api`).
- **Agentic mode (V2):** pi invoked with a Houge-approved subset of tools enabled.
  This is the `coding_agent_cli` category and stays **denied** until V2 containment
  (cwd jail, env/fs allowlist, command-prefix audit, timeout, output cap, secret
  deny-by-default).

**Governing principle: Houge governs pi's extension surface; it does not replace it.**
pi's own flags (`--no-tools`, `--tools <allowlist>`, `--extension`) are the control
surface Houge drives; the underlying model/agent is swappable behind the capability
seam, and the harness's control/audit/budget/approval guarantees are identical
regardless of which agent is underneath.

## Consequences

- **Easier:** a real LLM today without violating ADR 0001; a clean upgrade path to
  agentic mode (flip tools on *inside* V2 containment) without re-architecting.
- **Accepted cost / risk:** classifying a tools-disabled CLI as `external_read` is a
  deliberate, documented reclassification (the "policy amendment"), justified only by
  the hardening above — the false-positive-*available* path is forbidden (only real
  extracted answer text returns success).
- **Constrains:** any future "let pi do things" work must go through the V2
  containment list first; it cannot be reached by loosening this provider.

## Alternatives considered

- **Anthropic API provider:** built first, then **removed entirely** — kept Claude's
  credit to commit trailers, not a silent runtime dependency.
- **Ship 6 providers at once (agy, codex, gemini, …):** rejected — prove the registry
  seam with one CLI + one API (pi + kimi); the rest are trivial follow-ons.
- **Pass the question as an argv token:** rejected — injectable; stdin delivery is
  structurally injection-proof.
