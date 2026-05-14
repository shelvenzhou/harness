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

## Verify before reporting

Treat anything a coding-agent child says about its own work as a
*claim*, not a fact. Before telling the operator a task is done,
independently confirm the structural outcome — that the commits you
expected exist, that the diff matches the requested scope, that the
tests you said would run actually ran. *How* you confirm is up to
you (`git log`, `git show`, `git diff`, re-running tests, reading
the file); the rule is that the child's prose summary is never
sufficient evidence on its own.

Specifically:

- A child returning `status: completed` only means the CLI exited
  cleanly. It does NOT mean the work landed. The child may have
  hit a sandbox / permission failure, given up, and still exited
  cleanly with a `result` event.
- A child reporting `status: blocked` / `status: errored` / `status:
  partial` is the implementer telling you it failed or partly
  failed. Do not paper over it. Surface what the child said to the
  operator with your own independent verification of what actually
  exists on disk / in git.
- If the implementer claims commits, run `git -C <worktree> log
  --oneline <pre-spawn-HEAD>..HEAD` and confirm the count and the
  subjects match. If the implementer claims files, list them. If
  any claim is unsupported by the observable state, that is a
  failure — report it as such, do not invent a success.

Capture the pre-spawn HEAD *before* spawning so you have something
to compare against.

## Trust level for coding-agent spawns

When you spawn cc / codex to edit a sibling worktree YOU just
created, pass `permissionMode: 'bypass'`. The CLI runs headless and
its default permission system will block every `Write` and every
sandboxed `Bash` write (no human to click "approve"); `bypass` skips
both. You may set this ONLY when the cwd is one you created (a
sibling worktree on a feature branch) and the operator authorized
the self-update task — both conditions hold for the workflow on
this page. For any spawn where the cwd is user-supplied or
otherwise not yours, leave `permissionMode` unset.

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
   cwd: <worktree>, permissionMode: 'bypass', task: ... })`. The
   designer's job is a proposal, not edits. Stash the result under
   `memory({ op: 'set', key: 'design:<task>' })`.
4. **Implement.** `spawn({ provider: 'cc', role: 'implementer',
   cwd: <worktree>, permissionMode: 'bypass', task: ...,
   contextRefs: [<designer thread>] })` when a designer step exists;
   otherwise just the implementer.
   The implementer writes code, runs tests, and commits inside its
   own cwd.
5. **Review.** Tests are necessary but not sufficient. For any
   non-trivial source change, perform a quality review before you
   report success: either inline (`shell git diff main...HEAD` +
   targeted `read`) or as a separate reviewer spawn. Prefer the
   separate spawn when the change touches runtime control flow,
   provider/tool contracts, concurrency, persistence, security,
   prompts/playbooks, or more than a couple of files:
   `spawn({ provider: 'cc' | 'codex', role: 'reviewer',
   cwd: <worktree>, permissionMode: 'bypass', task: ... })`.
   The reviewer applies the acceptance checklist below and should
   inspect the implementation quality, not just command output.
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

- Implementation reviewed by the main agent or a reviewer subagent.
  Record which path you used. For complex/shared/runtime changes,
  default to an independent reviewer spawn unless the operator asked
  you not to spawn.
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
