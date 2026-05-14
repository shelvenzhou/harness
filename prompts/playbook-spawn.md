# Playbook: when to spawn

A reference for choosing between doing the work inline, spawning a
subagent on the default provider, and delegating to a coding-agent
provider. The `spawn` tool description carries the capability
contract; this playbook adds the decision rules around it.

## Default: do it inline

Reach for `spawn` only when one of the reasons below applies.
Inline is cheaper (no thread setup, no context split, no
subtask_complete round-trip) and almost always clearer.

## Reasons to spawn (default provider)

- **Context isolation.** The subtask would pollute your prompt with
  output you do not want to keep paying attention to (large file
  reads, exhaustive searches, comparing many candidates). Spawn it,
  let the child summarise.
- **Independent parallelism.** Two or more steps can run at the
  same time without sharing intermediate state ("compare libraries
  A and B"). Spawn each as a child.
- **Adversarial review.** You want a second opinion on something
  you produced, without it being biased by your reasoning. Spawn a
  `role: 'reviewer'` child with `contextRefs` pointing at the
  artefact's thread slice — not at your own deliberation.
- **Verification.** "Did the implementation actually satisfy the
  spec?" runs cleaner as a separate child whose entire job is the
  check.
- **Quality review after implementation.** When code has already
  landed and the remaining question is "is this implementation good
  and scoped?", spawn a `role: 'reviewer'` child or review inline.
  For complex/shared/runtime/security/provider changes, prefer the
  independent reviewer so its verdict is not anchored on the
  implementer's explanation.

## Reasons to delegate to a coding agent (`provider: 'cc'` / `'codex'`)

- The work involves editing source files, running commands, and
  iterating in a tight loop. cc / codex own that loop internally
  and surface only the final result. You do not need to micromanage
  individual `read` / `write` / test runs.
- The work is contained inside a single working directory you can
  point `cwd` at.

When you delegate to a coding agent, also pass `role` (designer /
implementer / reviewer) when one of those role files applies — the
runtime appends the role's system-prompt suffix.

### `permissionMode` for coding-agent spawns

Coding-agent CLIs (cc, codex) ship with their own permission system:
they prompt before every file `Write` and sandbox shell-based writes.
In a headless harness spawn there is no one to answer the prompts, so
those writes hang or get rejected — the child looks like it ran and
returned a clean reply, but no files were created and no commits were
made.

`permissionMode: 'bypass'` on the spawn tells the CLI to skip its
prompt + sandbox layer. Use it when **both** hold:

1. You created the `cwd` yourself (a sibling git worktree, a fresh
   directory you `mkdir`'d, …).
2. The operator's request authorizes the work being done in that cwd
   (self-update, an explicit "go edit this directory" task).

When either condition is unclear (cwd is something the user mentioned
in passing, you're not sure who owns it), leave `permissionMode`
unset and let the CLI's prompts fail loudly rather than silently
escalating its filesystem reach.

## When NOT to spawn

- **Critical-path subtasks.** If you cannot proceed without the
  child's answer and the child is doing one straightforward thing,
  inline is cheaper than the spawn round-trip.
- **Tiny lookups.** "What does function X return?" → `read` /
  `shell grep`, not a spawn.
- **State-sharing demands.** Spawned children get their own thread.
  If the subtask needs to mutate state you are mid-way through
  building, do it inline.

## Carrying `providerSessionId`

When the next coding-agent spawn is a continuation of the previous
one — same feature, same diff, same train of thought — carry the
`providerSessionId` from the prior `subtask_complete`. cc resumes
its internal session via `--resume`, saving the full context
re-read. When the next spawn is independent, omit it for a clean
slate.

## Budgets

A budget on `spawn` is a hard cap, not a soft hint. Pick values
that match the task scope:

- Tiny verifier / lookup → `maxTurns: 1-2`, `maxToolCalls: 5`,
  `maxWallMs: 30s`.
- Designer producing a written proposal → `maxTurns: 8`,
  `maxWallMs: 5min`. Coding agents may need more wall clock.
- Implementer doing edits + tests → `maxWallMs: 30-60min`,
  `maxTokens: 200_000`. Trust the agent's own internal loop;
  the cap is the safety net.

If you have no idea what to set, set conservative caps and watch
`usage` in subsequent turns to recalibrate.
