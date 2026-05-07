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

## Discord adapter (v1)

`src/adapters/discord.ts`. Supports fixed-channel and per-channel
binding. With `DISCORD_CHANNEL_ID`, one designated channel maps to the
root thread. Without it, each Discord channel gets its own root
thread/session, created only when the first message in that channel
explicitly mentions the bot.

- inbound `MessageCreate` on a bound channel becomes `user_turn_start`
  (no active turn) or `user_input` (active turn). Bot authors are
  dropped. In dynamic per-channel mode, unbound channels are ignored
  unless the message mentions the bot; that first mention binds the
  channel and strips the mention from the user text. A bare `@bot`
  with no other content binds the channel and posts a one-line
  greeting without starting a turn. `/interrupt` publishes an
  `Interrupt` event for that channel's thread.
- channel→thread mappings persist across restarts. Each per-channel
  thread is stored under the title `discord:<channelId>`; on
  startup the adapter scans the store, repopulates `channelThreads`,
  and asks the runtime to re-adopt each runner (`Runtime.adoptRoot
  Thread`). Non-mention follow-ups in a previously-bound channel
  keep working after a bounce.
- outbound rendering uses **live message editing** for streaming
  channels: the first delta posts a placeholder; subsequent deltas
  edit it (throttled to ~750ms) until it hits a 1900-char soft cap,
  at which point the message is finalised and a continuation opens.
  Channel switches (e.g. preamble → reply, or reasoning → reply)
  close the current live message before the next stream starts.
- reasoning-echo handling: the model often emits its reasoning
  summary as preflight text prefixed with `[reasoning]` because
  pruning projects past reasoning back as `[reasoning] X` assistant
  content and the model parrots that pattern. At sampling flush we
  detect the prefix on a still-open live message and re-edit it
  with the gray `> …` quote-block reasoning rendering (marker stripped), so
  the user sees one gray block per reasoning instead of black + gray.
- discrete events: `tool_call` posts a `-# 🔧 <name> <arg>` status
  line; the matching successful `tool_result` edits that line in
  place to `-# ✓ …`, while a failure posts a separate `-# ✗ tool
  failed: …` line. `wait` and `session` calls (and `running`
  results) stay hidden. `subtask_complete` lands as a Discord embed
  (↩️). `interrupt` posts a `-# ⏸️ interrupt …` line.
  `compaction_event` posts a one-line summary. `turn_complete` is
  silent for completed turns and posts `-# turn <status> — …` for
  non-completed ones.
- the persisted `reply` / `preamble` / `reasoning` events dedupe
  against the streamed buffer on any channel; mismatches (provider
  didn't stream, or parser reclassified mid-stream) post a fresh
  fallback. Persisted reply/preamble whose text starts with
  `[reasoning]` is also routed to the gray reasoning render.
- the discord.js client lives behind a `DiscordTransport` interface
  so unit tests inject a fake (no real login). The real transport
  lazy-imports `discord.js` so the module loads without the package
  available.

Wired at `--adapter discord` (or `HARNESS_ADAPTER=discord`) with
`DISCORD_BOT_TOKEN`. `DISCORD_CHANNEL_ID` is optional; unset means
dynamic per-channel sessions.

## Future: Telegram / HTTP

Sketches, not implemented:

- **Telegram**: per-chat binding. Typing indicator driven by turn state.
- **HTTP / webhook**: one-shot turns; the HTTP handler synthesises
  `UserTurnStart`, `await`s `TurnComplete`, returns the summary.

Each of these is ~200 lines and lands independently. The runtime never
learns about their existence.

## Multi-adapter

The bus supports multiple adapters at once. A single runtime can serve a
terminal REPL, a Discord bot, and an HTTP endpoint simultaneously. Thread
bindings keep them isolated.

## Adapters vs. actor mode

An adapter is an I/O bridge: it translates external events into bus events
on a target thread and renders bus events back out. It does **not** run its
own LLM loop. When an external integration needs its own LLM-driven loop,
its own state, or peer-to-peer communication with other agents, it crosses
into actor territory — see [10-actor-mode.md](10-actor-mode.md). That
document is deferred and should not be implemented until a concrete
multi-agent use case lands; until then, every external surface is an
adapter.

If/when actor mode lands, untrusted external inputs (Discord, webhooks)
must be projected with an explicit untrusted-source frame so prompt
injection from a public channel cannot be confused with a local user
instruction. This boundary is called out in
[10-actor-mode.md](10-actor-mode.md#5-untrusted-input-boundary-in-projection)
and must precede any actor-mode external endpoint exposure.

## Adding an adapter — checklist

1. Create `src/adapters/<name>.ts` implementing `Adapter`.
2. Map external I/O → bus events. Respect the `ThreadBinding`.
3. Subscribe to `reply / preamble / turn_complete / compaction_event (opt)`.
4. Handle `Interrupt` and lifecycle cleanly (`stop()` must drain).
5. Tests under `tests/unit/adapters/<name>.test.ts` driving a FakeTransport.
