# TODO

Snapshot of what is **stubbed**, **partial**, or **missing** after the
phase-1 scaffold. Pair with [design-docs/08-roadmap.md](design-docs/08-roadmap.md)
for the planned order.

Legend: ⚪ not started · 🟡 partial · 🔴 stub (compiles, returns fake result)

---

## Self-bootstrap (top priority)

Full spec: [design-docs/11-self-update.md](design-docs/11-self-update.md).
This track is now ahead of every other Phase 2 polish item — see
the rationale in [08-roadmap.md](design-docs/08-roadmap.md).

### M1 — CodingAgentProvider + per-spawn provider plumbing

- ⚪ Extend `SamplingDelta.end.stopReason` union with
  `'quota_exhausted'` (payload: optional `resetAt`). Update
  `actionParser` and `agentRunner` translation to `turn_complete.reason`.
- ⚪ New `src/llm/codingAgentProvider.ts`:
  - cc first (`claude -p <task> --output-format stream-json …`),
    codex shape-compatible.
  - parse `assistant` / `thinking` / `system_init` / terminal
    events → `SamplingDelta`.
  - drop cc's internal `tool_use` / `tool_result` (black-box from
    parent's POV).
  - SIGTERM-on-abort with grace window; mirror the group-kill in
    `src/tools/impl/shell.ts`.
  - capture `providerSessionId` from `system_init`; expose via getter.
- ⚪ `SpawnRequestInfo` adds `provider?: string`, `cwd?: string`,
  `providerSessionId?: string`, `continueThreadId?: ThreadId`.
- ⚪ `spawn` tool schema (`src/tools/impl/spawn.ts`) gains the same
  four fields. Description spells out cc/codex use-case + the
  `providerSessionId` reuse rule.
  - `provider` / `cwd` / `providerSessionId` are **fully wired** in
    M1 — multi-turn design / iteration with cc requires the
    sessionId to be threaded to `--resume` on every continuation
    spawn.
  - `continueThreadId` is **schema-only** in M1 (pool ignores it);
    full reopen semantics land in M2.
- ⚪ `SubagentPoolDeps.providerFactories?: Record<string, (req) => LlmProvider>`;
  factory for cc instantiates per-spawn `CodingAgentProvider` with
  `req.cwd`. Default global provider remains the OpenAI
  orchestrator path.
- ⚪ `SubtaskCompletePayload.providerSessionId?: string` populated
  from the captured value.
- ⚪ `bootstrap.ts` registers the cc factory under env (e.g.
  `HARNESS_CC_BIN`, cc's own auth env). Codex factory stub behind a
  flag.
- ⚪ E2E: minimal session where main agent spawns cc to write a
  fixed file in a temp sibling dir; assert `subtask_complete` +
  file content.

### M2 — Quota coordination

- ⚪ `CodingAgentProvider` recognises ratelimit / quota terminal
  events from cc's stream-json; emits
  `end{stopReason:'quota_exhausted', resetAt}`.
- ⚪ Per-provider-id `QuotaState{ resetAt?, kind:'session'|'weekly' }`
  registry (module-scoped singleton keyed by provider id).
- ⚪ `SubagentPool.spawn` short-circuits when `QuotaState.resetAt > now`:
  no CLI process, synthesise an immediate
  `subtask_complete{reason:'quota_exhausted', resetAt}` to the parent.
- ⚪ One `Scheduler` timer per `(providerId, resetAt)` (dedupe on
  unchanged resetAt); on fire, publish
  `external_event{source:'provider_ready', provider, resetAt}`.
- ⚪ `continueThreadId` reopen path implemented in `SubagentPool`
  (was schema-only in M1): require thread exists, no live runner,
  append fresh `user_turn_start`, restart runner.
- ⚪ Verify `wait` `kind` matcher + filter (`source`, `provider`)
  is sufficient to single out `provider_ready`; extend lightly if
  not.
- ⚪ E2E with a fake cc binary that emits a quota event; parent
  waits on `provider_ready`; parent re-spawns with
  `providerSessionId` + `continueThreadId`.

### M3 — Usage introspection

- ⚪ `LlmProvider.usage?(): Promise<UsageReport | 'unsupported'>`.
- ⚪ `OpenAIProvider.usage()` → `'unsupported'`.
- ⚪ `CodingAgentProvider.usage()` returns latest cached snapshot
  parsed out of stream events (no extra CLI invocation).
- ⚪ `SubtaskCompletePayload.providerUsage?: UsageReport`; pool
  attaches at child exit.
- ⚪ `usage` tool output gains optional `providerUsage` block (only
  inside spawned children whose provider supports it).

### M4 — Operator playbook (no code)

- ⚪ Author and pin `memory:playbook:self-update` covering:
  - role decision tree (designer / implementer / reviewer; R2b
    matrix in 11-self-update.md)
  - R3 step-1 acceptance checklist (tests + e2e + diff review +
    docs sync)
  - quota / weekly-limit handling (R2a)
  - PR opening flow (R4)
- ⚪ End-to-end demo: operator says "add a Telegram adapter";
  observe full flow → PR on GitHub, tests green.

### M5 — R3 supervisor (blue/green restart)

Tracked in 11-self-update.md §R3. Lands after M4 so we have a
working demo before automating restart. No code stubs yet.

### M6 — codex parity

- ⚪ Re-target `CodingAgentProvider` to codex (`codex exec --json`
  or current equivalent flag).
- ⚪ Document any contract divergence in 11-self-update.md R2
  implementation contract section.

---

## LLM providers

- 🟢 **OpenAIProvider** — streaming + tool calls + usage reporting
  (prompt / completion / cached tokens), plus:
  - `reasoning_delta` emission — probes both `reasoning_content`
    (o1/o3 + Responses API passthrough) and `reasoning` (alternate
    spelling on some compatible endpoints) on the streaming delta.
    Surfaced as a separate `SamplingDelta` so `actionParser`
    accumulates it into `reasoningText` without polluting the reply.
  - preamble heuristic — implemented in `actionParser` (one source of
    truth for every provider): a text buffer flushed *because of* a
    following tool_call defaults to `preamble`, otherwise `reply`. A
    provider that explicitly tags a delta with `channel: 'reply'`
    overrides the default. Provider therefore emits text untagged.
  - retry-on-transport-error budget — `OpenAIProviderOptions.maxRetries`
    forwards to the SDK constructor (default 2 = 3 total attempts).
    Mid-stream errors are NOT retried (would double-emit content);
    initial connect / 5xx / 429 / 408 / network use the SDK's built-in
    exponential backoff.
  - structured output passthrough — `SamplingRequest.responseFormat`
    accepts `{ type: 'json_object' }` or `{ type: 'json_schema',
    name, schema, strict?, description? }`; provider translates to
    OpenAI's `response_format` shape (json_schema strict-by-default).
- ⚪ **GeminiProvider / Bedrock / local**. OpenAI-compatible endpoints
  already work via `OPENAI_BASE_URL`; native adapters come later.

## Context management

- 🟡 **Pruning** (`src/context/pruning.ts`) — Level-1 deterministic rules
  done. Missing:
  - ⚪ `keepLastReasoning` is threshold-based only; no summarisation of the
    dropped reasoning.
  - ⚪ inline-vs-elide decision respects `inlineToolResultLimit` but does
    not consider the *next* sampling's estimated token budget.
- 🟢 **Cross-thread context refs (COW)** —
  `spawn(contextRefs: [{sourceThreadId, fromEventId?, toEventId?}])`
  prepends a slice of another thread's event log into the child's
  projection without physically copying. Active elision handles in the
  range are copied into the child's `HandleRegistry` on first sampling
  so `restore` works on source-side elided events. Replaces the older
  `inheritTurns: N` mechanism (never landed in projection).
- 🟢 **MicroCompactor** (`src/context/microCompactor.ts`) — hot-path
  sliding-window micro-compaction; runs deterministically before each
  sampling step, elides oversized tool_results in the warm zone via
  attachElision + handle. Restore-recoverable.
- 🟢 **Compaction trigger + handler (cold path)** —
  `CompactionTrigger` fires `compact_request` past the threshold (with
  cooldown). `CompactionHandler` consumes the request, runs the
  configured `Compactor`, persists a `compaction_event`, and
  acknowledges the trigger so the cooldown can release. An in-flight
  guard drops duplicate requests on the same thread.
- 🟢 **Subagent-backed compactor** (`SubagentCompactor`) — runs the
  configured `LlmProvider` against a fresh, isolated thread (parented
  to the source thread for traceability, empty tool registry so it can
  only reply with prose). Bypasses `SubagentPool` so a compaction
  running on an idle thread doesn't have to synthesize a parent turn
  or pollute that thread with a `subtask_complete` event. Wall timeout
  (default 60s) + injectable fallback (defaults to `StaticCompactor`)
  keep the cold path best-effort: a flaky provider can't deadlock
  compaction. Opt in via `bootstrap({ useSubagentCompactor: true })`
  or `HARNESS_COMPACTOR=subagent` (alongside
  `HARNESS_COMPACTION_THRESHOLD_TOKENS`).
- 🟢 **Compaction summary + pinned memory injection** —
  `compaction_event.payload` now carries `summary` + `atEventId`.
  Before each sampling, `AgentRunner` reads the most recent
  compaction_event with a usable summary and passes both fields
  (plus the merged pinned-memory list) into `buildSamplingRequest`.
  Projection emits *synthetic head-of-tail items* with cacheTags
  `pinned-memory` and `compacted-summary` (in that order, each as a
  `role: 'user'` block) instead of folding them into the system
  message — so `StablePrefix` (system + tools) stays byte-identical
  across pin/unpin and compaction events and the provider's
  prompt-cache prefix survives. Metrics-only `compaction_event`s
  (older or pre-handler) are skipped so they don't override a real
  compaction. Future: providers with explicit cache markers
  (Anthropic `cache_control`) can use these tags to seal each
  segment as its own cache breakpoint.
- 🟢 **`restore` handle rehydration** — `restore` pins the handle for
  exactly the next sampling; `clearPins()` runs after each step, so the
  documented "drop back after next cycle" rule already holds.

## Runtime

- 🟡 **AgentRunner** — happy path works. Tool dispatch is atomic: the
  paired `tool_call` + `tool_result` are persisted synchronously even
  for long-running tools (which return `{sessionId, status:'running'}`
  immediately and run their bodies off-path; agent reads the captured
  output via the `session` tool, waits via
  `wait({matcher:'session', sessionIds, mode:'any'|'all'})`). The old
  `awaiting_tool_results` ActiveTurn state and the
  `deferredUserTurnStarts` ad-hoc guard are gone — projection can no
  longer observe an orphan tool_call. The `wait` transport
  suspends the turn into `awaiting_event` and resumes when a matching
  event arrives (`user_input` / `subtask_complete:<id>` / `tool_result`
  / `kind` / `timer` / `session`). Each runner owns a `Scheduler`;
  `wait(timer, delayMs)` schedules a real one-shot timer that publishes
  `timer_fired`, and `wait.timeoutMs` schedules a private fallback
  timer that emits `external_event{source:"wait_timeout"}` so a
  bounded wait can never deadlock. Pending timers are cancelled on
  turn complete / interrupt / wakeup. Interrupt classification routes
  a user-cut-off sampling to `turn_complete{interrupted, reason}`
  carrying the actual cause (`user_interrupt`, `parent_interrupt`,
  `budget_*`, …) so adapters and diag don't have to guess. Missing:
  - ⚪ provider stream cancellation surfaces back to the user via the
    `interrupt` event the adapter renders, but no separate
    "interrupting…" lifecycle event is emitted by the runner — the
    bus interrupt envelope is the source of truth.
  - ⚪ `rollback` / `fork` event handling — events are filtered out of
    projection but the runner does not respond to them.
  - ⚪ Mid-turn `user_turn_start` currently *replaces* the active turn
    (the old turn's wait/sessions are abandoned but its persisted
    history stays well-formed). FIFO-queue alternative is a possible
    future option; right now "newest message wins" is the contract.
- 🟡 **SubagentPool** — `spawn` creates a child, returns its id, and
  parent receives `subtask_complete` when the child's turn ends.
  Budgets (`maxTurns`/`maxToolCalls`/`maxWallMs`/`maxTokens`) enforced
  as hard caps; structural caps (`maxDepth`, `maxSiblingsPerParent`,
  `maxConcurrentTotal`) reject violating spawns at pre-flight via
  `SpawnRefused`, surfaced to the LLM as `tool_result.ok=false` with
  the cap name in `error.kind`. Parent → descendant interrupt
  propagation works.
  `subtask_complete` now keeps the *child's* own final reply as
  `summary` and reports the cap that fired (and turns/toolCalls/
  tokens used) in a separate `budget` field — the parent no longer
  loses the child's conclusion when a budget interrupts it. Each
  child's system prompt gets a budget-summary preface so the model
  can plan within the caps from sampling 1; `usage` returns a
  `RuntimeBudgetSnapshot` (caps / used / remaining) so the model can
  poll its dynamic budget rather than discovering the cap by getting
  cut off.
  Missing:
  - ⚪ Role-aware system prompts — stub concatenates `[role: foo]`.
  - ⚪ Soft 80%-warn event before the hard cap fires (today the model
    can poll `usage` for live remaining, but no auto-warn lands on the
    bus). See
    [01-runtime.md](design-docs/01-runtime.md#subagent-budgets-and-interrupt-propagation).
- 🟢 **Scheduler** — owned per AgentRunner, drives `wait(timer)` and
  `wait.timeoutMs`. No cron yet (one-shot delays only).

## Tools

- 🟡 **`shell`** — real. `child_process.spawn` with cwd / timeout / byte-cap
  / signal-group kill / handle elision. Marked `async: true` — same
  session pairing as `web_fetch`. Missing: custom env passthrough,
  stream progress events (tools can't emit intermediate events today),
  explicit stdin support.
- 🟡 **`write`** — overwrite mode real; `mode: 'patch'` returns
  `not_implemented`.
- 🟡 **`web_fetch`** — real (undici fetch). GET/HEAD, byte cap, timeout,
  handle elision. Marked `async: true` — the runner persists the
  paired tool_result `{sessionId, status:'running'}` at dispatch and
  runs the fetch off-path. Agent reads via `session(sessionId)`.
  Missing: auth headers, POST body, pluggable transport.
- 🟢 **`web_search`** — `SearchBackend` interface + two backends:
  - `GoogleSearchBackend` (Programmable Search JSON API; `GOOGLE_SEARCH_API_KEY`
    + `GOOGLE_SEARCH_CX`; paginates up to 30 results).
  - `TavilySearchBackend` (`TAVILY_API_KEY`; basic/advanced depth; optional
    synthesized one-line `answer`).
  Tool is `async: true` (same session pairing as `web_fetch`); selection via
  `HARNESS_SEARCH_PROVIDER` (else first key wins, Tavily preferred).
  Returns `unsupported` when no backend is configured. Missing:
  - ⚪ Brave / DDG backends (interface is stable; drop-in additions).
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
  - ⚪ Confidence + provenance metadata + async verifier subagent —
    deferred until a poisoning incident motivates it. See
    [09-memory.md](design-docs/09-memory.md#future-confidence-and-provenance).
- 🟢 **`restore`** — pins a handle for exactly the next sampling; projection
  rehydrates pinned handles and clears pins after the step.
- 🟢 **`wait`** — yield semantics work for `user_input` /
  `subtask_complete` / `tool_result` / `kind` / `session`. `timer`
  matcher schedules a real one-shot timer when given `delayMs`;
  `timeoutMs` on any matcher schedules a fallback timer that wakes
  the wait via `external_event{source:"wait_timeout"}`. Malformed
  `timer` waits return `tool_result.ok=true` with `scheduled=false` +
  an error string the model can react to. `session` matcher accepts
  `sessionIds: string[]` + `mode: 'any' | 'all'`; sessions that are
  already terminal at wait-time get drained synchronously to avoid
  deadlocking on a `session_complete` that fired before the wait.
- 🟢 **`session`** — reads the captured output of an async tool
  (`web_fetch`, `shell`, …) by `sessionId`. Returns `status` plus
  the captured `output` truncated to `maxTokens` (default 2048),
  the full `totalTokens` estimate, and a `truncated` flag so the
  model knows when it hit the cap. Future args reserved (`range`,
  `grep`); not yet implemented.
- 🟢 **`spawn`** — composition works, parent sees subtask_complete.
  All four budget dimensions (`maxTurns`/`maxToolCalls`/`maxWallMs`/
  `maxTokens`) enforced; structural caps reject overage spawns
  pre-flight. Children get a budget summary in their system prompt
  and can poll `usage` for live caps/used/remaining. `contextRefs`
  give the child a COW slice of another thread's event log when set
  (replaces the never-implemented `inheritTurns`).

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
- 🟢 **DiscordAdapter** — fixed-channel or per-channel binding. With
  `DISCORD_CHANNEL_ID`, one designated channel maps to the root
  thread. Without it, the first `@bot` message in each channel
  creates and binds a separate root thread/session; later messages
  in that channel continue the same session. A bare `@bot` with no
  text still binds the channel and posts a one-line greeting. Bot
  authors and unbound non-mention messages are dropped. Channel →
  thread mappings persist across restarts via the
  `discord:<channelId>` thread title — the adapter scans the store
  on start and re-adopts each runner (`Runtime.adoptRootThread`).
  Outbound: `text_delta` streams as live message edits (throttled
  ~750ms) until the 1900-char soft cap, then opens a continuation;
  `reasoning_delta` is suppressed in favor of the persisted
  reasoning event. Reasoning-echo content (model emitting
  `[reasoning] X` as preamble because of `pruning.ts` projection)
  is reclassified at flush time to the gray `> …` quote-block
  rendering with the marker stripped, so it shows once. Discrete
  events: `tool_call` posts `-# 🔧 …` and the matching successful
  `tool_result` edits it in place to `-# ✓ …`; failures post a
  separate `-# ✗` line; `wait`/`session` and `running` results stay
  hidden. `subtask_complete` is a Discord embed (↩️). `interrupt`
  posts `-# ⏸️ …`. `compaction_event` posts a one-line summary.
  `turn_complete` is silent for completed turns. Persisted
  reply/preamble/reasoning dedupe against the streamed buffer on
  any channel; mismatches post a fresh fallback. Real client lives
  behind a `DiscordTransport` interface so unit tests inject a
  fake without `discord.js`. CLI: `--adapter discord` +
  `DISCORD_BOT_TOKEN`; `DISCORD_CHANNEL_ID` optional. Missing:
  - ⚪ Operator ACL (private-server v1 assumes the bound channel is
    trusted).
  - ⚪ Slash-command surface beyond plain `/interrupt` text.
  - ⚪ Pruning-side fix to stop projecting `[reasoning] X` as plain
    assistant text when encrypted `provider_state` already
    round-trips reasoning (the discord reclassification is a
    band-aid for the real cause).
- ⚪ **TelegramAdapter / HTTPAdapter**.
- ⚪ Multi-adapter bootstrap (one runtime, N adapters).

## Diagnostics

See commit B for what just landed. Still missing:

- ⚪ OTEL exporter wiring. `traceparent` is minted and propagated to
  subagents, but no spans are emitted.
- ⚪ Permission-review audit log (needs sandbox work first).
- ⚪ Cache-hit tracking — requires a provider that exposes cached token
  counts; OpenAI reports `cached_tokens` when long prefixes hit.
- 🟢 Compaction metrics — `compaction_event` carries non-placeholder
  `tokensBefore` / `tokensAfter` / `durationMs` / `retainedUserTurns`
  (cheap estimator, no full clone). Both MicroCompactor and the
  cold-path `CompactionHandler` populate the same shape.
- 🟢 Interrupt cause attribution — `turn_complete{reason}` plus
  terminal/diag rendering surface the actual cause
  (`user_interrupt` / `parent_interrupt` / `budget_*` / …) instead
  of silently writing `user_interrupt` for everything.
- 🟢 Subtask metadata projection — `subtask_complete` events are
  rendered into the parent's prompt with status / reason / budget
  counters / summary, so the parent can plan around how its child
  terminated.

## Actor mode (deferred — see [10-actor-mode.md](design-docs/10-actor-mode.md))

Whole document is deferred until a trigger condition lands.

- ⚪ `ActorPool` (sibling of SubagentPool), actor registry,
  `send(actorRef, msg)` primitive, optional state-machine layer,
  `external_event` framing in projection.

## Sandbox / permissions

- ⚪ **All of it.** Designed in
  [design-docs/00-overview.md](design-docs/00-overview.md#5-security--sandbox-later-interface-today);
  deferred to phase 4. The single `Executor` indirection is the only
  escape hatch that will need changes.

## Testing

- 🟡 **Unit + smoke tests** — `pnpm test` currently covers 42 active
  unit/smoke files and skips 4 live e2e files unless `HARNESS_E2E=1`.
  Gaps:
  - ⚪ `HandleRegistry` pinning / clearPins semantics.
  - ⚪ `promptDebug.renderPromptText` snapshot.
- 🟡 **E2E** — live suites cover OpenAI, resume, eval, and mem0 paths when
  enabled with real credentials. Add/keep at least one live task that forces a
  model-issued tool call.

## Docs

- 🟢 Phase-1 status in [README](README.md) is current.
- ⚪ Tutorial for "adding a new LLM provider" (today only has tools /
  adapters).
- ⚪ `design-docs/07-diagnostics.md` needs a refresh now that the diag
  layer exists.
