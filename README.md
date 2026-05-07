# harness

AI-native general-purpose agent runtime.

The LLM is the router / dispatcher. The runtime provides a minimal set of
composable tools, decoupled async loops connected via an event bus, and an
aggressive-but-recoverable context management layer. The shape of the "agent
loop" (direct answer vs. ReAct vs. ReAct + verifier) is chosen by the model at
runtime by composing actions — it is **not** hard-coded in the harness.

This repository is the implementation sibling of the design notes in
[`../references/`](../references/) and the architecture writeups under
[`design-docs/`](design-docs/).

## Status

**Phase 1 — architecture landing.** Every box in the diagram exists in code
with a typed interface. Current state:

- ✅ Event bus, session store (memory + JSONL), action / event protocol types
- ✅ `ActiveTurn` state machine + two-phase mailbox (`CurrentTurn` /
  `NextTurn`) matching Codex's model
- ✅ LLM provider interface; OpenAI Responses API provider (real streaming +
  tool calls), works against endpoints that implement `/v1/responses` via `OPENAI_BASE_URL`
- ✅ Real `shell` (process-group kill, byte cap, handle elision) and
  `web_fetch` (undici); `read`/`write`(overwrite) real; `memory` real
  with three backends (in-memory / JSONL / mem0); `web_search` real via
  Google Programmable Search or Tavily when configured
- ✅ Context projection + handle registry + deterministic Level-1
  pruning + **hot-path micro-compaction** (sliding window, no LLM
  call); cold-path compaction trigger/handler with static or
  subagent-backed compactor
- ✅ Pluggable `MemoryStore`: KV path (`get`/`set`/...) **and**
  ingestion path (`ingest(messages)`); pinned entries auto-injected
  into the system prefix on every sampling
- ✅ AgentRunner: event-driven action loop with spawn / wait / restore
  intercepted as transport tools; tool-call ↔ tool-result pairing
  preserved through elision
- ✅ SubagentPool with hard budget enforcement
  (`maxTurns`/`maxToolCalls`/`maxWallMs`) + parent → descendant
  interrupt propagation
- ✅ Terminal adapter + CLI; three-layer diagnostics (prompt dumps,
  JSONL trace, stderr summary)
- ✅ 193 unit/smoke tests green; live e2e (OpenAI + mem0) skipped
  behind `HARNESS_E2E=1`

**Phase 2** (next) focuses on the remaining primitive depth: `write(patch)`
unified-diff mode, an Anthropic provider with `cache_control` + `cache_edits`,
better pruning estimates, memory ingestion at turn boundaries, and docs /
diagnostics polish. See [design-docs/08-roadmap.md](design-docs/08-roadmap.md).

## Architecture at a glance

```
           ┌──────────────┐  user_message     ┌──────────────┐  tool_call   ┌──────────────┐
           │  Conversation│ ───────────────▶  │ AgentRunner  │ ───────────▶ │ ToolExecutor │
           │   Adapter    │ ◀───────────────  │  (per thread)│ ◀─────────── │ (worker pool)│
           └──────────────┘  reply            └──────────────┘  tool_result └──────────────┘
                 ▲                                    ▲  ▲                         │
                 │                                    │  └── subtask_complete ─────┤
                 │ external_event                     │                             │
                 ▼                                    │                             ▼
           ┌──────────────┐                           │                      ┌──────────────┐
           │  Scheduler   │ ──── timer_fired ─────────┘                      │ Subagent Pool│
           └──────────────┘                                                  └──────────────┘
                                   EventBus (typed, persistent)
```

Three decoupled loops — conversation I/O, agent reasoning, tool execution —
communicate only through a typed event bus. The runtime maintains a
`Thread → Turn → Item` persistence abstraction (borrowed from Codex) so that
UI rendering, rollback, compaction boundaries, and resume all have the same
anchor points.

**Five principles** (see [design-docs/00-overview.md](design-docs/00-overview.md)):

1. AI-native control flow — harness ships actions, not loops.
2. Minimal orthogonal tool set — ~7 primitives, composed via `spawn`.
3. Async / decoupled loops — user, agent, tools all async; connected via events.
4. Cache-friendly aggressive context pruning — hot path via `cache_edits`-style
   logical hiding, cold path via physical rewrite; every elided block leaves a
   `handle` that a `restore` tool can bring back.
5. Security + sandbox later — single `Executor` interface today, swap the impl
   when sandbox layer lands.

## Design documents

- [00-overview.md](design-docs/00-overview.md) — principles, goals, non-goals
- [01-runtime.md](design-docs/01-runtime.md) — event bus, ActiveTurn, AgentRunner, subagents
- [02-events-and-state.md](design-docs/02-events-and-state.md) — Thread/Turn/Item model, event envelopes, persistence
- [03-tools.md](design-docs/03-tools.md) — minimal tool set, tool interface, executor, spawn semantics
- [04-context.md](design-docs/04-context.md) — projection, compaction, handles, microcompact
- [05-llm-provider.md](design-docs/05-llm-provider.md) — provider interface, action parsing, streaming
- [06-adapters.md](design-docs/06-adapters.md) — adapter interface, terminal, future Discord/TG
- [07-diagnostics.md](design-docs/07-diagnostics.md) — prompt_debug, tracing, compaction events
- [08-roadmap.md](design-docs/08-roadmap.md) — phased implementation order
- [09-memory.md](design-docs/09-memory.md) — MemoryStore interface, backends (in-memory / JSONL / mem0), pinning
- [10-actor-mode.md](design-docs/10-actor-mode.md) — **deferred**; actor / mailbox mode for multi-agent, with explicit trigger conditions

## Quick start

> Requires Node.js 18.17+ and pnpm.

```bash
pnpm install
cp .env.example .env      # fill in OPENAI_API_KEY at minimum
pnpm typecheck
pnpm test:unit
pnpm dev                  # terminal REPL against the configured provider
```

Configuration is read from `.env` (see [.env.example](.env.example)):

| var                  | purpose                                               |
|----------------------|-------------------------------------------------------|
| `OPENAI_API_KEY`     | required                                              |
| `OPENAI_MODEL`       | default `gpt-4o-mini`                                 |
| `OPENAI_BASE_URL`    | override endpoint; must implement OpenAI's Responses API |
| `OPENAI_MAX_TOKENS`  | default `32768`; includes visible output and reasoning tokens |
| `OPENAI_TEMPERATURE` | optional; suppressed for GPT-5 / o-series models that reject it |
| `OPENAI_REASONING_EFFORT` | optional Responses API reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `OPENAI_REASONING_SUMMARY`| optional visible reasoning summary stream: `auto`, `concise`, `detailed`, `off`; default `auto` |
| `HARNESS_STORE_ROOT` | persist session events to this directory              |
| `HARNESS_MEMORY_FILE`| JSONL memory log path (cross-session memory; off if unset) |
| `MEM0_API_KEY`       | enable mem0 backend (cloud or self-hosted) — overrides `HARNESS_MEMORY_FILE` |
| `MEM0_BASE_URL`      | self-hosted mem0 server (omit for cloud)              |
| `MEM0_USER_ID`       | fallback userId for mem0 (default `harness`)          |

CLI flags override env: `pnpm dev -- --model gpt-4o --base-url https://…`.

E2E tests that hit the real API are skipped unless you set `HARNESS_E2E=1`:

```bash
HARNESS_E2E=1 pnpm test:e2e
```

Offline smoke coverage uses inline scripted providers in the test files; the
runtime no longer ships a built-in mock provider.

## Walkthrough: what happens on a user turn

Configured-provider path, end-to-end:

1. User types `hello` in the terminal.
2. [`TerminalAdapter`](src/adapters/terminal.ts) appends a `user_turn_start`
   event to the [`SessionStore`](src/store/sessionStore.ts) and publishes it
   on the [`EventBus`](src/bus/eventBus.ts).
3. [`AgentRunner`](src/runtime/agentRunner.ts) is subscribed for that thread.
   Its tick loads the store, runs
   [`buildSamplingRequest`](src/context/projection.ts) to produce a
   cache-friendly `SamplingRequest` (stable prefix + pruned tail), and calls
   the [`LlmProvider.sample`](src/llm/provider.ts) async iterable.
4. [`parseSampling`](src/llm/actionParser.ts) turns the delta stream into an
   `Action[]` — `reply`, `preamble`, `tool_call`, etc.
5. For each action the runner appends an event AND publishes it. Tool calls
   go through the [`ToolExecutor`](src/tools/executor.ts); `tool_result`
   events come back asynchronously and drive the next tick.
6. Terminal adapter's subscription renders replies/preambles to stdout.

No hard-coded loop in the runner — each tick is driven by a matching event.

## Tutorial: adding a new tool

See [design-docs/03-tools.md](design-docs/03-tools.md#adding-a-tool). The short
version:

1. Create `src/tools/impl/<name>.ts` exporting a `Tool` object with `name`,
   `schema` (zod), `description` (including LLM-facing decision hints), and
   an `execute` implementation. Use `ctx.registerHandle()` to stash large
   payloads so the tool result can be elided with a handle.
2. Re-export it from [`src/tools/impl/index.ts`](src/tools/impl/index.ts) and
   add it to [`createDefaultRegistry`](src/tools/index.ts) (or a per-turn
   registry if the tool is opt-in).
3. Unit-test under `tests/unit/tools/<name>.test.ts`; exercise schema,
   execution, and elision.

Tools are the extension surface. The harness itself should not grow new hard
wiring — new capabilities compose existing primitives or register as a tool.

## Tutorial: adding a new adapter (e.g. Discord)

See [design-docs/06-adapters.md](design-docs/06-adapters.md). The shape:

```ts
import type { Adapter, AdapterStartOptions } from '@harness/adapters';

export class DiscordAdapter implements Adapter {
  readonly id = 'discord';
  async start(opts: AdapterStartOptions): Promise<void> {
    // 1. connect to Discord
    // 2. on incoming message: append user_turn_start or user_input to
    //    the SessionStore and publish on opts.bus
    // 3. subscribe to reply / preamble / turn_complete for your threads
    //    and render them back to Discord
  }
  async stop(): Promise<void> { /* tear down */ }
}
```

The runtime never learns Discord exists. A new entry binary under `src/cli/`
wires `bootstrap()` to an instance of your adapter.

## Tutorial: swapping the LLM provider

Implement [`LlmProvider`](src/llm/provider.ts) — one method, `sample(request,
signal)` returning an `AsyncIterable<SamplingDelta>`. For a minimal
implementation, see the inline scripted providers in
[`tests/smoke/replLoop.test.ts`](tests/smoke/replLoop.test.ts) and the unit
tests. Production providers should translate native streaming output into the
provider-agnostic `SamplingDelta` contract.

## Layout

```
src/
  core/          — protocol types, Thread/Turn/Item, action envelopes
  bus/           — EventBus + typed channels
  store/         — SessionStore (append-only event log) + projections
  runtime/       — AgentRunner, ActiveTurn, subagent pool, scheduler
  llm/           — provider interface + OpenAI Responses API provider
  tools/         — minimal tool set + executor + registry
  context/       — projection, compactor, handle registry
  adapters/      — terminal, Discord, future TG/HTTP surfaces
  cli/           — entry points
design-docs/     — architecture docs (link target from README)
tests/
  unit/          — fast, isolated
  smoke/         — wire multiple components end-to-end with mocks
  e2e/           — real LLM calls; skipped unless HARNESS_E2E=1
```

## License

MIT (see [LICENSE](LICENSE)).
