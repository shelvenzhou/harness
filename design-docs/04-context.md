# 04 — Context management

## Layered context

```
┌─ stable prefix ─────────────────────────────────────────┐   ← KV-cache-friendly
│ system_prompt                                           │
│ tool_specs                                              │
│ pinned_memory                                           │
│ compacted_summary (slot; only changes at compaction)    │
├─ live tail ─────────────────────────────────────────────┤   ← append-only
│ items from SessionStore projected through pruning rules │
└─────────────────────────────────────────────────────────┘
```

The live tail **only grows** between compaction boundaries. Pruning is
applied at projection time (read-through), not by rewriting the log.

## Pruning strategies

### Level 1 — deterministic rules (cheap, every tick)

Per event kind, at projection time:

| kind          | rule                                                      |
|---------------|-----------------------------------------------------------|
| `tool_result` | elide by strategy in [03-tools.md](03-tools.md); stash handle |
| `reasoning`   | keep only last 1–2 reasoning blocks verbatim; drop older  |
| `reply(internal=true)` | keep last one per turn; summarise older          |
| `preamble`    | keep verbatim; they're tiny and user-visible              |
| `spawn` / `subtask_complete` | render `[subtask <id> <status> reason=… budget=… turns=… toolCalls=… tokens=…] <summary>` so the parent's projection sees *both* the child's own conclusion and the termination metadata it needs to plan around |
| `user_input`  | keep verbatim                                             |
| `user_turn_start` | keep verbatim                                         |

### Level 1.5 — micro-compaction (sliding window, deterministic, hot path)

Inspired by Claude Code's micro-compact + Manus's "minimal recoverable
state" principle. Runs at the start of every sampling step, **without an
LLM call**.

**Window model.** Three zones in the event log:

```
[ cold zone (already micro-compacted) | warm zone (this pass) | hot tail (untouched) ]
                                       ↑                       ↑
                                       checkpoint              -keepRecent
```

- `keepRecent` (default 20): events at the tail left fully verbatim.
- `triggerEvery` (default 10): minimum new events past the previous
  checkpoint before a new pass runs. Without this gate the boundary would
  shift every tick and break prefix caching.
- A pass advances the checkpoint and processes the new warm zone.

**Per-tool_result transformation.** For each `tool_result` in the warm
zone whose serialised body exceeds `minBytes` (default 256) and is not
already elided:

1. Register a handle in `HandleRegistry` carrying the full payload.
2. Synthesise a one-line summary derived from the preceding `tool_call`
   (e.g. `[shell exit=0 stdout=12kb truncated]`).
3. `store.attachElision(threadId, eventId, {handle, kind: 'micro_compact', meta: {summary}})`.

After this, projection emits the event as a normal elided block; the
existing `restore(handle)` flow already pins it for inline rehydration on
the next sampling — no new code path needed.

**Why this preserves cache.** The checkpoint advances in chunks of
`triggerEvery`, not one event at a time. Between checkpoint advances the
projected prefix bytes are byte-identical, so the provider's KV cache
keeps hitting. Each advance pays one cache miss for the newly-frozen
chunk, then stabilises again.

**What stays untouched.** `tool_call` events themselves (the model needs
to see what it asked for); user turns; assistant replies/preambles;
reasoning blocks (Level 1's last-N rule already governs them); already-
elided events (idempotent).

**Recoverability.** Because the original `payload.output` stays in the
event log and the handle is in the registry, `restore(handle)` rehydrates
the full body on demand. The summary line preserves enough invariants
(tool name, exit/error, byte count) that the model can usually decide
whether to restore or move on.

**Trigger event.** Each non-empty pass appends a `compaction_event` with
`reason: 'auto'` so the diag layer surfaces what was compacted. The
metric fields are real estimates: `tokensBefore` / `tokensAfter` apply
a cheap byte-based proxy over the event log (with the warm-zone
overrides folded in), `durationMs` is wallclock, `retainedUserTurns`
counts `user_turn_start` + `user_input` events. The estimate is
intentionally lazy — we don't deep-clone the event log per pass; we
only re-render the events whose elision metadata changed in this pass.

### Level 2 — cold-path compaction (threshold-triggered)

`CompactionTrigger` fires `compact_request` past `compactionThreshold`
(byte estimate × 4/3 safety margin), with a cooldown to prevent
flapping. `CompactionHandler` consumes the request, runs the
configured `Compactor`, persists a `compaction_event`, and acknowledges
the trigger so the cooldown can release. An in-flight guard drops
duplicate requests on the same thread.

Today's `Compactor` strategy is a deterministic placeholder. A real
LLM-backed compactor lands later as a `spawn({role: 'compactor'})`
subagent that produces a structured summary; the handler interface
already accepts an injected `Compactor`, so the subagent strategy slots
in without touching wiring.

## Handles and `restore`

Every elided event carries `elided = {handle, kind, meta}`. The handle is
the event id in the SessionStore. `restore(handle)` is a tool that, when
called, re-emits the full payload as a new event visible to the model on
the next sampling. `restore` pins the handle for exactly the next
sampling; `clearPins()` runs after each step.

## Cross-thread context refs

Spawn argument `contextRefs: [{ threadId, fromEventId?, toEventId? }]`
lets a child thread see a slice of the parent's (or any source thread's)
event log without copying it physically. This replaces the older
`inheritTurns` parameter (which never landed in projection).

How it works:

- The child's projection layer prepends the referenced ranges to its own
  tail, in order. Source events keep their original timestamps and ids
  but render as the child's history.
- COW: the source thread keeps appending after the snapshot range; the
  child only sees `fromEventId .. toEventId`. No physical copy in
  `events.jsonl`.
- Active handles in the source range are copied into the child's
  `HandleRegistry` at spawn time. After that, the child's `restore`
  works the same as for its own elided events. (Cascading lookup into
  a parent registry was rejected: simpler to copy at spawn, the child
  keeps the snapshot world it was forked into.)
- Compaction interaction: source-side compaction does not invalidate
  the child's view — the child holds copies of the relevant handles
  and refers by event id, which is stable.

Use case: verifier / reviewer subagents that need the parent's recent
turns for grounding without inheriting the parent's whole prompt
budget. The parent picks the slice; nothing is implicit.

## Conservative token estimation

Approximate tokens from bytes (`bytes / 3`) and multiply by 4/3 safety
margin. The goal is to trigger compaction **before** the next request
would overflow, since we can't query the provider for an exact count.

## Rollback + compaction interaction

Rollback drops *turns*; compaction drops *item detail*. They commute as
long as:

- Rollback skips events marked by a `rollback_marker`.
- Compaction, when building the summary, ignores events within a rolled-back
  region.

If a compaction checkpoint exists at `atEventId` and a later rollback would
remove turns included in the summary, the checkpoint is invalidated and a
re-compaction must be re-run from the previous valid checkpoint. The
projection layer owns this check.

## Diagnostics

The projection step emits a `prompt_debug` artefact per sampling call:
the actual text going to the LLM, the tool spec list, the elided/visible
ratio. `pnpm dev --dump-prompts=./dump` enables it. See
[07-diagnostics.md](07-diagnostics.md).
