# Playbook: Self-Update

## Trigger

This playbook applies when the operator asks you to modify this harness's own
source code, documentation, configuration, prompts, tests, or release workflow.
The expected outcome is a reviewed feature branch and PR against the harness
repository.

## Non-Negotiables

- Never edit the live serving checkout. Create a sibling worktree first:
  `git worktree add ../wt-<short-feature-name> -b feat/<branch-name>`.
- Pass the worktree path as `cwd` for every coding-agent spawn.
- Never edit `prompts/` or `src/` from outside the worktree.
- Never push to `main` or `master`.
- Never use `git commit --no-verify`, `git push --force`, or `--no-gpg-sign`.
- Never commit credentials, `.env*`, unrelated generated artifacts, or
  unexplained lockfile churn.
- Stage files by name.

If any non-negotiable cannot be satisfied, stop and ask the operator.

## Trust Model

When you spawn `cc` or `codex` to edit a sibling worktree you created, use
`permissionMode: 'bypass'`. Headless coding-agent CLIs cannot answer interactive
write prompts, and the worktree boundary is the safety envelope.

Do not use bypass mode for arbitrary user-supplied directories or directories
whose ownership is unclear.

## Workflow

1. Identify the requested change, expected files, risk level, and required
   checks.
2. Create the feature worktree and record the pre-spawn HEAD.
3. Use a `designer` spawn when the subsystem is unfamiliar, the request is
   open-ended, or the change affects runtime control flow, providers, prompts,
   persistence, concurrency, or security.
4. Use an `implementer` spawn for edits, tests, and commits inside the
   worktree. Pass the design via context refs when one exists.
5. Verify the implementer's claims from the parent thread. Check git log, diff
   scope, changed files, and reported test outcomes.
6. Review non-trivial changes inline or with a `reviewer` spawn. Prefer an
   independent reviewer for runtime, provider, prompt, persistence,
   concurrency, security, or multi-file changes.
7. Iterate on required reviewer feedback. Reuse `providerSessionId` when the
   next coding-agent task continues the same implementation.
8. Push the feature branch and open a PR. Include verification status and any
   skipped checks in the PR body.
9. Remove the sibling worktree after the PR is open.
10. Tell the operator the PR URL, what changed, and what to review first.

## Verification Before Success

Treat child summaries as claims, not facts. Before reporting completion:

- Confirm claimed commits with `git -C <worktree> log --oneline
  <pre-spawn-HEAD>..HEAD`.
- Confirm claimed file changes with `git -C <worktree> diff --stat` and targeted
  reads when needed.
- Confirm test/typecheck/lint claims from command output or rerun the checks
  when the risk warrants it.
- Confirm the diff is limited to the operator's task.

Acceptance checklist:

- Implementation reviewed by the parent or a reviewer subagent.
- `pnpm test` passed, or failure/skipping is explicitly explained.
- `pnpm exec tsc --noEmit -p tsconfig.json` passed.
- `pnpm exec eslint <changed files>` passed.
- `pnpm test:e2e` passed when credentials and scope make it relevant; otherwise
  record skipped suites and missing credentials.
- Relevant `README.md`, `TODO.md`, `design-docs/*`, and `prompts/*.md` were
  reviewed for necessary updates.
- No credentials, unrelated generated artifacts, or unjustified lockfile churn
  are staged.

## Failure Handling

- Test failure: report the failing command and a concise failure excerpt, then
  decide whether to iterate or hand back.
- Coding-agent `blocked`, `partial`, or `errored`: verify what changed on disk
  and report the observable state.
- Unsupported implementer claim: treat it as a failure and correct the record.
- Push rejection: fetch and inspect before asking the operator how to proceed.
- Operator interruption: finish or stop the active spawn cleanly, then summarize
  what landed and what remains.

## Out Of Scope

- Deploying or restarting the live harness after merge.
- Running multiple unrelated self-update branches in one playbook execution.
- Rewriting unrelated architecture while fixing a scoped request.
