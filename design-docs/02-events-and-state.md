# 02 — Events and State

## Three-layer persistence

Borrowed from Codex's app-server protocol:

```
Thread   — durable session container; resume / fork / archive unit
 └── Turn — one user-input → agent-done cycle; rollback / compaction unit
      └── Item — fine-grained event: user msg, reasoning, reply, tool_call,
                 tool_result, spawn, subtask_complete, rollback_marker, …
```

- Thread id stable across resume.
- Turn has a lifecycle (`pending → running → {completed | interrupted | errored}`).
- Item is the atom: everything the UI renders, everything compaction sees,
  everything rollback counts.

Mapping to event bus: every `Item` that gets appended to the session log is
also published as an event on the bus. Subscribers (UI, tracing, tests) get
the same stream the store records.

## Event envelope

```ts
{
  id: string,                  // monotonic per thread
  threadId: string,
  turnId?: string,             // present for turn-scoped items
  parentTraceparent?: string,  // W3C traceparent, propagated into spawns
  kind: EventKind,             // discriminator
  payload: …,                  // kind-specific body
  createdAt: string,           // ISO-8601
  elided?: { handle: string, kind: string, meta: Record<string, unknown> },
}
```

`elided` is populated by the context projection when a full payload is
replaced by a handle. The raw log still has the full payload; the *view*
shown to the LLM sees the elided form.

## Event kinds (initial set)

Control-plane (from adapters / ops):

- `user_turn_start` — kicks off a new turn with the user's input
- `user_input` — steer into an active turn
- `interrupt` — cancel active turn
- `rollback` — drop last N turns from projection
- `fork` — create child thread
- `compact_request` — explicit compact trigger
- `shutdown`

Data-plane (from runner / executor / subagents):

- `reply` — text out to adapter (`internal?: boolean`)
- `preamble` — short "I'm about to …" announcement
- `reasoning` — native model reasoning block (kept separately for pruning)
- `tool_call` — `{toolCallId, name, args}`
- `tool_result` — `{toolCallId, ok, output, elided?, originalBytes?, bytesSent}`
- `spawn_request` — agent requested a subagent
- `subtask_complete` — child thread reached `done`
- `timer_fired`
- `external_event` — webhook, file watch, …
- `turn_complete` — `{status, summary?}`
- `compaction_event` — `{reason, durationMs, tokensBefore, tokensAfter}`
- `rollback_marker`

This list is meant to be extended in a principled way: new kinds get their
own discriminant + schema; projection + pruning rules are defined alongside.

## SessionStore responsibilities

- `append(event) → eventId` — monotonic per thread; atomic write.
- `readAll(threadId)` → async iterator of events.
- `readSince(threadId, cursor)` → tail stream.
- `writeMarker(threadId, marker)` — for rollback / fork markers.
- `fork(threadId, upToEventId) → newThreadId`.
- Persistence backend is pluggable; phase 1 ships an in-memory + JSONL
  (`.harness/<threadId>.jsonl`) backend. A SQLite / Redis backend can slot in
  without touching callers.

## Projection

The projection layer turns the append-only log into the prompt the LLM sees:

```
stable prefix:
  system_prompt
  tool_specs
  pinned_memory
  compacted_summary
live tail:
  filter(log, excluding rolled_back, excluding pre-compaction items)
  apply pruning rules (see 04-context.md)
```

Projection is pure + deterministic per (log, compaction checkpoint). This is
what makes the prefix cache actually stable: until the next compaction
boundary, prefix bytes do not change.

## Checkpoints

Compaction produces a checkpoint:

```
Checkpoint {
  threadId,
  atEventId,                  // all items ≤ atEventId are replaced by summary
  summary: CompactedSummary,  // see 04-context.md
  createdAt,
}
```

Projection reads the latest checkpoint ≤ tail-cursor and only feeds items
after `atEventId`. Rollback sets a rollback marker the projection respects.

## Mailbox phases

`ActiveTurn.MailboxDeliveryPhase`:

- `CurrentTurn` — events delivered here are drained before the next sampling
  within this turn.
- `NextTurn` — events queued here wait for the current turn to terminate,
  then seed the next turn.

Deliveries default to `CurrentTurn` when a turn is running; to `NextTurn`
when between turns. The sender may explicitly target (rare; only used by
rollback / fork markers that must survive the boundary).
