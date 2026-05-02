# 10 — Actor mode (deferred stub)

> **Status: deferred.** Do not implement until a concrete trigger condition
> lands. Until then, the spawn tree + per-thread mailbox in
> [01-runtime.md](01-runtime.md) is sufficient. Premature implementation
> trades debuggability (call stacks become event flows) for nothing.

## What's missing today

Spawn-tree gives us threads with their own `AgentRunner`, per-turn mailboxes
(`CurrentTurn` / `NextTurn`), an append-only `SessionStore`, a typed
`EventBus`, and a `parentThreadId` tree. Actor mode adds:

1. **`send(actorRef, message, opts)`** — post into another thread's mailbox
   by name, not just parent ↔ child. Resolves `actorRef` via a registry,
   delivers via the existing `ActiveTurn` mailbox machinery. Phase
   (`CurrentTurn` / `NextTurn`) and `interrupt` flag mirror the per-thread
   semantics, lifted to inter-actor scope.
2. **Actor registry** — in-process name service mapping stable names
   (`discord:#general`, `approver:legal`) to threadIds. Recoverable from
   the SessionStore (each actor's first event records its name).
3. **`ActorPool`** — sibling of `SubagentPool`. Long-lived lifecycle:
   per-turn budget (not lifetime), idle hibernation via Level-2
   compaction, explicit `actor_stop` instead of `done`.
4. **Optional state machine layer** — opt-in `ActorStateMachine` that
   filters tool spec list per-state. The default coding agent stays
   stateless / fully LLM-driven.

## Trigger conditions

Land actor mode when **any** is true and the spawn-tree workaround
hurts:

1. A long-lived adapter (Discord watcher, file watcher, MCP long-poll)
   needs its own LLM-driven loop, not just an I/O bridge.
2. Two agents need to talk without a parent/child relationship.
3. Crash recovery becomes structurally cleaner as mailbox replay than
   the current ad-hoc rebuild.
4. A workflow keeps re-deciding the same control-flow question every
   turn ("am I waiting for approval?") and would benefit from being a
   state machine where the LLM only chooses *within* a state.

The PR introducing actor mode must state which trigger justified it.

## Lifetime caps already lifted into spawn-tree

Actor mode originally motivated lifetime token caps and structural
fan-out caps (`maxDepth`, `maxSiblingsPerParent`, `maxConcurrentTotal`).
Those have been moved to [01-runtime.md](01-runtime.md#subagent-budgets-and-interrupt-propagation)
and apply to spawn-tree today; they do not need actor mode.

## Untrusted input boundary

The one piece that, if external endpoints expose into mailboxes
*before* full actor mode lands, must come first: projection
(see [04-context.md](04-context.md)) must distinguish trusted
`user_input` from untrusted `external_event`, framed visibly as
`<external source="…">…</external>`. Without it, a Discord
prompt-injection looks identical to a user instruction.

## Cross-actor cognition

Three problems this doc once enumerated and how they look today:

- **"B replied but A forgot why."** Mitigated by `senderState` (correlation
  id + goal snapshot key restorable via the existing `restore(handle)`
  machinery from [04-context.md](04-context.md)). Voluntary; needed
  only for async exchanges where the sender's projection may have
  moved on.
- **Cross-thread context sharing.** Solved separately by `contextRefs`
  on `spawn` (see [04-context.md](04-context.md#cross-thread-context-refs)) —
  not actor mode. The COW projection extension covers verifier /
  reviewer subagents that need to see what their parent saw.
- **Tree-level fork / rewind.** Out of scope here. The hard part is
  not the data structure; it's that rewind across irreversible side
  effects (`rm -rf`, paid API calls, sent messages) is structurally
  unsound. Will be a separate doc when concretely needed.

## Non-goals even when we implement

- **Distribution.** Actors are in-process. Cross-process actor systems
  are out of scope.
- **Supervision trees.** No let-it-crash semantics; errored actors
  surface and the operator decides.
- **Replacing spawn.** Spawn-tree stays the default.
