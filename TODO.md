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

### M1 — CodingAgentProvider + per-spawn provider plumbing — 🟢 done

- 🟢 New `src/llm/codingAgentProvider.ts`:
  - cc first (`claude -p <task> --output-format stream-json --verbose`),
    codex shape-compatible (codex factory disabled by default; M6).
  - stream-json parser handles `system/init`, `assistant`,
    `user`, `rate_limit_event`, `result`; drops cc's internal
    `tool_use` / `tool_result` from the parent's view.
  - SIGTERM-on-abort with SIGKILL grace window (mirrors
    `src/tools/impl/shell.ts`).
  - `providerSessionId` captured from `system/init` and refreshed
    on `result`; exposed as `lastSessionId` for the pool to read.
- 🟢 `SpawnRequestInfo` and `spawn` tool schema gained `provider?`,
  `cwd?`, `providerSessionId?`, `continueThreadId?`. Description
  rewritten in capability terms (no scenario recipes).
  - `provider` / `cwd` / `providerSessionId` fully wired.
  - `continueThreadId` schema-only — reopen semantics deferred to M2.
- 🟢 `SubagentPoolDeps.providerFactories`. cc factory in
  `bootstrap.ts` builds a one-shot `CodingAgentProvider` per spawn
  bound to `req.cwd` + `req.providerSessionId`. Caller-supplied
  factories override built-ins.
- 🟢 `SubtaskCompletePayload.providerSessionId` populated from
  `provider.lastSessionId` at child-exit time.
- 🟢 `ProviderUsageRegistry` (runtime-scoped) — bonus shipped early
  (originally M3): cc pushes account-level snapshots into it
  (`fiveHour` / `sevenDay` from `rate_limit_event`, plus per-run
  tokens / cost / model / session id / turns / duration from
  `result`). `usage` tool output gains a `providers[]` block that
  reads from this registry, so the orchestrator can see cc / codex
  state without a chat round-trip. In-memory only — survives the
  current process; lost on restart.
- 🟢 Tests: `tests/unit/llm/providerUsageRegistry.test.ts` (merge
  semantics, multi-provider isolation) and
  `tests/smoke/codingAgentSpawn.test.ts` (fake cc binary verifies
  argv shape, session_id round-trip, registry capture of windowed
  quota + per-run stats; cwd-missing surfaces
  `provider_factory_failed`).
- ⚪ Carried forward to M2 (was originally listed in M1):
  `SamplingDelta.end.stopReason` `'quota_exhausted'` extension
  + runner translation to `turn_complete.reason`. Not needed for
  the M1 happy path; lands as part of the quota-coordination
  story below.

### M2 — Quota coordination — 🟢 done

- 🟢 `SamplingDelta.end.stopReason` union extended with
  `'quota_exhausted'`; the delta carries an optional `resetAt`
  that the runner threads through `turn_complete.resetAt` →
  `subtask_complete.resetAt`.
- 🟢 `CodingAgentProvider` watches incoming `rate_limit_event`s
  for blocked sentinels (`status: 'blocked' | 'rate_limited' | …`
  or `utilization >= 1.0`); when the run errors out after one,
  the terminal delta is `quota_exhausted` instead of plain
  `error`, with the resetAt captured from the rate_limit event.
- 🟢 Account-level `fiveHour` / `sevenDay` windows in
  `ProviderUsageRegistry` (landed early in M1) act as the policy
  input; no separate `QuotaState` registry needed.
- 🟢 `SubagentPool.spawn` consults the registry: if a window for
  the requested provider is blocked and its `resetsAt > now`, the
  pool synthesises an immediate
  `subtask_complete{reason:'quota_exhausted', resetAt}` to the
  parent without launching a CLI process. The synthetic path
  still creates the child thread + appends the
  `user_turn_start` seed, so audit logs match the non-fail-fast
  shape.
- 🟢 One `provider_ready` timer per `(providerId, resetAt)` —
  dedup'd by a key map inside the pool. On fire, the pool
  publishes
  `external_event{source:'provider_ready', data:{provider, resetAt}}`
  on the bus. Timer is `unref`'d so it never holds the event
  loop open past a clean shutdown.
- 🟢 `continueThreadId` reopen implemented: when set, the pool
  verifies the thread exists in the store, refuses if a live
  runner is already attached (`SpawnRefused('continueThreadId_live')`)
  or the thread is unknown (`continueThreadId_unknown`), then
  appends a fresh `user_turn_start` to the existing thread and
  starts a new runner there.
- 🟢 `wait`'s existing `kind` matcher already handles
  `external_event`; agents filter by `source:'provider_ready'`
  inline rather than via a dedicated matcher.
- 🟢 Tests: `tests/smoke/quotaCoordination.test.ts` covers all
  four cases — real-cc quota_exhausted round-trip, fail-fast on
  second spawn, provider_ready timer fires, `continueThreadId`
  reopens an existing child thread.

### M3 — Usage introspection — 🟢 mostly absorbed into M1

The user-visible surface of M3 already shipped early as part of
M1 (`ProviderUsageRegistry` + `usage` tool `providers[]`). The
remaining items are deliberately deferred — none are required
to read account state.

- ⚪ `LlmProvider.usage?()` instance method on the provider
  interface (the registry currently bypasses this — providers
  push state, the runtime reads). Land only if a provider needs
  to be actively probed (e.g. one without passive emission).
- ⚪ `SubtaskCompletePayload.providerUsage?` — per-spawn snapshot
  attached at child exit. Distinct from the runtime-scoped
  registry; useful for parents that want the "as-of-this-spawn"
  numbers without a separate `usage` round-trip.
- ⚪ Optional registry persistence to `<storeRoot>/provider-usage.json`
  so a fresh process boot already has the last-known windows
  (resetsAt is absolute, so restored data carries its own
  freshness signal).

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

### M5 — supervisor + restart handshake — 🟢 shipped (single-instance variant)

The first version ships **single-instance restart with anti-brick
verification**, not full blue/green. Discord allows only one bot
connection per token, so true blue/green would need either a
staging bot or an HTTP adapter. We get the safety guarantee that
matters — never kill the old harness on a broken build — without
that complexity.

What landed:

- 🟢 `restart_event` event kind in `src/core/events.ts` with
  `fromSha` / `toSha` / `ref` / `outcome` / `message` / `startedAt`.
- 🟢 `src/runtime/lifecycle.ts` lifecycle helpers — read/write
  `<storeRoot>/.lifecycle/{ready.json, handoff.json, pid}` with
  atomic writes (tmp + rename). All file I/O is dependency-free
  so the same module can be imported from inside the harness and
  from `scripts/supervisor.cjs`.
- 🟢 CLI integration: after `adapter.start()` the harness reads +
  consumes the supervisor's handoff, publishes a
  `restart_event` to the root thread, writes its own
  `ready.json`, and installs `SIGTERM` / `SIGINT` cleanup hooks
  that delete the ready / pid files before re-raising.
- 🟢 Discord adapter renders `-# 🔄 back on <from> → <to> (ref) …`
  on the next line in the bound channel. Terminal adapter prints
  a dim `[restart …]` line. Both subscribe to `restart_event`.
- 🟢 `scripts/supervisor.cjs` — pure-Node external script.
  Three subcommands:
  - `start [<ref>]` — checkout (if ref), clear stale lifecycle
    files, spawn harness, write pidfile, forward SIGINT/SIGTERM.
  - `deploy <ref>` — fetch, checkout ref, `pnpm install
    --frozen-lockfile && pnpm build && pnpm test` ON THE NEW REF
    FIRST. On failure: revert checkout, leave old harness
    running, exit non-zero. On success: SIGTERM old (SIGKILL
    grace), write handoff, spawn new, wait for ready.json from
    the new pid, exit.
  - `status` — pretty-print pid + ready info.
  Configurable via `HARNESS_REPO_ROOT`, `HARNESS_START_CMD`,
  `HARNESS_BUILD_CMD`, `HARNESS_TEST_CMD`, `HARNESS_SKIP_TESTS`,
  `HARNESS_READY_TIMEOUT_MS`, `HARNESS_SHUTDOWN_TIMEOUT_MS`.
- 🟢 Unit tests: `tests/unit/runtime/lifecycle.test.ts` covers
  ready / handoff / pid round-trips, missing-file safety, and
  atomic-write correctness.

Out of scope (still ⚪ for a future M5+):

- ⚪ True blue/green with a staging adapter session (the new
  harness comes up while the old still answers, then traffic
  cuts over). Needs either a second Discord bot token or an HTTP
  adapter where parallel instances coexist.
- ⚪ Automatic rollback to the prior-known-good sha on
  ready-file timeout. Today the supervisor surfaces the failure
  and the operator intervenes.
- ⚪ A `/deploy` slash command in adapters — the main agent
  invokes the supervisor via `shell` today, which is sufficient
  but doesn't survive the parent dying mid-deploy. Detached
  invocation (`nohup` / `setsid`) is the obvious next step.

### M6 — codex parity

- ⚪ Re-target `CodingAgentProvider` to codex (`codex exec --json`
  or current equivalent flag).
- ⚪ Document any contract divergence in 11-self-update.md R2
  implementation contract section.

---

## LLM providers

- 🟢 **OpenAIProvider** — streaming + tool calls + usage reporting
  (prompt / completion / cached tokens), plus:
  - Responses API + Chat Completions transport switch —
    `OpenAIProviderOptions.apiMode` and `OPENAI_API_MODE` select
    `responses` (default) or `chat_completions`; Chat mode maps the
    same projection to `messages` / function tools and supports
    OpenAI-compatible endpoints that lack `/v1/responses`.
  - `.env` model alias routing — `HARNESS_MODEL_ALIASES` /
    `HARNESS_MODEL_<ALIAS>` register OpenAI model configs as
    `SubagentPool.providerFactories`, while `HARNESS_MAIN_MODEL`
    selects the root agent's default alias or raw model id. A parent
    can now `spawn({provider:"fast", ...})` to pick a specific model.
  - runtime model prompt injection — CLI passes alias/provider/model/API
    mode/base URL metadata into bootstrap, and bootstrap appends a
    `[runtime model]` block to the root or alias-routed subagent system
    prompt so agents can identify their configured model without
    guessing. API keys are not injected.
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
