# 03 — Tools

## Principle

**Minimum orthogonal set.** The harness ships ~7 primitives. Every higher-level
capability (verify, plan, review, image gen, patch apply, long-running PTY,
research pipeline) is built by the model composing these primitives plus
`spawn`. We do **not** grow the tool surface to track product features.

## The primitives

| tool        | arguments                                         | notes |
|-------------|---------------------------------------------------|-------|
| `shell`     | `{cmd, cwd?, timeoutMs?, maxOutputBytes?}`        | The only way to run arbitrary code. Sandboxed later. |
| `read`      | `{path, byteRange?}`                              | Separate from shell because we want handle-friendly outputs and predictable diff targets. |
| `write`     | `{path, content, mode: 'overwrite' \| 'patch'}`   | Patch mode accepts unified diff. |
| `web_fetch` | `{url, maxOutputBytes?}`                          | Fetch only. No crawling. |
| `web_search`| `{query, topK?}`                                  | Thin wrapper over a configurable search backend. |
| `spawn`     | `{task, budget, inheritTurns?, role?, policy?}`   | Forks a subagent. **Composition primitive.** |
| `memory`    | `{op: 'get'\|'set'\|'delete'\|'search', key?, value?, query?}` | Key/value + semantic search. |
| `restore`   | `{handle}`                                        | Rehydrate an elided event. |
| `wait`      | `{eventSpec, timeoutMs?}`                         | Yield until a matching event arrives. |

9 entries; "tool" here is counted generously. These are the primitives; a
registry decides which are exposed per-turn.

### Notably absent

- `verify` — use `spawn({role: 'verifier', …})`.
- `plan` / `update_plan` — use `memory({op: 'set', key: 'plan', value})` +
  `reply(preamble)`.
- `apply_patch` — use `write({mode: 'patch'})` or `shell({cmd: 'patch'})`.
- `image_generate` — use `spawn({role: 'image', …})`.
- `ask_user` — use `reply()` + `wait({eventSpec: 'user_input'})`.

## Tool interface (code)

```ts
interface Tool<Args, Output> {
  readonly name: string;
  readonly description: string;    // includes decision hints for the LLM
  readonly schema: ZodType<Args>;
  readonly concurrency: 'safe' | 'serial';
  execute(args: Args, ctx: ToolExecutionContext): Promise<ToolResult<Output>>;
}

interface ToolResult<Output> {
  ok: boolean;
  output?: Output;
  error?: { kind: string; message: string; retryable?: boolean };
  elided?: { handle: string; kind: string; meta: Record<string, unknown> };
  originalBytes?: number;
  bytesSent?: number;
}
```

`description` is load-bearing: it includes **decision hints** ("use spawn
only for off-critical-path work"), because the model reads it to decide when
and how to use the tool. Codex does this for `spawn_agent`; we copy the
pattern.

## Executor

- One `ToolExecutor` per runtime instance.
- `submit(call) → Promise<ToolResult>` is called by the AgentRunner.
- Concurrent-safe tools run in parallel; serial tools (`shell` by default)
  queue per-thread to avoid cwd / env races.
- Results are **buffered into the model's requested order** before being
  emitted as `tool_result` events, matching Codex's `FuturesOrdered`.
- Every execution runs under an `AbortSignal`; interrupts cancel in flight.

## Output pruning at the executor edge

Before the tool result is persisted, the executor may apply elision rules by
tool kind:

| tool        | elision strategy                                          |
|-------------|-----------------------------------------------------------|
| `shell`     | keep cmd, exit code, last 20 lines; handle for full log   |
| `read`      | keep path + hash + byte range; handle for content         |
| `write`     | keep path + bytes written + hash; no content in log       |
| `web_fetch` | keep url + status + summary; handle for body              |
| `web_search`| keep query + top-k titles; handle for full result JSON    |
| `spawn`     | keep child threadId + role + outcome; handle for full summary |

The full payload is always available from the SessionStore (and therefore
`restore` works). The projection layer enforces that the LLM sees the
elided form by default.

## Adding a tool

1. Create `src/tools/<name>.ts`, export a `Tool` conforming to the interface.
2. Write unit tests under `tests/unit/tools/<name>.test.ts`; exercise
   `schema.parse`, `execute`, and the elision logic.
3. Register it in `src/tools/registry.ts`. The registry is the one place
   choosing which tools are offered per turn.
4. Update `design-docs/03-tools.md` only if you are introducing a new
   primitive. Capabilities should usually land as compositions, not new
   primitives.

## Tool discovery and the prefix cache

Tool specs are in the stable prefix. Changing the exposed tool set therefore
invalidates the prefix cache. The registry treats "tool set changed" as a
**compaction boundary** — we accept one cache miss and the prefix restabilises
afterward. This is why the set needs to be small: every extension multiplies
the risk of unneeded invalidations.

## Spawn semantics in detail

`spawn` is the single composition primitive. Its LLM-facing description
includes:

> Use `spawn` when the child task can proceed without blocking the current
> decision path — e.g. background research, verification of a completed
> artefact, parallel experiments. Do not use spawn on the critical path;
> doing the work inline in this turn is cheaper and clearer.

Arguments:

- `task` — freeform string; becomes the child's initial user message.
- `budget` — `{maxTurns, maxToolCalls, maxWallMs}`; child is killed on breach.
- `inheritTurns` — 0 by default. If > 0, copies the last N turns from the
  parent's context (the only way contexts ever share).
- `role` — optional freeform tag; shows in traces and affects which system
  prompt preset is used.
- `policy` — `{canSpawn, allowedTools}`; defaults to inherit parent's.

`spawn` returns a handle; the child's `turn_complete` with `summary` bubbles
back as `subtask_complete` on the parent's bus.
