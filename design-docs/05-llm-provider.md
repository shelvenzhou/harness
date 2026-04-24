# 05 — LLM Provider

## Goal

A single `LlmProvider` interface used by the AgentRunner. Phase 1 ships one
concrete implementation:

- `OpenAIProvider` — real streaming against the OpenAI Chat Completions
  API. Because the interface is OpenAI-compatible, the same provider also
  targets Azure OpenAI, OpenRouter, Together, Groq, and local vLLM / Ollama
  deployments by pointing `OPENAI_BASE_URL` elsewhere.

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
defaultMaxTokens  default 1024
defaultTemperature default 0.7
```

All of these are readable from the `.env` file via the CLI (see
`.env.example`).

Implementation notes:

- Uses `openai` npm client's `chat.completions.create({stream:true})`.
- Tool specs come from `StablePrefix.tools`; translated 1:1 to the API's
  `tools` parameter (function-calling).
- Streaming tool calls arrive indexed; the provider assembles argument
  JSON per index and emits `tool_call_begin` on first sight of a name,
  `tool_call_arg_delta` for each chunk, and `tool_call_end` at
  `finish_reason`.
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
