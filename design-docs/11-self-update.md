# 11 — Self-update / remote ops

## Goal

The operator (a human, off-host) drives the harness's own evolution by
talking to the running instance. The instance can pick up a feature
request, implement it (using a coding-agent backend, not raw OpenAI
chat), self-review the result, surface the diff for human review,
restart itself onto the new build, and resume serving traffic. The
harness becomes the development loop for itself.

End-state user story:

> From Discord, I tell the running harness "add a Telegram adapter."
> It spawns a coding-agent subagent, the agent edits the repo and
> commits. The main agent runs the unit + e2e suites, does a
> structural review of the diff, makes sure docs/TODO/roadmap are
> updated, then opens a PR on GitHub and pings me with the link. I
> review on github.com, comment / approve. On `/deploy` the harness
> brings up a new instance on the merged ref, waits for it to report
> healthy, then cuts traffic over. The next message I send hits the
> new binary on the same thread.

This document is a **requirement spec**, not a final design. The four
sub-requirements below are independent enough to land in any order.

## Non-goals (for this doc)

- Sandbox / permission model. Optional, not a prerequisite — see
  [00-overview.md](00-overview.md#5-security--sandbox-later-interface-today).
  Single-operator, trusted-host deployment is the v1 target.
- Multi-tenant deployment.
- Zero-downtime hot-reload of in-flight turns. The blue/green cutover
  in R3 minimises drop, but a turn straddling a deploy is interrupted
  and replayed from the store on the new instance.

## Tool-surface principle

Stick to the minimum-orthogonal-set rule from
[03-tools.md](03-tools.md#principle). In principle `shell` alone
covers all the build / git / `gh` / supervisor work below. **Do not
add `restart`, `code_agent`, `deploy`, or `pr_open` tools.** What this
doc adds to the runtime is mostly:

- a Discord adapter (R1),
- one new `LlmProvider` implementation wrapping a coding-agent CLI (R2),
- a tiny supervisor + health-probe contract (R3),
- a `usage` introspection path on `spawn` (R2 sidecar).

Everything else is the model composing `shell` + `spawn` + `memory` +
`wait`.

## Sub-requirements

### R1 — Discord adapter (operator channel)

Already on the Phase 3 list in [08-roadmap.md](08-roadmap.md); pulled
forward because it is the operator's primary control channel for the
other three sub-requirements.

- DM = thread; guild channel = thread. `per-channel` `ThreadBinding`
  per [06-adapters.md](06-adapters.md#future-discord--tg--http).
- Long replies split at the 2000-char limit.
- No bespoke slash commands at runtime level. Operator just talks to
  the agent ("deploy the merged PR", "what's the status"); the agent
  composes `shell` etc. to do it. A small adapter-level `/interrupt`
  is fine because it maps directly to the existing `Interrupt` event.
- **Untrusted-source framing**: Discord input from anyone other than
  the operator's configured user-id is projected with the untrusted
  frame called out in
  [06-adapters.md](06-adapters.md#adapters-vs-actor-mode), or
  rejected. Operator identity is configured at adapter start (no
  auth handshake in v1).

### R2 — Coding-agent backend ("codex / cc as the implementation agent")

The default `LlmProvider` (OpenAI Chat) is fine for conversation but
too low-leverage for editing the harness's own source. For
implementation work, delegate to a coding-agent process (Codex CLI,
Claude Code CLI, or equivalent) that already encapsulates the edit /
test / iterate loop.

Implement as an `LlmProvider` wrapper, not as a new tool — preserves
budgets, interrupt propagation, traceparent, and the spawn-based
composition story:

```
spawn({ role: 'implementer',
        provider: 'cc',           // or 'codex'
        budget: { maxWallMs, maxTokens, … },
        contextRefs: [...] })
```

The wrapper translates CLI-shaped streaming events onto
`SamplingDelta` ([05-llm-provider.md](05-llm-provider.md#interface)).
Tool calls the coding agent emits internally are its own concern;
from the parent's perspective the child is a black-box agent that
emits `reply` and exits.

The coding-agent child runs against **a sibling git worktree**, not
the live serving copy, so a half-finished edit can never break the
next restart's build. Successful runs land as commits on a feature
branch.

#### R2a — Usage / quota introspection

Coding-agent backends meter usage independently of the OpenAI account
the rest of the harness uses (separate billing, separate rate
limits, occasionally separate quota windows). Both the main agent
and the operator need to see this in-band:

- The `LlmProvider` interface gains an optional `usage()` method
  returning `{ provider, plan?, used, remaining?, resetAt?,
  unitsLastTurn }`. Implementations that can't introspect (raw
  OpenAI Chat) return `unsupported`.
- `SubagentPool` / `spawn` exposes a per-child `usage` field on
  `subtask_complete` and on the existing `usage` poll the child can
  already make ([TODO.md](../TODO.md), `SubagentPool` section). The
  main agent reads this to decide whether to keep delegating or
  switch providers.
- **Quota exhaustion mid-task** is a normal failure mode, not a
  crash. The provider surfaces it as a typed
  `SamplingDelta{ kind: 'end', stopReason: 'quota_exhausted',
  resetAt? }`. Runner translates into `subtask_complete` with
  `reason: 'quota_exhausted'` and the same shape `budget_*`
  interrupts use today, so the parent can `wait({ timer, until:
  resetAt })` and retry, fall back to a different provider, or hand
  back to the operator for a decision. Partial work already
  committed by the child stays committed; the parent can resume
  with `contextRefs` pointing at the child's last reply.

### R3 — Remote restart, with anti-brick safeguards

The naive "pull, build, exec" loop has one fatal failure mode: a
build that compiles but doesn't start (bad config migration, missing
env, broken Discord login) leaves the operator with no channel to
fix it. The supervisor must guarantee that a failed deploy never
removes the operator's ability to issue the next command.

**Three layered safeguards.** All three are required; none alone is
sufficient.

1. **Pre-deploy main-agent review (gate, before any restart).**
   Before the main agent reports the PR / deploy as ready, it must
   have, on the candidate ref:
   - run unit + smoke tests green (`pnpm test`),
   - run e2e green where credentials exist (`HARNESS_E2E=1
     pnpm test:e2e`); explicitly note skipped suites,
   - reviewed the diff for scope creep / obvious regressions
     (composition of existing primitives — no new tool needed),
   - confirmed `README.md`, `TODO.md`, relevant `design-docs/*` are
     updated where the diff warrants it.

   The agent records this checklist in `memory` (or as PR body
   content) so the operator can see what was checked. Failure on
   any item halts the deploy and surfaces the failure on Discord —
   the operator decides whether to override.

2. **Build verifier on the new tree, before exec.** Supervisor
   runs `pnpm install --frozen-lockfile && pnpm build` in the
   candidate worktree. Failure stays on the current build and
   surfaces the build log. No exec.

3. **Blue/green cutover with health probe.** Instead of `exec`-ing
   in place, the supervisor:
   - starts the new instance on the new build, on a separate
     adapter-port / Discord-bot session marked `staging`,
     pointing at the same `SessionStore`;
   - waits for the new instance to publish a `ready` event
     (process boot complete, Discord gateway connected, store
     reachable, default thread loaded) within a timeout;
   - on ready: signals the old instance to interrupt in-flight
     turns with `reason: 'restart'`, drain, and exit; promotes
     the new instance from `staging` to primary;
   - on timeout / crash of the new instance: kills the new
     instance, leaves the old one serving, surfaces the failure.

   Net effect: a dead-on-arrival new build is observed *while the
   old build is still answering Discord*. The operator always has
   a working channel to ask "what went wrong" and try again.

The supervisor itself is the simplest thing that does this — a
shell script or a tiny Node parent. It is **outside** the harness
process so a hung child can't take it down. Restart events
(`restart_event` in the `SessionStore`) record from-sha → to-sha
and the cutover outcome so the new process can render "I just came
back from <sha> → <sha>" on its first turn.

Constraints:
- Discord adapter must reconnect cleanly post-cutover (gateway
  resume preferred, fresh login fallback). Operator should see at
  most one "deploying…" / "back on <sha>" pair per deploy.
- Migrations on the `SessionStore` schema are explicitly out of
  scope for v1 — append-only JSONL has no schema. When a real
  store backend lands, it gets its own migration story.

### R4 — Remote review via GitHub PR (optional but recommended)

Code review over Discord is painful; offload to GitHub:

- Coding-agent runs from R2 push to a feature branch on the
  configured remote (`shell` + `git push`).
- Main agent opens a PR via `gh pr create` and posts the URL on
  Discord. PR body includes the R3-step-1 checklist results.
- Operator reviews on github.com, comments, approves.
- On the operator saying "deploy" (or merging if auto-deploy is
  explicitly enabled — off by default), the main agent runs the R3
  flow against the merged ref.

GitHub auth: a fine-grained PAT in env at start, scoped to the
target repo. No OAuth dance in v1. No new tool — `gh` via `shell`.

## How the four pieces compose

```
   operator (Discord)              harness (current build)             coding-agent (R2)            GitHub
        │                                  │                                  │                       │
        │  "add a Telegram adapter"        │                                  │                       │
        │ ───────────────────────────────▶ │                                  │                       │
        │                                  │  spawn(role:'implementer',       │                       │
        │                                  │        provider:'cc')  ────────▶ │                       │
        │                                  │                                  │  edits sibling worktree
        │                                  │                                  │  commits, pushes  ───▶│
        │                                  │  subtask_complete{usage,branch}  │                       │
        │                                  │ ◀─────────────────────────────── │                       │
        │                                  │  R3 step 1: tests + diff review + docs check            │
        │                                  │  gh pr create  ─────────────────────────────────────── ▶│
        │  "PR ready: <url>  ✓ tests ✓ docs"                                                          │
        │ ◀─────────────────────────────── │                                                          │
        │                                  │                                                          │
        │   (review on github.com, approve, merge)                                                    │
        │                                  │                                                          │
        │  "deploy"                        │                                                          │
        │ ───────────────────────────────▶ │  supervisor: pull + install + build (R3 step 2)         │
        │                                  │              start staging instance                      │
        │                                  │              wait for ready                              │
        │                                  │              cut over (R3 step 3)                        │
        │  "back on <sha>"                 │                                                          │
        │ ◀─────────────────── (new build) │                                                          │
```

## Open questions

- Sibling worktree vs. same checkout for the coding-agent child:
  sibling is safer (default), but uses 2x disk. Acceptable.
- Restart granularity: turn boundary is the default; we need a story
  for "deploy requested mid-30-minute coding-agent run." Probably:
  queue the deploy, fire it after the next `turn_complete`, and
  surface the wait on Discord.
- ACL on destructive operations (push, restart): lives at the
  `Interrupt`/event level keyed on operator user-id, not as a
  per-tool gate. Adapters tag inbound events with the source identity;
  the runner enforces.
- Rollback: the blue/green design above implies a one-command
  rollback by re-running R3 against the previous-good sha. Worth
  recording the previous-good sha in `memory` so the operator
  doesn't have to dig it out.
- Sandbox interaction: when phase-4 sandboxing lands, the
  coding-agent child gets a tighter Executor profile than the
  serving runtime. Until then, the coding-agent child has full
  shell access — same as everything else.

## Phasing

Add to [08-roadmap.md](08-roadmap.md) as a new phase between current
Phase 3 (second adapter) and Phase 4 (sandbox):

- **Phase 3.5 — self-update**: R1 (already in Phase 3), then R2 +
  R2a, R3, R4 in that order. R4 is optional but lands cheap once
  R2 is in place.

Sandbox (phase 4) is **not** a prerequisite. Self-update ships
operator-trusted on a single host; sandboxing tightens what the
coding-agent child can touch when it lands.
