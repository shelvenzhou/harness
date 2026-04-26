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

## Confidence and provenance

Letting the LLM directly write into long-term memory is dangerous:
the model is happy to commit a confident-sounding inference as if it
were an observed fact, and once that fact is `pinned` it will be
re-injected into every future sampling — poisoning the well across
sessions. The cost of a wrong `memory.set` compounds; the cost of
labelling memories conservatively is small.

We therefore tag every entry with a confidence level and provenance:

```ts
interface MemoryEntry {
  // existing
  key: string;
  value: unknown;
  pinned?: boolean;
  tags?: string[];

  // new
  confidence: 'speculative' | 'verified' | 'user_asserted';
  provenance: {
    threadId: ThreadId;
    eventId?: EventId;        // event that produced this entry
    sourceTool?: string;      // 'memory.set' (LLM) | 'memory.ingest' | adapter id
    createdAt: number;        // unix ms
  };
  verifiedAt?: number;        // last time a verifier confirmed this entry
}
```

Confidence levels:

- **`user_asserted`** — directly transcribed from a trusted user input
  (terminal / IDE adapter), e.g. the user typed "remember that my
  preferred shell is fish". Set by the runtime when the source event is
  a trusted `user_input`, never by the LLM itself.
- **`verified`** — confirmed by a verifier subagent (see below) or by
  a tool whose output is structurally trustworthy (e.g. a `read` of a
  config file followed by `memory.set` of the read value).
- **`speculative`** — the default for any LLM-emitted `memory.set`. The
  model's claim, not a fact.

The `memory` tool MUST NOT let the LLM set `confidence` directly. The
runtime assigns it based on the source event:

| source                                      | assigned confidence |
|---------------------------------------------|---------------------|
| `memory.set` from an LLM tool_call          | `speculative`       |
| `memory.ingest` from a trusted adapter      | `user_asserted`     |
| `memory.set` issued by a verifier subagent  | `verified`          |
| `memory.set` whose value is a verbatim copy of a `read` / `web_fetch` result tagged pure | `verified` (auto-promoted) |

### Projection rendering

The context projection layer ([04-context.md](04-context.md)) renders
pinned entries with an explicit framing tag so the model can weight
them differently:

```
<memory key="user.shell" confidence="user_asserted">fish</memory>
<memory key="proj.deploy_target" confidence="speculative" since="2026-04-12">
  staging.example.com
</memory>
```

The `<memory confidence="speculative">` framing is a contract with the
model: anything inside is the model's prior inference, not ground
truth, and may be wrong. This is structurally analogous to the
`<external source="…">` framing for untrusted input
([10-actor-mode.md §5](10-actor-mode.md)).

### Async verifier

A verifier-before-write design (synchronous two-phase commit) adds
latency on the critical path of every `memory.set`. We adopt a lighter
shape: the write lands as `speculative` immediately, and an **async
verifier actor** (or scheduled subagent) sweeps speculative entries on
its own cadence:

- For each speculative entry older than a threshold or above an
  importance score (e.g. `pinned: true` accelerates verification),
  the verifier re-derives the claim from primary sources (re-read the
  file, re-query the API, re-check the conversation that produced it).
- Pass → promote to `verified`, set `verifiedAt`.
- Fail → either downgrade-and-tag (`tags: ['contested']`) or delete,
  per policy. Deletion is preferred for simple factual claims; tagging
  is preferred when the original claim is still useful as a hypothesis.

The verifier itself is just another agent (`spawn({role: 'verifier'})`
or a persistent actor in actor mode), so it inherits all the budget
and circuit-breaker machinery.

### What this lets us do

- The "I told it my name in session 1" case still works — `user_asserted`
  is durable and high-confidence.
- The "the model decided to pin a wrong inference" case is bounded:
  speculative memories are visibly speculative to the model on the next
  read, and either get verified or aged out.
- Cost on the write path is zero (just metadata); cost on the read path
  is one extra attribute in the projection template.

## Built-in tool surface

The `memory` tool (`src/tools/impl/memory.ts`) is thin glue over the
injected `MemoryStore`:

| op | required args | notes |
|---|---|---|
| `get` | `key` | Returns value, found flag, and `confidence` |
| `set` | `key`, `value` | `pinned`, `tags` optional. `confidence` is **assigned by the runtime**, not the caller — LLM-issued sets are always `speculative` |
| `delete` | `key` | |
| `list` | — | `topK` caps result count; results carry `confidence` |
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
