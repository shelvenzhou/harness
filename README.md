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

Scaffolding phase. The goal at this stage is to land the **full architecture
surface + interfaces**, with a single working terminal adapter and a mock LLM
provider, so that subsequent work (real LLM integration, Discord adapter, real
shell tools, sandboxing) slots into stable extension points.

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

## Quick start

> Requires Node.js 18.17+ and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test:unit
pnpm dev                 # terminal REPL against mock LLM provider
```

Set `HARNESS_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=…` to use Claude.
E2E tests that hit real LLMs are skipped unless you set `HARNESS_E2E=1`:

```bash
HARNESS_E2E=1 ANTHROPIC_API_KEY=sk-... pnpm test:e2e
```

## Tutorial: adding a new tool

See [design-docs/03-tools.md](design-docs/03-tools.md#adding-a-tool). The short
version:

1. Create `src/tools/<name>.ts` exporting a `Tool` object with `name`, `schema`
   (zod), `description` (including LLM-facing decision hints), and an `execute`
   implementation.
2. Register it in `src/tools/registry.ts`.
3. Unit-test it under `tests/unit/tools/<name>.test.ts`.

Tools are the extension surface. The harness itself should not grow new hard
wiring — new capabilities compose existing primitives or register as a tool.

## Tutorial: adding a new adapter (e.g. Discord)

See [design-docs/06-adapters.md](design-docs/06-adapters.md). The adapter
implements a small interface (`inbox` produces user events, `deliver` consumes
reply events) and is wired up by the CLI or a dedicated entry binary.

## Layout

```
src/
  core/          — protocol types, Thread/Turn/Item, action envelopes
  bus/           — EventBus + typed channels
  store/         — SessionStore (append-only event log) + projections
  runtime/       — AgentRunner, ActiveTurn, subagent pool, scheduler
  llm/           — provider interface + mock + anthropic
  tools/         — minimal tool set + executor + registry
  context/       — projection, compactor, handle registry
  adapters/      — terminal (today), discord/tg (future)
  cli/           — entry points
design-docs/     — architecture docs (link target from README)
tests/
  unit/          — fast, isolated
  smoke/         — wire multiple components end-to-end with mocks
  e2e/           — real LLM calls; skipped unless HARNESS_E2E=1
```

## License

MIT (see [LICENSE](LICENSE)).
