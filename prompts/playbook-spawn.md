# Playbook: Spawn Strategy

## Trigger

Use this playbook whenever you decide whether to do work inline, spawn a
default-provider subagent, or delegate to a coding-agent provider such as `cc`
or `codex`.

## Default

Do the work inline unless a spawn gives clear value. Inline work is cheaper,
keeps state local, and avoids a `subtask_complete` round trip.

## Spawn A Default-Provider Child When

- **Context isolation**: the subtask will produce noisy reads, broad searches,
  or comparison output that should be summarized before returning to the parent.
- **Independent parallelism**: two or more subtasks can run without sharing
  intermediate state.
- **Adversarial review**: you want an independent critique of an artifact,
  implementation, or plan.
- **Verification**: the remaining question is whether finished work satisfies
  the request.

Pass a role when a role prompt fits the task. Pass context references instead
of restating long parent history.

## Delegate To A Coding-Agent Provider When

- The task involves editing files, running commands, and iterating.
- The work is contained in a specific `cwd`.
- The child can own a bounded implementation or review loop and report a final
  summary.

For `provider: 'cc'` or `provider: 'codex'`, include `cwd`. Give the child an
outcome-level task, any role, relevant context refs, and the acceptance checks.
The child runs its own CLI tools; its internal tool calls are not visible in the
parent thread.

## Permission Mode

Coding-agent CLIs have their own prompt and sandbox systems. In a headless
harness spawn, nobody can approve interactive write prompts.

Use `permissionMode: 'bypass'` only when both are true:

1. You created the `cwd` yourself, such as a sibling git worktree.
2. The operator authorized the work in that `cwd`.

Otherwise leave `permissionMode` unset and let the provider fail loudly rather
than silently widening filesystem access.

## Do Not Spawn For

- A tiny lookup that can be answered by one read or shell search.
- A critical-path question when you cannot do meaningful parent work while the
  child runs.
- A task that must mutate state the parent is actively editing.
- Delegating responsibility without a bounded task, owner, and stopping
  condition.

## Continuation

Carry `providerSessionId` only when the next coding-agent spawn continues the
same feature, same diff, or same review iteration. Omit it for independent work.
Use `continueThreadId` when you want a follow-up to append to the same harness
child thread.

## Budgets

Budgets are hard caps. Choose caps that match the task:

- Tiny lookup or verifier: `maxTurns: 1-2`, `maxToolCalls: 5`, `maxWallMs:
  30000`.
- Designer proposal: `maxTurns: 8`, `maxWallMs: 300000`.
- Implementer or coding-agent edit loop: `maxWallMs: 1800000-3600000`, with a
  token cap sized to the expected diff and tests.

If the right budget is unclear, start conservative and use `usage` or the child
summary to recalibrate.
