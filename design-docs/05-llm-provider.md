# 05 — LLM Provider

## Goal

A single `LlmProvider` interface used by the AgentRunner. Phase 1 ships one
concrete implementation:

- `OpenAIProvider` — real streaming against either the OpenAI Responses API
  or Chat Completions API. Responses is the default for native reasoning
  summaries/provider-state carry-forward; Chat Completions is available for
  OpenAI-compatible model hosts that do not implement `/v1/responses`.

Other providers (Anthropic, Gemini, Bedrock) slot into the same interface
later.

## Interface

```ts
interface LlmProvider {
  readonly id: string;              // 'openai' | 'anthropic' | …
  readonly capabilities: LlmCapabilities;

  sample(
    request: SamplingRequest,
    signal: AbortSignal,
  ): AsyncIterable<SamplingDelta>;
}

interface LlmCapabilities {
  prefixCache: boolean;
  cacheEdits: boolean;              // Anthropic cache_edits / equivalent
  nativeToolUse: boolean;
  nativeReasoning: boolean;
  maxContextTokens: number;
}

interface SamplingRequest {
  prefix: StablePrefix;             // system / tools / pinned memory / summary
  tail: ProjectedItem[];            // elided view of recent items
  temperature?: number;
  maxTokens?: number;
  cacheEdits?: CacheEdits;          // clear_tool_uses / clear_thinking (hot path)
  traceparent?: string;
  model?: string;                   // provider-specific override
}

type SamplingDelta =
  | { kind: 'text_delta'; text: string; channel?: 'reply' | 'preamble' }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'tool_call_begin'; toolCallId: string; name: string }
  | { kind: 'tool_call_arg_delta'; toolCallId: string; argsPartial: string }
  | { kind: 'tool_call_end'; toolCallId: string; args: unknown }
  | { kind: 'usage'; tokens: TokenUsage }
  | { kind: 'end'; stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'error' };
```

The runner transforms the delta stream into `Action`s and `Item`s. Most
providers don't emit `spawn` directly — the model issues a `tool_call` to
the `spawn` tool, and the AgentRunner intercepts it upstream.

## Action parsing

1. Stream `text_delta(channel=reply)` accumulates into a `reply` action at
   end of message.
2. Stream `tool_call_*` → each becomes a `tool_call` action, assembled from
   the streamed argument deltas.
3. Reasoning blocks → emitted as `reasoning` item (not an action).
4. Preamble text (short leading chunk, channel='preamble') becomes its own
   item for pruning purposes.

The parser is testable in isolation against recorded deltas
(`tests/unit/llm/actionParser.test.ts`).

## OpenAIProvider details

Constructor config (`OpenAIProviderOptions`):

```
apiKey            required
model             default 'gpt-4o-mini'
baseURL           override to hit any OpenAI-compatible endpoint
apiMode           'responses' (default) | 'chat_completions'
chatMaxTokensParam 'max_completion_tokens' (default) | 'max_tokens'
defaultMaxTokens  default 32768
defaultTemperature optional
```

All of these are readable from the `.env` file via the CLI (see
`.env.example`).

Implementation notes:

- Uses `openai` npm client's `responses.create({stream:true})` in Responses
  mode and `chat.completions.create({stream:true})` in Chat Completions mode.
- Tool specs come from `StablePrefix.tools`; translated 1:1 to the API's
  `tools` parameter (function-calling). Responses uses top-level function
  tools; Chat Completions uses `{type:"function", function:{...}}`.
- Streaming tool calls are assembled into the common `SamplingDelta`
  contract. Responses keys lifecycle by item id / call id; Chat
  Completions keys partial calls by stream index until the final tool-call
  id/name is known.
- Responses mode preserves encrypted reasoning items as provider_state so a
  later request can hand them back to OpenAI. Chat Completions mode cannot
  surface reasoning deltas or encrypted reasoning state, so those pieces are
  unavailable on that transport.
- `cacheEdits` is a no-op here; the underlying API caches long prefixes
  server-side but doesn't expose a client-side suppression API. The
  capability flag reflects this.
- Respects the `AbortSignal` — interrupts cancel in-flight streams
  without a thrown `AbortError` leaking out.

## Cache discipline (future)

For providers that support logical suppression (Anthropic `cache_edits`),
the runner will populate `request.cacheEdits` based on pruning decisions
so the provider can tell the model to ignore specific `tool_use` /
reasoning blocks while the physical bytes remain on the wire for prefix
cache hits. The OpenAI path pays the bytes every time (mitigated by
server-side automatic caching for long stable prefixes) until we add a
provider that exposes logical suppression.

## Streaming, retries, fallback

- Provider owns stream parsing.
- Provider owns retry budget for transport errors (connection reset,
  rate-limit retry-after, …). Tool failures are **not** retried here; the
  agent sees them as tool_results and decides.
- Fallback transports (WS → HTTP, secondary endpoint) are the provider's
  concern, not the runtime's.

## Model alias routing

The CLI can register multiple `.env` model aliases as subagent provider keys:

```dotenv
HARNESS_MAIN_MODEL=main
HARNESS_MODEL_ALIASES=main,fast,local
HARNESS_MODEL_MAIN=openai|gpt-5.4|responses||
HARNESS_MODEL_FAST=openai|gpt-4o-mini|chat_completions||
HARNESS_MODEL_LOCAL=openai|qwen2.5-coder|chat_completions|http://localhost:11434/v1|OPENAI_LOCAL_API_KEY
```

The root runner is built from `HARNESS_MAIN_MODEL` when present. Every alias in
`HARNESS_MODEL_ALIASES` is also registered in `SubagentPool.providerFactories`,
so the parent model can choose `spawn({provider:"fast", ...})` or
`spawn({provider:"local", ...})`. A spawn without `provider` still inherits the
runtime default provider.

Bootstrap can append a `[runtime model]` block to each agent's system prompt
from `RuntimeModelInfo`. The CLI fills this from `.env`: root agents get the
selected `HARNESS_MAIN_MODEL`/raw model config, and alias-routed subagents get
the matching `HARNESS_MODEL_<ALIAS>` config. The block includes alias,
provider, model id, API mode, and base URL only; credential env names and API
keys are never injected.
