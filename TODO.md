# TODO

Snapshot of what is **stubbed**, **partial**, or **missing** after the
phase-1 scaffold. Pair with [design-docs/08-roadmap.md](design-docs/08-roadmap.md)
for the planned order.

Legend: ⚪ not started · 🟡 partial · 🔴 stub (compiles, returns fake result)

---

## LLM providers

- 🟡 **OpenAIProvider** — real streaming + tool calls working. Missing:
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
- 🔴 **StaticCompactor** — replaces prior events with a placeholder
  summary. Phase 2: replace with a `spawn({role: 'compactor'})` subagent
  producing a real `CompactedSummary`.
- ⚪ **Compaction triggers** — threshold computation exists
  (`estimateTokens`) but nothing subscribes + triggers `compact_request`.
- ⚪ **Cache-edits path** — `cacheEdits` field on SamplingRequest is
  plumbed but no provider consumes it; no logic decides when to use hot
  vs. cold path.
- ⚪ **GhostSnapshots** — type defined, never produced or consumed.
- ⚪ **`restore` handle rehydration** — `restore` tool pins the handle,
  but projection currently always inlines pinned handles without respecting
  the documented "drop back after next cycle" rule. Needs a TTL.

## Runtime

- 🟡 **AgentRunner** — happy path works. Missing:
  - ⚪ `wait` action proper implementation — currently returns a fake
    tool_result; never actually blocks the turn on a matching event.
  - ⚪ interrupt propagation: `abortCtl.abort()` is called but the next
    sampling request is not cancelled with user-visible feedback yet.
  - ⚪ `rollback` / `fork` event handling — events are filtered out of
    projection but the runner does not respond to them.
- 🟡 **SubagentPool** — `spawn` creates a child and returns its id.
  Missing:
  - ⚪ Budget enforcement (`maxTurns`/`maxToolCalls`/`maxWallMs`).
  - ⚪ `inheritTurns` — currently unused; child always starts fresh.
  - ⚪ Parent `subtask_complete` delivery — child emits `turn_complete`
    but the pool doesn't translate that into the parent's event stream.
  - ⚪ Role-aware system prompts — stub concatenates `[role: foo]`.
- ⚪ **Scheduler** — class exists, not wired to `wait(timer)` actions;
  no cron.

## Tools

- 🔴 **`shell`** — stub; returns `[stub-shell] would run: …`. Phase 2:
  `child_process.spawn` with cwd / env / timeout / byte-cap.
- 🟡 **`write`** — overwrite mode real; `mode: 'patch'` returns
  `not_implemented`.
- 🔴 **`web_fetch`** — stub; returns placeholder body.
- 🔴 **`web_search`** — stub; returns empty results.
- 🟡 **`memory`** — in-process kv + `list` real; `search` is a stub.
  Not persistent; does not survive process restart.
- 🟡 **`restore`** — pins a handle but projection's rehydration rules
  are incomplete (see context).
- 🟡 **`wait`** — schema + tool-call accepted; actual yield semantics
  missing (see runtime).
- 🟡 **`spawn`** — composition works; budget / inheritTurns unused.

## Store

- 🟡 **JsonlSessionStore** — append-only persistence works. Missing:
  - ⚪ `attachElision` is memory-only; not rewritten into the JSONL.
  - ⚪ No compaction of the events.jsonl file itself (it grows forever).
  - ⚪ No `fork()` helper to copy an event log up to a boundary.
- ⚪ **SQLite backend** — designed; not implemented.

## Adapters

- 🟡 **TerminalAdapter** — single-thread binding only. `/interrupt` is
  exposed but its UX (double-Ctrl-C → shutdown) is not wired.
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

## Sandbox / permissions

- ⚪ **All of it.** Designed in
  [design-docs/00-overview.md](design-docs/00-overview.md#5-security--sandbox-later-interface-today);
  deferred to phase 4. The single `Executor` indirection is the only
  escape hatch that will need changes.

## Testing

- 🟡 **Unit tests** — 23 passing; gaps:
  - ⚪ `HandleRegistry` pinning / clearPins semantics.
  - ⚪ `promptDebug.renderPromptText` snapshot.
  - ⚪ `Scheduler` timer firing + cancellation.
  - ⚪ `SubagentPool.spawn` end-to-end (parent sees `subtask_complete`).
- 🟡 **Smoke tests** — 2 passing; needs one for compaction round-trip.
- 🟡 **E2E** — 1 real OpenAI round-trip; add one that exercises a tool
  call through the model.

## Docs

- 🟡 Phase-1 status in [README](README.md) is current.
- ⚪ Tutorial for "adding a new LLM provider" (today only has tools /
  adapters).
- ⚪ `design-docs/07-diagnostics.md` needs a refresh now that the diag
  layer exists.
