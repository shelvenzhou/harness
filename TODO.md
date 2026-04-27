# TODO

Snapshot of what is **stubbed**, **partial**, or **missing** after the
phase-1 scaffold. Pair with [design-docs/08-roadmap.md](design-docs/08-roadmap.md)
for the planned order.

Legend: ⚪ not started · 🟡 partial · 🔴 stub (compiles, returns fake result)

---

## LLM providers

- 🟡 **OpenAIProvider** — real streaming + tool calls + usage reporting
  (prompt/completion/cached tokens) working. Missing:
  - ⚪ `reasoning_delta` emission (newer reasoning models have a
    `reasoning` field; currently dropped).
  - ⚪ preamble heuristic: channel is always `reply`; detect the
    short-leading-chunk pattern and emit `channel: "preamble"`.
  - ⚪ retry-on-transport-error budget.
  - ⚪ structured output (response_format) passthrough.
- ⚪ **AnthropicProvider** — deleted in the OpenAI switch; add back with
  `cache_control` markers + `cache_edits` suppression (hot-path context
  pruning).
- ⚪ **GeminiProvider / Bedrock / local**. OpenAI-compatible endpoints
  already work via `OPENAI_BASE_URL`; native adapters come later.

## Context management

- 🟡 **Pruning** (`src/context/pruning.ts`) — Level-1 deterministic rules
  done. Missing:
  - ⚪ `keepLastReasoning` is threshold-based only; no summarisation of the
    dropped reasoning.
  - ⚪ inline-vs-elide decision respects `inlineToolResultLimit` but does
    not consider the *next* sampling's estimated token budget.
- 🟢 **MicroCompactor** (`src/context/microCompactor.ts`) — hot-path
  sliding-window micro-compaction; runs deterministically before each
  sampling step, elides oversized tool_results in the warm zone via
  attachElision + handle. Restore-recoverable.
- 🔴 **StaticCompactor** — placeholder semantic compactor; the
  `Compactor` strategy `CompactionHandler` runs by default. Phase 2:
  replace with a `spawn({role: 'compactor'})` subagent producing a
  real `CompactedSummary`. The handler interface already accepts an
  injected Compactor, so the subagent strategy slots in without
  touching wiring.
- 🟢 **Compaction trigger + handler (cold path)** —
  `CompactionTrigger` fires `compact_request` past the threshold (with
  cooldown). `CompactionHandler` consumes the request, runs the
  configured `Compactor`, persists a `compaction_event`, and
  acknowledges the trigger so the cooldown can release. An in-flight
  guard drops duplicate requests on the same thread. Bootstrap
  installs the handler automatically alongside the trigger.
- ⚪ **Cache-edits path** — `cacheEdits` field on SamplingRequest is
  plumbed but no provider consumes it; no logic decides when to use hot
  vs. cold path.
- ⚪ **GhostSnapshots** — type defined, never produced or consumed.
- 🟢 **`restore` handle rehydration** — `restore` pins the handle for
  exactly the next sampling; `clearPins()` runs after each step, so the
  documented "drop back after next cycle" rule already holds.

## Runtime

- 🟡 **AgentRunner** — happy path works. The `wait` transport now
  suspends the turn into `awaiting_event` and resumes when a matching
  event arrives (`user_input` / `subtask_complete:<id>` / `tool_result`
  / `kind` / `timer`). Each runner owns a `Scheduler`; `wait(timer,
  delayMs)` schedules a real one-shot timer that publishes
  `timer_fired`, and `wait.timeoutMs` schedules a private fallback
  timer that emits `external_event{source:"wait_timeout"}` so a
  bounded wait can never deadlock. Pending timers are cancelled on
  turn complete / interrupt / wakeup. Interrupt classification routes
  a user-cut-off sampling to `turn_complete{interrupted}` instead of
  the historical `errored:model_returned_no_actions`. Missing:
  - ⚪ provider stream cancellation surfaces back to the user via the
    `interrupt` event the adapter renders, but no separate
    "interrupting…" lifecycle event is emitted by the runner — the
    bus interrupt envelope is the source of truth.
  - ⚪ `rollback` / `fork` event handling — events are filtered out of
    projection but the runner does not respond to them.
- 🟡 **SubagentPool** — `spawn` creates a child, returns its id, and
  parent receives `subtask_complete` when the child's turn ends.
  Budgets (`maxTurns`/`maxToolCalls`/`maxWallMs`/`maxTokens`) enforced
  as hard caps; structural caps (`maxDepth`, `maxSiblingsPerParent`,
  `maxConcurrentTotal`) reject violating spawns at pre-flight via
  `SpawnRefused`, surfaced to the LLM as `tool_result.ok=false` with
  the cap name in `error.kind`. Parent → descendant interrupt
  propagation works.
  Missing:
  - ⚪ `inheritTurns` — currently recorded but never copies parent turns.
  - ⚪ Role-aware system prompts — stub concatenates `[role: foo]`.
  - ⚪ Soft 80%-warn before the hard cap fires (today the model only
    learns about the budget when the child gets cut off). See
    [01-runtime.md](design-docs/01-runtime.md#subagent-budgets-and-interrupt-propagation).
- 🟢 **Scheduler** — owned per AgentRunner, drives `wait(timer)` and
  `wait.timeoutMs`. No cron yet (one-shot delays only).

## Tools

- 🟡 **`shell`** — real. `child_process.spawn` with cwd / timeout / byte-cap
  / signal-group kill / handle elision. Missing: custom env passthrough,
  stream progress events (tools can't emit intermediate events today),
  explicit stdin support.
- 🟡 **`write`** — overwrite mode real; `mode: 'patch'` returns
  `not_implemented`.
- 🟡 **`web_fetch`** — real (undici fetch). GET/HEAD, byte cap, timeout,
  handle elision. Missing: auth headers, POST body, pluggable transport.
- 🔴 **`web_search`** — still a stub; needs a search backend adapter
  (Brave / Google / DDG).
- 🟢 **`memory`** — refactored onto a `MemoryStore` interface
  (`src/memory/types.ts`). Three backends ship:
  - `InMemoryStore` — KV + pinning + keyword search; process-scoped.
  - `JsonlMemoryStore` — append-only WAL on disk; persistent,
    single-process. CLI: `HARNESS_MEMORY_FILE=...`.
  - `Mem0Store` — semantic search + LLM fact extraction; cross-
    process. CLI: `MEM0_API_KEY=...` (+ optional `MEM0_BASE_URL`,
    `MEM0_USER_ID`). Live e2e in `tests/e2e/mem0Live.test.ts`,
    skipped unless `HARNESS_E2E=1` + key present.
  Pinned entries auto-injected into the system prefix on every
  sampling. Children share the parent store.
  Missing:
  - ⚪ Auto-`ingest` of recent turns into memory at turn boundaries.
  - ⚪ Pagination over mem0 `getAll` (currently first page only).
  - ⚪ `confidence` + `provenance` metadata on entries; runtime-assigned
    (LLM `memory.set` → `speculative`, trusted-adapter ingest →
    `user_asserted`, verifier subagent → `verified`). Projection layer
    must render `<memory confidence="…">` framing. See
    [09-memory.md](design-docs/09-memory.md#confidence-and-provenance).
  - ⚪ Async verifier subagent — sweeps speculative entries on a
    cadence, promotes to `verified` or downgrades / deletes.
- 🟡 **`restore`** — pins a handle but projection's rehydration rules
  are incomplete (see context).
- 🟢 **`wait`** — yield semantics work for `user_input` /
  `subtask_complete` / `tool_result` / `kind`. `timer` matcher
  schedules a real one-shot timer when given `delayMs`; `timeoutMs`
  on any matcher schedules a fallback timer that wakes the wait via
  `external_event{source:"wait_timeout"}`. Malformed `timer` waits
  return `tool_result.ok=true` with `scheduled=false` + an error
  string the model can react to.
- 🟡 **`spawn`** — composition works, parent sees subtask_complete.
  All four budget dimensions (`maxTurns`/`maxToolCalls`/`maxWallMs`/
  `maxTokens`) enforced; structural caps reject overage spawns
  pre-flight. Missing: `inheritTurns` (recorded, never applied).

## Store

- 🟡 **JsonlSessionStore** — append-only persistence works.
  `attachElision` now writes to a sidecar `elisions.jsonl` so cold
  reload reproduces the elided shape. `SessionStore.fork(source,
  untilEventId, newThreadId)` copies events up to a boundary into a
  new thread (foundation for cold-path snapshots and future
  rollback). Missing:
  - ⚪ Compaction of the events.jsonl file itself (it grows forever).
- ⚪ **SQLite backend** — designed; not implemented.

## Adapters

- 🟡 **TerminalAdapter** — single-thread binding only. `/interrupt`
  works, SIGINT is now wired (1st: publish interrupt; 2nd within
  `doubleInterruptMs` window: graceful adapter shutdown via
  `whenShutdown()`), and `interrupt` events are rendered inline so
  the unwind window has visible feedback. Multi-thread binding is
  the remaining item.
- ⚪ **DiscordAdapter / TelegramAdapter / HTTPAdapter**. Interface and
  docs exist; no implementations.
- ⚪ Multi-adapter bootstrap (one runtime, N adapters).

## Diagnostics

See commit B for what just landed. Still missing:

- ⚪ OTEL exporter wiring. `traceparent` is minted and propagated to
  subagents, but no spans are emitted.
- ⚪ Permission-review audit log (needs sandbox work first).
- ⚪ Cache-hit tracking — requires a provider that exposes cached token
  counts; OpenAI reports `cached_tokens` when long prefixes hit.
- ⚪ Compaction metrics plumbing: `CompactionEvent` type exists and is
  accepted by the bus, but StaticCompactor doesn't emit one.

## Actor mode (deferred — see [10-actor-mode.md](design-docs/10-actor-mode.md))

Whole document is deferred until a trigger condition lands; gaps
listed here so the TODO is the single source of truth.

- ⚪ `ActorPool` (sibling of SubagentPool) with per-turn budget,
  hibernation idle policy, explicit stop.
- ⚪ Actor registry + `send(actorRef, msg)` primitive.
- ⚪ Lifetime circuit breakers on `ActorBudget`:
  `maxLifetimeTokens` / `maxLifetimeUsd` / `ttlMs` / `idleTtlMs`.
- ⚪ `senderState` on `SendOpts` — correlation id + goal snapshot
  restorable via `restore(handle)`. Fixes "B replied but A forgot why".
- ⚪ Optional state machine layer over `AgentRunner`.
- ⚪ `external_event` framing in projection (untrusted-input boundary).
- ⚪ `forkTree` / `rewindTree` with effect-classified tool tags.

## Sandbox / permissions

- ⚪ **All of it.** Designed in
  [design-docs/00-overview.md](design-docs/00-overview.md#5-security--sandbox-later-interface-today);
  deferred to phase 4. The single `Executor` indirection is the only
  escape hatch that will need changes.

## Testing

- 🟡 **Unit + smoke tests** — 41 active, 2 e2e skipped. Gaps:
  - ⚪ `HandleRegistry` pinning / clearPins semantics.
  - ⚪ `promptDebug.renderPromptText` snapshot.
  - ⚪ `Scheduler` timer firing + cancellation.
  - ⚪ Compaction round-trip smoke test.
- 🟡 **E2E** — 1 real OpenAI round-trip; add one that exercises a tool
  call through the model.

## Docs

- 🟡 Phase-1 status in [README](README.md) is current.
- ⚪ Tutorial for "adding a new LLM provider" (today only has tools /
  adapters).
- ⚪ `design-docs/07-diagnostics.md` needs a refresh now that the diag
  layer exists.
