# 06 — Adapters

## Purpose

An **adapter** is everything on the user side of the runtime: terminal REPL,
Discord bot, Telegram bot, HTTP webhook, IDE integration. The runtime knows
nothing about which one is connected — adapters translate external I/O into
events and back.

## Interface

```ts
interface Adapter {
  readonly id: string;                        // 'terminal' | 'discord' | …
  start(bus: EventBus, opts: AdapterStartOptions): Promise<void>;
  stop(): Promise<void>;
}

interface AdapterStartOptions {
  threadBinding: ThreadBinding;               // how to map external session → thread
}

type ThreadBinding =
  | { kind: 'single'; threadId: string }
  | { kind: 'per-channel'; resolve: (externalChannelId: string) => string };
```

The adapter publishes `UserTurnStart / UserInput / Interrupt` onto the bus
for the correct thread; it subscribes to `Reply / Preamble / TurnComplete`
for its threads and renders them.

## Terminal adapter (phase 1)

`src/adapters/terminal.ts`:

- stdin line reader; each line is a `UserInput` or `UserTurnStart` depending
  on whether a turn is active.
- stdout renderer that streams `reply / preamble` chunks with a light prefix
  (`» ` for the user, `▸ ` for the agent, dim grey for preambles).
- `Ctrl-C` sends `Interrupt` once (soft); twice in a second sends `Shutdown`.
- Single thread bound at startup (`threadBinding: { kind: 'single' }`).

## Future: Discord / TG / HTTP

Sketches, not implemented in phase 1:

- **Discord**: DM = thread; guild channel = thread. `per-channel` binding.
  Long messages split into multiple `Reply`s at Discord's 2000-char limit.
  Attachments become `read` tool calls at the model's discretion.
- **Telegram**: per-chat binding. Typing indicator driven by turn state.
- **HTTP / webhook**: one-shot turns; the HTTP handler synthesises
  `UserTurnStart`, `await`s `TurnComplete`, returns the summary.

Each of these is ~200 lines and lands independently. The runtime never
learns about their existence.

## Multi-adapter

The bus supports multiple adapters at once. A single runtime can serve a
terminal REPL, a Discord bot, and an HTTP endpoint simultaneously. Thread
bindings keep them isolated.

## Adding an adapter — checklist

1. Create `src/adapters/<name>.ts` implementing `Adapter`.
2. Map external I/O → bus events. Respect the `ThreadBinding`.
3. Subscribe to `reply / preamble / turn_complete / compaction_event (opt)`.
4. Handle `Interrupt` and lifecycle cleanly (`stop()` must drain).
5. Tests under `tests/unit/adapters/<name>.test.ts` driving a FakeTransport.
