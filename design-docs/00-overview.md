# 00 — Overview

## What we are building

A **general-purpose agent runtime** where the LLM is the sole dispatcher. The
runtime ships a small orthogonal tool set and a set of decoupled async loops
connected by an event bus. The "agent loop" is not a hard-coded ReAct
template; it is an emergent shape produced by the model composing uniform
`Action` values.

## Five principles

### 1. AI-native control flow

The runtime does not contain `while (!done)`. Each model turn produces a list
of **actions**:

- `reply(text)` — emit to user
- `tool_call(name, args)` — call a tool (may be many in parallel)
- `spawn(task, budget)` — fork a subagent with its own session
- `wait(event_spec)` — yield until an event matches
- `done(summary)` — this task is done; persist to memory

"Thinking" is not a separate channel; it is a `reply(internal=true)` or a
tool call. Verification is not a primitive; it is `spawn(role=verifier, …)`.
Planning is not a primitive; it is `memory(write, "plan", …)` plus ordinary
replies. Simple tasks resolve in `reply → done`; complex tasks grow a deeper
shape because the model chose to compose more actions.

### 2. Minimal orthogonal tool set

~7 primitives, chosen so that composition + `spawn` covers the rest:

| tool       | purpose                          |
|------------|----------------------------------|
| `shell`    | arbitrary command (sandboxed later) |
| `read`     | structured file read (handle-friendly) |
| `write`    | structured file write (diffable) |
| `web_fetch` / `web_search` | external knowledge   |
| `spawn`    | async subagent — the composition glue |
| `memory`   | read/write long/short memory     |
| `restore`  | rehydrate an elided event by handle |
| `wait`     | yield until an event matches     |

No `verify`, `plan`, `patch`, `todo`, `image_generate` tool. Each of those is
either a `spawn` target, a `memory` key, or a `shell` + `write` composition.

See [03-tools.md](03-tools.md) for the full interface and decision hints.

### 3. Async decoupled loops

Three loops, never calling each other directly:

- Conversation adapter (user I/O)
- AgentRunner (LLM + action dispatch)
- ToolExecutor (tool workers)

All three plus the scheduler and subagent pool communicate through a typed
`EventBus`. Long tools don't block the runner; new user messages can preempt;
parallel tool calls fan out and the runner is re-invoked per result.

See [01-runtime.md](01-runtime.md) and [02-events-and-state.md](02-events-and-state.md).

### 4. Cache-friendly aggressive context pruning

Context is layered: a stable prefix (system + tool specs + pinned memory +
session summary) and an append-only tail. The tail can be projected into the
prompt with aggressive pruning, but every elided block leaves behind a
**handle** that the `restore` tool can dereference.

Two pruning paths:

- **Hot cache (short idle)** — use the provider's logical-hide mechanism
  (Anthropic `cache_edits` / equivalent), keep the bytes on the wire, drop
  them from the model's view. Prefix cache stays 100% hit.
- **Cold cache (long idle)** — physically rewrite the message; cheaper
  on-the-wire token count, accept the cache miss.

Auto-compaction is itself a subagent (`spawn(compactor, …)`) and produces a
structured `CompactedSummary = {reinject, summary, recent_user_turns,
ghost_snapshots, active_handles}` that replaces the summary slot in the
stable prefix.

See [04-context.md](04-context.md).

### 5. Security / sandbox later, interface today

Every side-effectful tool goes through a single `Executor` interface.
Swapping the implementation for a sandboxed backend (Seatbelt / Landlock /
Bubblewrap / Windows restricted token) is the only required change when the
sandbox layer lands. Network egress goes through an analogous policy layer.
These are not priorities for the initial landing, but the indirection is.

## Goals (this phase)

- Complete architecture surface: every box in the diagram exists in code with
  a typed interface.
- A working terminal adapter + mock LLM provider end-to-end.
- Unit / smoke tests run offline. E2E tests opt-in via `HARNESS_E2E=1`.
- Design docs checked in; README links to them.

## Non-goals (this phase)

- Real sandboxing.
- Real tool implementations (`shell` may shell out, but network, permissions,
  long-running PTY state, etc. are deferred).
- Persistent storage (SessionStore is memory + JSONL append; no DB).
- UI polish beyond a working REPL.
- Compaction LLM prompts tuned; the pipeline exists, the summarizer can be a
  stub or mock-only.

## Prior art we lean on

- **Codex** — `Submission/Event` queue model, `Thread/Turn/Item` three-layer
  persistence abstraction, `ActiveTurn.MailboxDeliveryPhase`, Mementos for
  compaction, prompt-debug as first-class diagnostic, W3C traceparent
  propagated to subagents, tool-description-as-decision-hint.
- **Claude Code** — `queryLoop` minimalism, `microCompact` dual-track
  (physical rewrite vs. `cache_edits`), conservative token estimation,
  streaming tool executor with ordered output buffering.

Where we depart: we do not bake ReAct into the runner; all subtask forms
(verify, plan, compact, review) converge on `spawn` + memory; and we commit
to a very small primitive tool surface.

See [../references/notes/](../references/notes/) for per-topic analyses of
both systems.
