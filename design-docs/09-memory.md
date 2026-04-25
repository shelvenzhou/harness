# 09 — Memory

The harness needs facts that outlive a thread / process: who the user
is, project conventions, plans the model decided to remember, etc. The
memory subsystem is **interface-first, backends pluggable**.

## Why two access paths

Different backends model memory very differently. Fixing on one shape
locks us out of the others:

- **In-process Map** — explicit KV. No persistence, no search.
- **JSONL on disk** — explicit KV, persistent across processes on one
  machine, substring search.
- **mem0** ([github.com/mem0ai/mem0](https://github.com/mem0ai/mem0)) —
  ingest message lists; LLM extracts facts; vector search; cross-process;
  scoped by user / agent / run.
- **SQLite + local embedding** — semantic search without external service.

The interface (`src/memory/types.ts`) therefore exposes both:

1. **KV path** (`get` / `set` / `update` / `delete`) — explicit,
   deterministic. Suits the agent saying "remember user.name = shelven".
2. **Ingestion path** (`ingest`) — feed a slice of conversation; backends
   that support fact extraction (mem0) distil it.
3. **Universal `search`** — works regardless of how data landed.

Plus a `capabilities` flag so callers can branch instead of silently
degrading: `{semanticSearch, ingestion, persistent, crossProcess}`.

## Namespacing

Borrowed from mem0: three orthogonal dimensions on every operation.

```ts
interface MemoryNamespace {
  userId?: string;    // a real person or service account
  agentId?: string;   // a logical role (e.g. 'researcher')
  threadId?: ThreadId; // this run
}
```

Plus a coarse `scope: 'global' | 'thread'` for callers that don't want
to think about namespaces. Backends that only model one of these
dimensions ignore the rest.

## Pinning

An entry with `pinned: true` is auto-included in the **stable prefix**
of every sampling request — see `AgentRunner.buildRequestWithStats`. The
model sees it without having to call `memory.get`.

This is the answer to "I told it my name in session 1, why doesn't it
remember in session 2": pin the fact, and persistent backends keep it
across sessions.

## Built-in tool surface

The `memory` tool (`src/tools/impl/memory.ts`) is thin glue over the
injected `MemoryStore`:

| op | required args | notes |
|---|---|---|
| `get` | `key` | Returns value, found flag |
| `set` | `key`, `value` | `pinned`, `tags` optional |
| `delete` | `key` | |
| `list` | — | `topK` caps result count |
| `search` | `query` | Backend-dependent: keyword vs semantic |
| `pin` / `unpin` | `key` | Toggles prefix injection |

If no store is wired (`ctx.services.memory === undefined`) the tool
returns `{ok: false, error: 'unsupported'}` so the model knows memory
is disabled rather than silently no-oping.

## Subagent sharing

Children spawned via `SubagentPool` share the parent's `MemoryStore`
instance — set via `SubagentPoolDeps.memory`. A child's `memory.set`
is visible to the parent on the next sampling. This matches mem0's
shared-store semantics and makes role-based sub-agents (researcher,
verifier, …) usefully collaborative.

## mem0 wiring plan

`Mem0Store` is stubbed in `src/memory/mem0Store.ts`. To turn it on:

1. `pnpm add mem0ai`, dynamic-import the client.
2. Map `MemoryNamespace` → mem0's `userId / agentId / runId`.
3. KV path: round-trip via metadata — `set(key, value)` becomes
   `mem0.add` with `{metadata: {kvKey: key}}`; `get(key)` is a metadata
   filter. mem0 has no native key-based lookup.
4. `ingest(messages)` → `mem0.add(messages, namespace)` — straight
   passthrough; this is mem0's strong suit.
5. Auth: `MEM0_API_KEY` (cloud) or `MEM0_BASE_URL` (self-hosted).

## Persistence

The default backend (`InMemoryStore`) is process-scoped. For
cross-session memory the user picks a persistent backend at bootstrap:

```ts
bootstrap({
  provider,
  systemPrompt,
  memory: new JsonlMemoryStore({root: '.harness/memory.jsonl'}),
});
```

The JSONL backend is not implemented yet; mem0 is the next likely
target. The interface is stable enough that adding either is purely
implementation work, no caller changes.
