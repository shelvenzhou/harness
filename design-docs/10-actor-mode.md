# 10 — Actor mode (deferred)

> **Status: deferred.** Do not implement until a concrete multi-agent use case
> lands (e.g. a long-lived Discord watcher, an approval/triage actor, or two
> peer agents that must collaborate without a parent/child relationship).
> Until then, the spawn tree + per-thread mailbox in
> [01-runtime.md](01-runtime.md) is sufficient. Premature implementation costs
> debuggability (call stacks become event flows) without buying anything.

## Why this document exists

The existing runtime already contains most of the pieces an actor model needs:
threads with their own `AgentRunner`, per-turn mailboxes with explicit
`CurrentTurn` / `NextTurn` phases, an append-only `SessionStore`, a typed
`EventBus`, and a `parentThreadId` tree maintained by the subagent pool.
What's missing is a small set of primitives that turn this into a
general-purpose actor system, plus an explicit decision to model some agents
as long-lived state machines rather than as task-shaped subagents.

This doc captures the design **before** we need it, so when the trigger
arrives we land it against a stable shape rather than reinventing it.

## What "actor mode" means here

A second execution mode that coexists with the default spawn-tree mode:

| aspect          | spawn-tree (default)              | actor mode (this doc)                |
|-----------------|-----------------------------------|--------------------------------------|
| lifecycle       | finite task; `done` ends it       | long-lived; idle ↔ active            |
| addressing      | parent ↔ child only               | by name via actor registry           |
| budget          | `maxTurns / maxToolCalls / maxWallMs` over the whole task | per-turn budget; lifetime is open    |
| communication   | `spawn` / `subtask_complete`      | `send(actorRef, msg)` mailbox post   |
| control flow    | LLM-driven action loop            | optional: explicit state machine     |
| termination     | reaching `done`                   | explicit `stop` or hibernation       |

Both modes share `SessionStore`, `EventBus`, projection, compaction, tools,
and `ActiveTurn`. The split is purely lifecycle + addressing.

## Trigger conditions (when to implement)

Land actor mode when **any** of these is true and the spawn-tree workaround
starts hurting:

1. A real long-lived adapter (Discord channel watcher, file watcher, MCP
   long-poll) needs its own LLM-driven loop, not just an I/O bridge.
2. Two agents need to talk without a parent/child relationship (peer review,
   approval workflow, broadcaster ↔ subscribers).
3. Recovery semantics start mattering: a runner crashed mid-turn, and the
   answer "replay the thread's mailbox" is structurally cleaner than the
   current ad-hoc rebuild.
4. A workflow keeps re-deciding the same control-flow question every turn
   ("am I waiting for approval?") and would benefit from being a state
   machine where the LLM only chooses *within* a state.

If none of these apply, do not implement. Spawn + memory + adapters cover
single-user coding agents fully.

## Value, restated

Three distinct value propositions, each independently a good reason:

- **Engineering**: long-lived services become first-class instead of being
  jammed into adapters; crash recovery becomes mailbox replay (free, given
  SessionStore is already append-only); mailbox length is a clean
  per-actor backpressure signal.
- **Modeling**: optional state machines remove "what should I do now?" from
  the prompt, narrow the legal action set per state, shorten prompts, and
  make wrong moves structurally impossible. Worth it for *narrow* actors;
  overhead for open-ended coding agents.
- **Cognition**: the actor registry + mailbox topology turns multi-agent
  systems from implicit (encoded in prompts) into a real graph that can be
  rendered, monitored, and replayed. This is the qualitative jump from
  "multi-agent works" to "multi-agent is debuggable".

## What we add (when we implement)

### 1. `send(actorRef, message, opts)` primitive

A new tool / runtime primitive that posts an event into another thread's
mailbox by name. This is the "missing" piece that turns the existing
parent ↔ child spawn tree into a general communication graph.

```ts
type ActorRef = { kind: 'name'; name: string }   // 'discord:#general'
              | { kind: 'thread'; threadId: ThreadId };

interface SendOpts {
  phase?: 'CurrentTurn' | 'NextTurn'; // default NextTurn
  interrupt?: boolean;                // default false
  asKind?: 'user_input' | 'external_event'; // default external_event

  // Cognitive snapshot (see §1a). Optional but strongly recommended for
  // request/response patterns where the sender will need to interpret
  // the reply in the context of the goal that motivated the request.
  senderState?: {
    correlationId: string;            // echoed back on the reply
    goalKey: string;                  // memory/handle key restorable by sender
    goalSnapshot?: string;            // inline copy if too small to be worth a handle
  };
}
```

Implementation: resolve `actorRef` via the actor registry → look up the
target thread's `ActiveTurn` → call `deliver(event, {interrupt})`. Phase
controls whether the receiver sees it before its next sampling or only
after the current turn closes — exactly the same semantics as the
existing per-thread mailbox phase, lifted to inter-actor scope.

#### 1a. Correlation IDs and cognitive snapshots

`traceparent` already gives the runtime a way to stitch a reply back to
its originating request, but it does not solve a different problem:
when B's reply arrives at A, A's *projected* context may have moved on
(new user input, compaction). A may no longer "remember" what it asked
B for, or why.

The pattern: A includes a `senderState` on the outbound `send`. The
runtime persists `goalKey` / `goalSnapshot` so the sender can `restore`
the original goal alongside the reply. The receiver echoes
`correlationId` on its response (whether a `subtask_complete`-style
return or a fresh `send`). The sender's projection layer renders the
reply with an inline reference to the snapshot:

```
<reply correlation="req-7c">
  [goal: "find prior incident reports matching pattern X"]
  [restore goal-7c for full context]
  result: …
</reply>
```

This is voluntary — small synchronous-shaped exchanges don't need it —
but it is the canonical fix for the "B replied but A forgot why" failure
mode in async actor systems. The `goalKey` integrates with the existing
`restore(handle)` machinery from [04-context.md](04-context.md), so no
new persistence path is required: the snapshot is just another handle.

### 2. Actor registry

An in-process name service mapping stable names → threadIds:

```ts
interface ActorRegistry {
  register(name: string, threadId: ThreadId, meta?: ActorMeta): void;
  lookup(name: string): ThreadId | undefined;
  list(filter?: { prefix?: string }): ActorEntry[];
  unregister(name: string): void;
}
```

Names are conventionally namespaced (`discord:#foo`, `approver:legal`,
`watcher:fs:/tmp`). The registry is recoverable from SessionStore (each
actor's first event records its name), so a runtime restart re-populates
it by scanning thread metadata.

### 3. Persistent actor lifecycle

`SubagentPool` today enforces lifetime budgets. Actors need a different
shape:

- **Per-turn budget** (`maxToolCallsPerTurn`, `maxWallMsPerTurn`) instead
  of lifetime caps.
- **Idle policy**: after N minutes with no inbound mailbox events,
  trigger Level-2 compaction, persist the resulting summary as the
  thread's stable prefix, drop the in-memory `AgentRunner`. On the next
  inbound event, rehydrate a fresh runner from the compacted summary —
  the same machinery [04-context.md](04-context.md) already describes,
  used as hibernation.
- **Explicit stop**: actors don't end at `done`; they end at an explicit
  `actor_stop` event or registry unregister.

A new `ActorPool` (sibling of `SubagentPool`) owns this. `SubagentPool`
keeps its existing semantics; the two pools share the registry but not
the lifecycle code.

#### 3a. Circuit breaker (lifetime caps for long-lived actors)

Per-turn budgets prevent a single turn from running away, but they do
not stop a long-lived actor from quietly burning quota across thousands
of turns. The "digital black hole" failure mode: an idle-then-active
watcher that wakes once a minute, samples the LLM, and goes back to
sleep — perfectly within per-turn budget yet expensive over a week.

`ActorPool` therefore enforces three orthogonal caps in addition to the
per-turn budget:

```ts
interface ActorBudget {
  // per-turn (already present)
  maxToolCallsPerTurn?: number;
  maxWallMsPerTurn?: number;

  // lifetime — circuit breakers
  maxLifetimeTokens?: number;   // soft: warn at 80%, hard-stop at 100%
  maxLifetimeUsd?: number;      // alternative framing for cost-capped envs
  ttlMs?: number;               // hard: actor terminated after wall-clock
  idleTtlMs?: number;           // hibernate after this many ms with no inbound
}
```

- **Token / cost cap** is the primary defence. Token usage is already
  reported by the provider per sampling (`SamplingResult.usage`); the
  pool sums it across the actor's lifetime. At 80% the pool publishes
  `actor_budget_warning` so the actor can self-trim or escalate; at
  100% it publishes `actor_stop` with reason `budget_exceeded`.
- **TTL** is wall-clock based and uncoupled from work done — useful for
  "this watcher should not exist past midnight" or for scheduling
  hygiene. Distinct from `idleTtlMs` (which triggers hibernation, not
  termination).
- **Token counting must also exist for spawn-tree mode.** Today
  `SubagentPool` only counts turns / tool-calls / wall time; tokens are
  the most direct cost signal and should be added as a fourth
  dimension of `SubagentBudget` so the same circuit-breaker logic
  applies to ephemeral subtrees.

#### 3b. Depth and fan-out caps (anti spawn-bomb)

Per-actor and per-subagent budgets do not bound *how many* actors /
children can exist. A single LLM turn can legally emit eight `spawn`
actions; recursively that's a fan-out bomb that exhausts the API
quota before any single actor's budget trips.

Both pools enforce three structural caps, configured at runtime
bootstrap and **not** under LLM control:

```ts
interface PoolStructuralLimits {
  maxDepth: number;              // longest parent→child chain (default 4)
  maxSiblingsPerParent: number;  // concurrent active children of one parent (default 4)
  maxConcurrentTotal: number;    // process-wide active actors+subagents (default 32)
}
```

When a `spawn` or `actor_register` would exceed any cap, the pool
**rejects the call** and returns a `tool_call` error like
`{ ok: false, error: 'spawn_limit', limit: 'maxDepth', value: 4 }`.
The LLM sees the rejection like any other tool failure and adapts.
This is intentionally a hard structural limit, not a soft warning:
soft warnings are easy for the model to ignore.

`maxDepth` is measured along `parentThreadId`; cross-actor `send`
does not count toward depth (peers are not parents). `actor_register`
counts against `maxConcurrentTotal` but not against any parent's
sibling cap, since actors live outside the spawn tree.

### 4. Optional state machine layer

A *thin* opt-in layer over `AgentRunner`:

```ts
interface ActorStateMachine {
  initial: StateName;
  states: Record<StateName, {
    allowedActions: ActionKind[];   // restricts what LLM may emit
    allowedTools?: string[];        // restricts tool spec list
    onEnter?: (ctx) => void;
    transitions: Record<EventPattern, StateName>;
  }>;
}
```

The runner consults the current state to filter the tool spec list and
validate emitted actions against `allowedActions`. Transitions are
triggered by event matching — no LLM call, deterministic. The LLM only
chooses *within* a state.

Crucially, this is **opt-in per actor**. The default coding agent
remains stateless / fully LLM-driven.

### 5. Untrusted input boundary in projection

Actor mode brings external endpoints (HTTP, Discord, etc.) closer to
agent decision-making. Today every `user_input` is trusted. With actors,
projection ([04-context.md](04-context.md)) must distinguish:

- `user_input` from the local trusted adapter (terminal, IDE)
- `external_event` from third-party channels (Discord, webhooks)

The latter must be visually framed in the prompt as untrusted (`<external
source="discord:#general">…</external>`). Without this, a Discord
prompt-injection looks identical to a user instruction. This is the one
piece that, if we ever expose external endpoints into mailboxes
*before* full actor mode, must land first.

### 6. Tree-level fork / rewind — and what it cannot do

`SessionStore.fork(threadId, upToEventId)` exists today but is per-thread.
Actor mode wants `forkTree(rootThreadId, upToCheckpoint)` that recursively
copies a thread + all descendants.

**The hard part is not the data structure.** Organising messages and
context as a tree is easy — `parentThreadId` already gives us that, and
extending `fork` to recurse is mechanical. The hard part is that *rewind
does not undo side effects*. Forking the event tree only rewinds the
agent's view of the world, not the world itself:

- A Discord message already posted stays posted.
- `rm -rf` already executed cannot be un-run.
- A paid API call (LLM, payment, email send) already cost money / sent
  email.
- A file written to disk is still on disk; a network packet is gone.
- A registered webhook still fires; a created issue still exists.

This means rewind is **only safe over actions the runtime can prove are
reversible or pure**. For everything else, rewind produces a tree that is
*coherent internally* but *desynchronised from reality* — and that
desync is, in practice, worse than no rewind at all, because the agent
re-executes from a state where its model and the world disagree.

The design therefore is not "fork the tree freely"; it is "classify
actions, and only support rewind across the reversible subset". Concrete
shape:

#### Action classification

Every tool result carries an `effect` tag, set by the tool author:

```ts
type Effect =
  | { kind: 'pure' }                      // read, web_fetch (cacheable), memory.get
  | { kind: 'internal' }                  // memory.set, spawn — runtime-owned, reversible
  | { kind: 'external_reversible'; compensate?: ToolCall }
                                          // e.g. file write with prior-content snapshot
  | { kind: 'external_irreversible'; reason: string };
                                          // shell, send (Discord/email/HTTP POST), payments
```

Defaults are conservative: any tool that doesn't declare itself is
`external_irreversible`. Tool authors opt *in* to weaker effect tags by
proving the property.

#### Rewind semantics by effect

`rewindTree(rootThreadId, toCheckpoint)` walks events in the rolled-back
range:

| effect                  | behaviour                                            |
|-------------------------|------------------------------------------------------|
| `pure`                  | drop silently                                        |
| `internal`              | reverse via runtime (e.g. truncate memory writes)    |
| `external_reversible`   | run `compensate` (e.g. restore prior file contents); if compensation fails, escalate to irreversible |
| `external_irreversible` | **block the rewind by default**; require explicit `--accept-desync` flag and record a `RewindDesyncMarker` in the new tree so the agent's projection sees `[external action X happened in the previous timeline; world state may differ]` |

The marker is the key: when rewind *is* forced past an irreversible
action, the forked tree carries an explicit, model-visible note that
ground truth and event log disagree about a specific fact. The agent can
then decide to re-verify (e.g. `read` the file, query the API) before
proceeding. This converts a silent inconsistency into a known one.

#### Fork vs. rewind

These are different operations and the irreversibility issue affects them
differently:

- **Fork** (branch off a *new* tree at a checkpoint, original tree
  continues): safe regardless of effect class. The original timeline still
  owns the side effects; the fork inherits them as historical fact and
  proceeds from there. Useful for "what if" exploration where the fork
  doesn't *replay* past actions, only continues from the checkpoint
  state.
- **Rewind** (truncate the *current* tree back to a checkpoint and
  resume): governed by the table above.

The common mistake is using rewind when fork is what's wanted. The API
should make fork the cheap default and rewind the operation that
requires per-effect justification.

#### What this lets actor mode actually do

- Cheap fork-for-exploration: spawn a "what would this approver decide"
  branch without rewinding the parent.
- Safe rewind across pure / internal-only segments (e.g. an LLM-only
  triage actor with no tool calls — fully rewindable).
- Best-effort rewind across reversible side effects with compensating
  actions, where the tool author has done the work.
- Honest failure mode for irreversible side effects: refuse, or produce
  a forked tree the agent knows is desynchronised.

#### Open questions (not blocking)

- Should the runtime auto-snapshot file contents before `write` to make
  it `external_reversible`? Cheap for small files, expensive at scale;
  probably opt-in.
- Compensation actions are themselves side-effectful and can fail —
  needs a bounded retry / give-up policy.
- `external_event` inputs (a Discord message arrived) are also part of
  the rewind range; rewinding past them throws away information the
  outside world believes the agent received. Symmetric to outbound
  irreversibility.
- Cross-actor rewind: if actor A's rewind would invalidate a `send` it
  made to actor B, B has already mutated its state on that message.
  Likely answer: rewind that crosses an inter-actor `send` boundary is
  irreversible by default, same rule as external sends.

## Non-goals even when we implement

- **Distribution**. Actors are in-process. Cross-process actor systems
  (Erlang, Akka cluster) are out of scope; if needed later, the
  registry + `send` indirection is the seam to extend.
- **Supervision trees**. We do not adopt let-it-crash semantics. Errored
  actors surface via `errored` state and the operator decides; no
  automatic restart strategies.
- **Replacing spawn**. Spawn-tree stays the default. Actor mode is the
  *second* mode, not a replacement.
- **Time-travel debugging across irreversible actions.** Rewind is
  bounded by effect classification (see §6); we do not pretend the
  world is a pure function of the event log.

## Decision rule

Default everything to spawn-tree. Reach for actor mode only when one of
the trigger conditions above is concretely on the table, and document
*which* trigger justified it in the PR that lands the work.
