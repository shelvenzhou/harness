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
        cwd: '../harness-feat-tg',
        budget: { maxWallMs, maxTokens, … },
        contextRefs: [...],
        providerSessionId?: 'sess_abc',   // resume cc's internal session
        continueThreadId?: 'thr_X' })     // reopen a prior child thread
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

#### R2 — Implementation contract

The wrapper is degenerate: each `sample()` call corresponds to **one
end-to-end coding-agent invocation**, not a multi-step LLM dialogue.
The harness child runner sees one streaming response, no harness-level
tool calls, then `turn_complete`. cc / codex's internal edit/test loop
is opaque to the parent.

`CodingAgentProvider` (new file `src/llm/codingAgentProvider.ts`):

- Construction: `{ kind: 'cc' | 'codex', cwd, model?, env?, binaryPath? }`.
  `cwd` is mandatory and is the sibling worktree for this spawn.
- Invocation: `claude -p <task> --output-format stream-json --session-id <providerSessionId?>`
  (or `codex exec --json …`). The "task" is the last user message of
  `SamplingRequest.tail`; `StablePrefix.systemPrompt` rides on
  `--system-prompt` / equivalent.
- Stream translation:
  - `assistant` text chunks → `text_delta(channel:'reply')`
  - `thinking` / `reasoning` chunks → `reasoning_delta`
  - internal `tool_use` / `tool_result` events → **dropped** (cc handles
    them; harness has no use for them in the parent's projection)
  - process exit (success) → `end{stopReason:'end_turn'}`
  - quota / rate-limit terminal event → `end{stopReason:'quota_exhausted', resetAt}`
    (see R2a)
  - other terminal errors → `end{stopReason:'error'}`
- `system_init` event (cc emits one at the start with its session id)
  is captured; the provider exposes the captured `providerSessionId`
  via a getter so the runner can attach it to `subtask_complete`.
- Cancellation: SIGTERM the child on `signal.aborted`; SIGKILL after
  a grace window. Mirror the group-kill pattern in the existing
  [shell.ts](../src/tools/impl/shell.ts) tool.
- Child harness tool registry is **empty** for spawns whose provider
  is a coding agent. cc owns its own tools internally; exposing
  harness `shell`/`write` would just duplicate.

Per-spawn provider selection requires plumbing (none exists today —
`SubagentPool` shares one global `provider`):

- `SpawnRequestInfo` gains `provider?: string`, `cwd?: string`,
  `providerSessionId?: string`, `continueThreadId?: ThreadId`.
- `SubagentPoolDeps` gains `providerFactories?: Record<string, (req) => LlmProvider>`.
  The cc/codex factory builds a one-shot `CodingAgentProvider` bound
  to `req.cwd` + `req.providerSessionId`. The default OpenAI provider
  stays as the fallback when `provider` is omitted.
- `spawn` tool schema (`src/tools/impl/spawn.ts`) gets the same four
  fields. Description spells out: "use `provider:'cc'` for coding
  work in a sibling worktree; default (omitted) uses the harness's
  primary provider for orchestration / review", and gives the
  `providerSessionId` reuse rule (carry over to continue, omit to
  start fresh).
- `SubtaskCompletePayload` gains `providerSessionId?: string` so the
  parent can stash it in `memory` and pass it back on the next spawn.

`continueThreadId` semantics: when set, `spawn` reopens an existing
child thread (must already exist in the store, must not have a live
runner) and appends a new `user_turn_start` to it instead of creating
a new thread. This keeps the "one feature, one harness audit thread"
invariant when iterating with the same implementer over multiple
spawn cycles. Pool implementation deferred to milestone 2 — schema
ships in milestone 1 so the LLM sees the stable spawn shape from day
one.

#### R2a — Usage / quota introspection

Coding-agent backends meter usage independently of the OpenAI account
the rest of the harness uses (separate billing, separate rate
limits, occasionally separate quota windows). Both the main agent
and the operator need to see this in-band:

- The `LlmProvider` interface gains an optional `usage()` method
  returning `{ provider, plan?, used, remaining?, resetAt?,
  unitsLastTurn }`. Implementations that can't introspect (raw
  OpenAI Chat) return `unsupported`. The cc / codex implementation
  reads its data from the **stream-json events themselves** —
  `system_init` carries plan + window, ratelimit / `usage` events
  carry running totals — so `usage()` returns the latest cached
  snapshot without invoking a separate CLI subcommand.
- `SubagentPool` / `spawn` exposes a per-child `providerUsage` field
  on `subtask_complete` (the snapshot at child-exit time). The main
  agent reads this to decide whether to keep delegating or switch
  providers. The existing `usage` tool inside the child also
  surfaces it for the child's own pacing decisions.
- **Quota exhaustion mid-task** is a normal failure mode, not a
  crash. The provider surfaces it as a typed
  `SamplingDelta{ kind: 'end', stopReason: 'quota_exhausted',
  resetAt? }`. The runner translates into `turn_complete{status:'errored',
  reason:'quota_exhausted', resetAt}`; the pool rewrites that into
  `subtask_complete{reason:'quota_exhausted', resetAt}`. Partial
  work already committed by the child stays committed; the parent
  resumes by spawning again with `providerSessionId` (cc `--resume`)
  and the same `cwd` / `continueThreadId`.

##### Quota coordination across multiple subagents

Quota is a **provider-account-level global**, not a per-spawn local.
If five cc subagents all hit the same wall they share the same
`resetAt`. Naive design — each one schedules its own `wait(timer)` —
duplicates timers and triggers a thundering-herd retry the moment
the quota refreshes. The runtime collapses this into one channel:

- `CodingAgentProvider` carries a `QuotaState{ resetAt?, kind: 'session'|'weekly' }`
  keyed by provider id (effectively per-account, since cc/codex
  authenticate at process scope). Stream events update it.
- The `Scheduler` schedules **one** timer per `(providerId, resetAt)`.
  When it fires, the runtime publishes
  `external_event{ source:'provider_ready', provider:'cc', resetAt }`
  on the bus.
- While `resetAt > now`, any `spawn(provider:'cc')` **fails fast
  inside the pool** without launching a CLI process: the pool
  synthesises an immediate `subtask_complete{reason:'quota_exhausted',
  resetAt}` to the parent. This is the load-bearing optimisation —
  the parent can fan-out queued work freely; only the first attempt
  pays the wall, the rest short-circuit.
- The parent agent's wait shape is canonical:
  ```
  wait({ matcher:'kind', kinds:['external_event'],
         filter:{ source:'provider_ready', provider:'cc' },
         timeoutMs: 6h })
  ```
  When the event fires it re-dispatches every queued spawn (state
  kept in `memory`, e.g. key `pending:cc-resume`).

##### Weekly limits

`resetAt - now ≥ 6h` (effectively the cc/codex 7-day window) is
**not** held in-process. The playbook in `memory:playbook:self-update`
mandates: reply on Discord with the resetAt, store outstanding state
in `memory`, then `turn_complete`. The next operator message is the
trigger to resume. Avoids the supervisor having to keep a 7-day timer
alive across restarts.

### R2b — Subagent context reuse (cc-session vs harness-thread)

The main agent has **two orthogonal levers** for deciding whether a
new spawn is "fresh" or "continue":

| Lever | What it controls | Owned by |
|---|---|---|
| harness `ThreadId` reuse | Whether `subtask_complete` is observed on a *new* child thread or appended to an existing one | harness store + `SubagentPool` |
| coding-agent `providerSessionId` reuse | Whether cc / codex starts a fresh internal conversation or `--resume`s a prior session | the CLI's own session cache |

The two are independent. `providerSessionId` reuse is the dominant
token-saver — cc has already done internal compaction, so resuming
costs almost nothing whereas re-explaining via `task` text or large
`contextRefs` re-pays the bill. Harness `ThreadId` reuse is mainly
about audit shape: keep one feature's iterations as a single
inspectable thread.

Decision matrix for the playbook:

| Situation | thread | cc session |
|---|---|---|
| First implementation attempt | new | new |
| Address reviewer feedback on the same diff | reuse (`continueThreadId`) | resume (`providerSessionId`) |
| Resume after `quota_exhausted` | reuse | resume |
| Different feature in the same subsystem | new | new + `contextRefs:[designerThread]` |
| Previous attempt went off-rails | new | new (clean slate) |

Mechanism in `spawn`:

- `providerSessionId?: string` — opaque token, passed through to the
  coding-agent provider. Returned on `subtask_complete.providerSessionId`
  (captured from cc's `system_init` event).
- `continueThreadId?: ThreadId` — if set, `SubagentPool` reopens the
  named child thread (must exist in the store, must have no live
  runner) and appends a fresh `user_turn_start` instead of creating
  a new thread. Mismatch → `SpawnRefused`.

The main agent's tokens stay flat across iterations because the
state lives outside its prompt: git holds the diff, `memory` holds
the design + per-feature record (e.g. `feature:tg.session = sess_abc`),
the child thread holds the implementation transcript reachable via
`contextRefs`. The parent only carries pointers.

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

## Milestones (top-priority track)

Self-bootstrap is now the **highest-priority** track — the harness
should be editing itself before any other Phase-2/3 polish lands. The
ordering below is concrete enough to PR against. Each milestone is
shippable on its own: the harness keeps working with no regressions
even if work pauses between them.

### M1 — `CodingAgentProvider` + per-spawn provider plumbing

Goal: the main agent (running on the default OpenAI provider) can
issue one `spawn(provider:'cc', cwd:'…', task:'…')` and observe a
`subtask_complete` carrying cc's reply.

- `LlmProvider.SamplingDelta.end.stopReason` extended union (adds
  `'quota_exhausted'`, payload optional `resetAt`). Wiring through
  runner / `turn_complete.reason` lands here so M2 only needs to
  populate it.
- New `src/llm/codingAgentProvider.ts` covering cc first
  (codex follows the same shape; deferred behind a flag).
  Stream-json parser; SIGTERM-on-abort; `system_init` capture for
  `providerSessionId`.
- `SpawnRequestInfo` and `spawn` tool schema gain `provider?`,
  `cwd?`, `providerSessionId?`, `continueThreadId?` fields.
  - `provider` / `cwd` / `providerSessionId` are **fully wired** in
    M1 — the cc factory threads `providerSessionId` to the CLI as
    `--resume <id>` so multi-turn design / iteration works without
    re-paying context every spawn.
  - `continueThreadId` is **schema-only** in M1 (pool ignores it).
    Shipping the shape now keeps the LLM-facing contract stable
    across milestones; full reopen semantics land in M2.
- `SubagentPoolDeps.providerFactories` registry; coding-agent
  factory builds a one-shot `CodingAgentProvider` bound to the
  spawn's `cwd`.
- `SubtaskCompletePayload.providerSessionId?: string` populated
  from the captured value.
- `bootstrap.ts` registers cc factory under env (`HARNESS_CC_BIN`,
  `CLAUDE_API_KEY` or wherever cc reads its auth).
- One e2e test: a minimal harness session where the main agent is
  prompted to spawn a cc child to write "hello" to a temp file in
  a sibling dir, then verifies the file.

### M2 — quota coordination — 🟢 shipped

Goal: cc subagents that hit a session limit pause cleanly, the
parent waits once, and on `provider_ready` it re-dispatches the
queued work.

What actually landed (see `tests/smoke/quotaCoordination.test.ts`
for the contract in code):

- `SamplingDelta.end.stopReason` carries `'quota_exhausted'` plus
  an optional `resetAt`; the runner threads it through
  `turn_complete.resetAt` → `subtask_complete.resetAt`.
- `CodingAgentProvider` flips to `quota_exhausted` on its
  terminal `end` when an in-run `rate_limit_event` matched a
  blocked sentinel (`status: 'blocked' | 'rate_limited' |
  'limit_reached' | 'exceeded'` or `utilization >= 1.0`) and the
  CLI subsequently errored out. The resetAt is the one cc
  itself reported.
- The pool reads the **existing** `ProviderUsageRegistry` rather
  than introducing a separate `QuotaState` registry; the
  `fiveHour` / `sevenDay` snapshots captured in M1 are the
  source of truth.
- `SubagentPool.spawn` consults the registry: if any window for
  the requested provider is blocked and not yet reset, the pool
  synthesises an immediate
  `subtask_complete{reason:'quota_exhausted', resetAt}` to the
  parent. The synthetic path still writes the child thread +
  `user_turn_start` seed for audit-log parity.
- One `provider_ready` timer per `(providerId, resetAt)`, deduped
  by a key map inside the pool. On fire, the pool publishes
  `external_event{source:'provider_ready', data:{provider, resetAt}}`
  on the bus. Timer is `unref`'d so a clean shutdown isn't held
  open. The parent agent waits on `kind: 'external_event'` and
  filters by `source` + `provider` in its own logic.
- `continueThreadId` reopen implemented: pool verifies the
  target thread exists and has no live runner
  (`SpawnRefused('continueThreadId_unknown' | 'continueThreadId_live')`),
  then appends a fresh `user_turn_start` and attaches a new
  runner to the existing thread.

### M3 — usage introspection

Goal: parent / operator can see "how much does this cc account have
left this window" without running CLI commands by hand.

- `LlmProvider.usage()` interface added; OpenAI returns
  `'unsupported'`; cc returns last cached snapshot.
- `SubtaskCompletePayload.providerUsage?: UsageReport`.
- `usage` tool output extended with optional `providerUsage` block
  for spawned children.

### M4 — operator playbook (no code changes)

Goal: a real "add a Telegram adapter" demo end-to-end, driven only
by operator messages on Discord (or terminal in dev).

- Author and pin `memory:playbook:self-update` containing:
  - decision tree for designer / implementer / reviewer (R2b
    matrix)
  - the R3 step-1 acceptance checklist
  - quota / weekly-limit handling (R2a)
  - PR opening flow (R4)
- Demo: operator says "add a Telegram adapter"; the main agent
  fans out designer → implementer → reviewer; PR appears on
  GitHub; tests green.

### M5 — supervisor + restart handshake — 🟢 shipped (single-instance variant)

R3's three layered safeguards live across two surfaces: the
**operator playbook** (pre-deploy review checklist, M4) handles
safeguard #1; the **external supervisor** handles #2 (build
verifier) and a single-instance form of #3 (no blue/green yet —
see "Out of scope" below).

Concrete shape (matches `tests/unit/runtime/lifecycle.test.ts`):

- `restart_event` event kind: emitted on every harness boot,
  carrying `fromSha` (when the supervisor handed one off) →
  `toSha` (current HEAD) plus `ref`, `outcome`, `message`,
  `startedAt`. Discord renders `-# 🔄 back on <from> → <to> (ref) …`;
  terminal renders a dim `[restart …]` line.
- `<storeRoot>/.lifecycle/` is the handshake channel between
  harness and supervisor:
  - `ready.json` — written by the harness once its adapter is
    connected. Contains `{ pid, sha, ref, startedAt }`. Deleted
    on clean shutdown. The supervisor watches for this file to
    confirm the new build came up.
  - `handoff.json` — written by the supervisor *before* exec'ing
    the new harness. Read + deleted on boot by the new process
    so the `restart_event` it publishes carries the
    `fromSha`/`outcome` the supervisor intended.
  - `pid` — the supervisor's bookkeeping of its current harness
    child's PID.
  All writes are atomic (tmp + rename).
- `scripts/supervisor.cjs` is dependency-free Node, runs
  **outside** the harness process. Three subcommands:
  - `start [<ref>]`
  - `deploy <ref>` — fetch → checkout ref → `pnpm install`
    `--frozen-lockfile` → `pnpm build` → `pnpm test` **on the
    new ref**. Failure path: revert checkout, leave old running,
    exit non-zero. Success path: SIGTERM old harness (SIGKILL
    after `HARNESS_SHUTDOWN_TIMEOUT_MS`), write handoff, spawn
    new harness, wait for `ready.json` with the expected sha
    within `HARNESS_READY_TIMEOUT_MS`.
  - `status` — pid + ready introspection.

The anti-brick contract: **a broken build cannot kill the old
harness**, because build / install / test all run before the
SIGTERM. The cost is a brief drop window during cutover (Discord
gateway disconnect + reconnect) — acceptable for the
single-operator deployment target.

Out of scope for this M5 (tracked in `TODO.md` and a future
follow-up):

- True blue/green where two harness instances coexist briefly.
  Discord allows only one connection per bot token; achieving
  this requires either a staging bot token or an HTTP adapter.
- Automatic rollback to a prior-known-good sha on ready-file
  timeout. Today the operator gets a clear error and intervenes.
- A `/deploy` slash command. The main agent can already invoke
  the supervisor via `shell`, but a non-detached invocation dies
  with the parent — proper integration needs `nohup` / `setsid`
  detachment.

### M6 — codex parity

Re-target `CodingAgentProvider` to codex; document any contract
divergence in this file's R2 implementation contract section.

### Out of scope until later

- Sandbox (phase 4) is **not** a prerequisite for any of M1–M5.
- A second non-OpenAI primary provider for the orchestrator
  (Anthropic streaming) — orthogonal; lands when needed for
  cost / capability reasons unrelated to self-update.
