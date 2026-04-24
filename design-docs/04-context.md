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
| `spawn` / `subtask_complete` | keep handles + summary; elide body         |
| `user_input`  | keep verbatim                                             |
| `user_turn_start` | keep verbatim                                         |

### Level 2 — LLM compaction (expensive, threshold-triggered)

Trigger when:

- `estimatedPromptTokens > compactionThreshold` (conservative estimate × 4/3)
- K consecutive turns produced no new decisions (heuristic)
- Explicit `compact_request`

The compactor is a subagent: `spawn({role: 'compactor', inheritTurns: all})`.
It produces a `CompactedSummary`:

```ts
interface CompactedSummary {
  reinject: { systemReinject: string; environment?: string };
  summary: string;                       // Memento
  recentUserTurns: UserTurnExcerpt[];    // last K verbatim
  ghostSnapshots: GhostSnapshot[];       // opaque binary / structural state
  activeHandles: HandleRef[];            // handles still live
}
```

A new `Checkpoint` is appended; from that point the stable-prefix
`compacted_summary` slot is swapped. One cache miss paid; prefix stabilises
again.

## Cold vs. hot cache paths (microCompact)

Claude Code's trick. We mirror it:

- **Hot cache** (short idle since last call, cache likely warm): do not
  rewrite message bytes. Use the provider's logical-hide capability
  (Anthropic `cache_edits: {clear_tool_uses, clear_thinking}` or equivalent).
  Physically send the full history → 100% prefix cache hit; logically the
  model sees the pruned view.
- **Cold cache** (long idle since last call): rewrite the in-memory message
  content to the elided form. Fewer bytes on the wire. Cache was going to
  miss anyway.

Choice is per-request. `LlmProvider.sample` exposes a `cacheEditsSupported`
capability; when absent, only the cold-cache path is used.

## Handles and `restore`

Every elided event carries `elided = {handle, kind, meta}`. The handle is
the event id in the SessionStore. `restore(handle)` is a tool that, when
called, re-emits the full payload as a new event visible to the model on its
next sampling. The rehydrated event itself is subject to pruning rules so a
reckless agent can't pin a huge blob indefinitely — after its next tool_call
cycle it goes back to elided form unless pinned (`memory.set`).

## Conservative token estimation

Approximate tokens from bytes (`bytes / 3`) and multiply by 4/3 safety
margin. The goal is to trigger compaction **before** the next request would
overflow, since we can't query the provider for an exact count.

## Ghost snapshots

Some items don't round-trip through text cleanly: a PTY session id, an
opened MCP resource handle, a file-tree diff scoped to a subagent. These
are `GhostSnapshot`s: opaque tokens the compactor must preserve verbatim
across boundaries so the model (or the tool layer) can still reference them.

Ghost snapshots are stored alongside the checkpoint; they are not text
tokens in the prompt.

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
