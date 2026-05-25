# Project Guidelines

## Code Style
- Follow existing project conventions
- Use meaningful variable names
- Keep functions under 50 lines
- Add comments for complex logic only

## Git
- Conventional Commits: feat/fix/refactor/docs/test/chore
- Atomic commits, one concern per commit
- Never force push to main

## Safety
- Never hardcode secrets or API keys
- Always validate user input
- Handle errors explicitly, no silent failures

## Workflow
- Read before write — understand context first
- Minimal changes — don't refactor unrelated code
- Verify after changes — run tests or check output

---

## Karpathy-Inspired Guardrails (12 Rules)

Behavioral guidelines to reduce common LLM coding mistakes. These bias toward caution over speed — for trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: *"Would a senior engineer say this is overcomplicated?"* If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that **your** changes made unused.
- Don't remove pre-existing dead code unless asked.

**The test:** Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### 5. Use the Model Only for Judgment Calls

Use the LLM for: classification, drafting, summarization, extraction from unstructured text.

Do **not** use the LLM for: routing, retries, status-code handling, deterministic transforms.

If a status code already answers the question, plain code answers the question.

### 6. Token Budgets Are Not Advisory

Per-task budget: 4,000 tokens.  
Per-session budget: 30,000 tokens.

If a task is approaching budget, summarize and start fresh. Do not push through.

Surfacing the breach > silently overrunning.

### 7. Surface Conflicts, Don't Average Them

If two existing patterns in the codebase contradict, don't blend them.

Pick one (the more recent / more tested), explain why, and flag the other for cleanup.

"Average" code that satisfies both rules is the worst code.

### 8. Read Before You Write

Before adding code in a file, read the file's exports, the immediate caller, and any obvious shared utilities.

If you don't understand why existing code is structured the way it is, ask before adding to it.

"Looks orthogonal to me" is the most dangerous phrase in this codebase.

### 9. Tests Verify Intent, Not Just Behavior

Every test must encode **why** the behavior matters, not just **what** it does.

A test like `expect(getUserName()).toBe('John')` is worthless if the function takes a hardcoded ID.

If you can't write a test that would fail when business logic changes, the function is wrong.

### 10. Checkpoint After Every Significant Step

After completing each step in a multi-step task: summarize what was done, what's verified, what's left.

Don't continue from a state you can't describe back to me.

If you lose track, stop and restate.

### 11. Match the Codebase's Conventions, Even If You Disagree

If the codebase uses `snake_case` and you'd prefer `camelCase`: `snake_case`.

If the codebase uses class-based components and you'd prefer hooks: class-based.

Disagreement is a separate conversation. Inside the codebase, conformance > taste.

If you genuinely think the convention is harmful, surface it. Don't fork it silently.

### 12. Fail Loud

If you can't be sure something worked, say so explicitly.

"Migration completed" is wrong if 30 records were skipped silently.

"Tests pass" is wrong if you skipped any.

"Feature works" is wrong if you didn't verify the edge case asked about.

Default to surfacing uncertainty, not hiding it.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, clarifying questions come before implementation rather than after mistakes, and uncertainty is surfaced instead of hidden.
