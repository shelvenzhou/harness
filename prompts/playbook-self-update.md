# Playbook: self-update

Applies when the operator asks you to modify, extend, or fix this
harness's own source code, documentation, or configuration. This is
the path that makes the running harness produce a PR against its own
repository.

## Hard safety constraints

These are not negotiable. If you cannot satisfy one, stop and ask
the operator.

- **Never edit the live serving checkout.** All edits happen in a
  sibling git worktree. Create one with
  `shell git worktree add ../wt-<short-feature-name> -b feat/<branch-name>`
  before any coding-agent spawn. Pass that path as `cwd` on every
  spawn. Remove the worktree after the PR is open.
- **Never push to `main` / `master`.** Push only to the feature
  branch the worktree is on.
- **Never `git commit --no-verify`, `git push --force`, or
  `--no-gpg-sign`.** If a pre-commit hook fails, fix the underlying
  issue and recommit.
- **Never edit `prompts/` or `src/` from outside the worktree.** If
  you find yourself wanting to "just tweak one line" in the live
  checkout, route it through the worktree instead.
- **Never commit credentials or `.env*` files.** Stage by name.

## Default choreography

The mechanism is composition; the order is yours to vary based on
task shape. The template:

1. Plan in-prompt: identify what changes (which files / which
   subsystem), what tests need to pass, what docs need to track.
   Stash the plan in `memory({ op: 'set', key: 'plan:<task>' })`
   if the task spans more than a few exchanges.
2. Set up the worktree (constraint above).
3. **Design** when the subsystem is unfamiliar or the operator's
   request is open-ended. `spawn({ provider: 'cc', role: 'designer',
   cwd: <worktree>, task: ... })`. The designer's job is a
   proposal, not edits. Stash the result under
   `memory({ op: 'set', key: 'design:<task>' })`.
4. **Implement.** `spawn({ provider: 'cc', role: 'implementer',
   cwd: <worktree>, task: ..., contextRefs: [<designer thread>] })`
   when a designer step exists; otherwise just the implementer.
   The implementer writes code, runs tests, and commits inside its
   own cwd.
5. **Review.** Either inline (`shell git diff main...HEAD` +
   targeted `read`) or as a separate `spawn({ role: 'reviewer' })`.
   The reviewer applies the acceptance checklist below.
6. **Iterate** if review fails. Re-spawn the implementer with
   `providerSessionId` carried over from the previous spawn so cc
   resumes its internal context instead of re-reading everything.
7. **Open the PR.** `shell git push -u origin <branch>` then
   `shell gh pr create --title ... --body ...`. PR body must
   include the acceptance checklist results (which items passed,
   which were waived, why).
8. **Clean up the worktree.** `shell git worktree remove ../wt-<...>`.
9. **Reply to the operator** with the PR URL plus a one-sentence
   summary of what changed and what the operator should look at
   first.

## Acceptance checklist (before opening PR)

These are the items the main agent (or reviewer subagent) must
verify, and the PR body must record their state. Anything skipped is
explicitly called out, not silently omitted.

- `pnpm test` green (unit + smoke).
- `pnpm test:e2e` green when credentials exist; explicitly note
  skipped suites and which credentials were absent.
- `pnpm exec tsc --noEmit -p tsconfig.json` green.
- `pnpm exec eslint <changed files>` green.
- Diff scope is limited to the stated task. Drive-by edits to
  unrelated files: removed or split out into a follow-up commit
  with explicit justification.
- `README.md`, `TODO.md`, `design-docs/*`, and `prompts/*.md`
  reviewed: every behavior change has matching doc / playbook /
  TODO updates.
- No credentials, lockfile churn, or generated artifacts staged.

## Coding-agent session reuse

Carry `providerSessionId` across spawns when the next task is a
continuation: addressing reviewer feedback, fixing a test failure,
or polishing docs after the implementation pass. Start a fresh
session (omit `providerSessionId`) when the task is independent or
when the previous run went off the rails.

The `subtask_complete` event you receive after a cc spawn carries
the captured `providerSessionId` — pass it back on the next spawn.
Save it under `memory({ op: 'set', key: 'feature:<branch>.session',
... })` so you can recover it after a restart.

## Failure handling

Surface failures to the operator promptly. Do not retry blindly.

- Test red on the worktree → report which test, attach the failure
  excerpt, ask whether to keep iterating or hand back.
- Coding-agent reports `subtask_complete{status:'errored'}` with no
  obvious cause → surface the summary, do not auto-retry. If the
  cause is rate-limit / quota related, share the next reset time
  from `usage` and ask the operator how to proceed.
- A pre-commit hook fails → do not bypass. Investigate inside the
  worktree, fix, recommit.
- `git push` rejected (e.g. ref already updated) → fetch, inspect,
  ask the operator.
- The operator interrupts mid-flow → finish the current spawn
  cleanly, summarise what landed and what did not, then await the
  next instruction.

## Out of scope for this playbook

- Deploying the merged PR to the live harness (the supervisor /
  blue-green restart). Until that exists, the operator restarts the
  process manually after merging.
- Multi-feature parallel work. Stick to one worktree / branch /
  feature per playbook execution.
