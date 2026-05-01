# 01 — Runtime

## Components

```
┌──────────────┐   user_message    ┌──────────────┐   tool_call    ┌──────────────┐
│ ConvAdapter  │ ───────────────▶  │ AgentRunner  │ ─────────────▶ │ ToolExecutor │
│ (Terminal,…) │ ◀───────────────  │ (per thread) │ ◀───────────── │ (worker pool)│
└──────────────┘   reply            └──────────────┘  tool_result  └──────────────┘
       ▲                                  ▲   ▲                          │
       │                                  │   └── subtask_complete ──────┤
       │ external_event                   │                              │
       ▼                                  │                              ▼
┌──────────────┐                          │                       ┌──────────────┐
│  Scheduler   │ ─── timer_fired ─────────┘                       │ Subagent Pool│
└──────────────┘                                                  └──────────────┘
                              EventBus (typed, persistent)
```

- **EventBus** — typed pub/sub. Two logical channels: control-plane
  (`UserTurn / UserInput / Steer / Interrupt / Rollback / CompactRequest /
  Shutdown`) and data-plane (`ToolResult / SubtaskComplete / TimerFired /
  ExternalEvent`). The runner consumes both but distinguishes when deciding
  whether to drain into the current turn or queue for next.

- **SessionStore** — append-only event log per thread. Ground truth for
  rebuilding the conversation and for resume / fork / rollback. The context
  projection layer reads from this store.

- **AgentRunner** — one instance per active thread. Driven by events, not by
  a loop variable. Each tick: load projected context → sample LLM → translate
  output into actions → dispatch → exit.

- **ActiveTurn** — explicit state machine attached to the current turn. Holds
  pending tool calls, pending approvals, and a two-phase mailbox
  (`CurrentTurn` vs. `NextTurn`) for incoming async deliveries. Borrowed
  directly from Codex.

- **ToolExecutor** — worker pool. Executes tools concurrently where safe,
  buffers results in the model's requested order before emitting tool_result
  events.

- **Subagent Pool** — spawned children are just fresh threads with a parent
  pointer and a traceparent. The runner treats `spawn` like any other
  asynchronous primitive.

- **Scheduler** — fires `timer_fired` events for `wait(timeout)` and cron-like
  future delivery. No timer math lives inside the runner.

## AgentRunner lifecycle

```
event arrives on thread T
  ↓
load thread T, advance mailbox phase if turn-bounded
  ↓
project context = stable_prefix + projected_tail(sessionStore, thread=T)
  ↓
call llm.sample(context, tools) → stream of Delta + ActionList
  ↓
for action in ActionList:
  reply           → adapter.deliver
  tool_call       → toolExecutor.submit
  spawn           → subagentPool.spawn (fresh thread with parent=T)
  wait            → mark ActiveTurn as yielded on event_spec
  done            → close turn, memory.commit, emit TurnComplete
  ↓
tick returns; runner sleeps until next event on T
```

Key invariants:

- A thread has **at most one AgentRunner tick in flight** at a time. Events
  arriving during a tick are appended to the mailbox and drained at the start
  of the next tick.
- `ActiveTurn` owns the authoritative answer to "is the turn done?" The
  runner's job is to translate LLM actions into state transitions on it.
- `spawn` does not share context; the child is a new thread unless
  `inherit_turns=N` is set, in which case the last N turn items are copied.

## Pending input ("steer")

When a user sends input while a turn is running:

1. The conversation adapter publishes `UserInput{ threadId: T, text, interrupt? }`.
2. The event lands in T's mailbox.
3. On the runner's next tick (between samplings), the mailbox is drained
   before the next LLM call; the new input becomes part of the prompt.
4. If `interrupt=true`, an in-flight sampling is cancelled and pending tool
   calls are aborted; the turn transitions to `Interrupted` and reopens
   immediately with the mailbox contents as the new turn seed.

## Interrupt / rollback / fork (control-plane ops)

- `interrupt(T)` — cancel in-flight sampling + tool calls; state →
  `Interrupted`. Events already persisted remain; nothing is rewritten.
- `rollback(T, n)` — drop last N turns from context projection (not the log).
  A `RollbackMarker` is appended so the projection layer skips those items.
- `fork(T)` — create a new thread with a copy of T's event log up to a
  boundary. If T has an active turn, a `ForkInterruption` marker is added to
  the child to avoid inheriting a half-executed turn.

These are **operations on the bus**, not direct calls into the runner. The
runner sees them as events. Uniform treatment simplifies audit + replay.

## Subagent budgets and interrupt propagation

`spawn` accepts a `budget` envelope:
`{maxTurns, maxToolCalls, maxWallMs, maxTokens}`. The pool tracks
per-child counters and enforces them as **hard caps**:

- `maxTurns` — sampling step count; counted by `sampling_complete` events.
- `maxToolCalls` — `tool_call` events appended to the child thread.
- `maxWallMs` — wall time since `spawn`.
- `maxTokens` — cumulative prompt + completion tokens reported by
  `SamplingResult.usage`. The most direct cost signal; without it a
  child can stay within turn / tool-call caps yet quietly burn quota
  via large contexts. Soft warning at 80%, hard interrupt at 100%.

When any cap trips, the pool publishes `interrupt` to the child's bus
filter. The child runner cancels in-flight sampling (its `AbortController`
fires) and pending tool calls; the pool then translates the resulting
`turn_complete{status: 'interrupted'}` into `subtask_complete{status:
'budget_exceeded'}` for the parent.

`subtask_complete` preserves the *child's* own last reply as `summary`
even when termination was budget-driven; the cap name and counters
(`{reason, turnsUsed, toolCallsUsed, tokensUsed}`) ride alongside in a
separate `budget` field, with a top-level `reason` that mirrors the
child's `turn_complete.reason` (e.g. `budget_maxTokens`,
`parent_interrupt`). Earlier the parent only saw a synthetic placeholder
("budget exceeded"), losing whatever the child had concluded; that
asymmetry is gone.

**Child-side budget visibility.** The pool injects a budget summary into
the child's system prompt at spawn time so the child can plan within its
caps from the first sampling. At runtime, the `usage` tool returns the
child's `RuntimeBudgetSnapshot` — caps, used, remaining across all four
dimensions — so the model can poll its dynamic budget rather than
discovering the cap by getting cut off.

**Parent → child interrupt propagation.** When the parent receives an
`interrupt`, the pool propagates it to every descendant thread it tracks.
Without this, killing the parent leaves orphan children burning provider
quota. Propagation walks the `parentThreadId` tree maintained by the pool.

`inheritTurns` (parameter recorded today, not yet enforced): when set,
the spawn seeds the child thread with the last N turns of the parent log
copied verbatim. Carries handles forward.

### Structural caps (anti spawn-bomb)

Per-child budgets bound *individual* cost; they do not bound *how many*
children can exist. A single LLM turn can legally emit eight `spawn`
actions; recursively that's a fan-out bomb whose cost trips the API
quota long before any individual child's budget fires.

`SubagentPool` therefore enforces three structural caps configured at
runtime bootstrap (not under LLM control):

- `maxDepth` — longest `parentThreadId` chain (default 4).
- `maxSiblingsPerParent` — concurrent active children of one parent
  (default 4).
- `maxConcurrentTotal` — process-wide active subagents + actors
  (default 32).

When a `spawn` would violate any cap, the pool **rejects it as a
tool-call error** (`{ ok: false, error: 'spawn_limit', limit, value }`).
The LLM sees the rejection and adapts. Hard structural limits, not
soft warnings — soft warnings get ignored. See [10-actor-mode.md §3b](10-actor-mode.md)
for the same rule applied to long-lived actors.

## Concurrency model

- Node.js single-threaded; concurrency is async I/O.
- Tool execution is awaitable; long tools should cooperate with an
  AbortSignal so interrupts propagate.
- Subagents are independent runners; they share the process but not state.
- Cross-thread communication is exclusively via EventBus.

## Tracing

Every event carries a `traceparent` (W3C format). `spawn` copies the parent
traceparent; tool calls carry the parent turn's traceparent. This lets an
external OTEL exporter reconstruct the whole agent tree even across
subagents.

See [07-diagnostics.md](07-diagnostics.md).
