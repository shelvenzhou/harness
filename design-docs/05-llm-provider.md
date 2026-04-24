# 05 — LLM Provider

## Goal

A single `LlmProvider` interface used by the AgentRunner. Implementations:

- `MockProvider` — deterministic scripted outputs; drives unit + smoke tests.
- `AnthropicProvider` — real Claude (Messages API), tool use, cache_control,
  cache_edits.
- `OpenAIProvider` — later; interface is wide enough.

## Interface

```ts
interface LlmProvider {
  readonly id: string;              // 'anthropic' | 'mock' | …
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
  tools: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  cacheEdits?: CacheEdits;          // clear_tool_uses / clear_thinking (hot path)
  traceparent?: string;
}

type SamplingDelta =
  | { kind: 'text_delta'; text: string; channel?: 'reply' | 'preamble' }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'tool_call_begin'; toolCallId: string; name: string }
  | { kind: 'tool_call_arg_delta'; toolCallId: string; argsPartial: string }
  | { kind: 'tool_call_end'; toolCallId: string; args: unknown }
  | { kind: 'action'; action: Action }     // model-emitted meta action
  | { kind: 'usage'; tokens: TokenUsage }
  | { kind: 'end'; stopReason: string };
```

The runner transforms the delta stream into `Action`s and `Item`s. The
`Action` kind already in §1 (`reply / tool_call / spawn / wait / done`) is
produced by the runner from the stream; most providers don't emit `spawn`
directly — the model issues a `tool_call` to the `spawn` tool, and the
executor turns that into an action upstream.

## Action parsing

1. Stream `text_delta(channel=reply)` → accumulates into `reply` action at
   end of message.
2. Stream `tool_call_*` → each becomes a `tool_call` action.
3. Reasoning blocks → emitted as `reasoning` item (not an action).
4. Preamble text (short leading chunk) → tagged as `preamble` by a
   heuristic in the parser and emitted as its own item for pruning
   purposes.

The parser is testable in isolation against recorded deltas.

## Cache discipline

`sample` receives `cacheEdits` from the projection layer. Providers map:

- Anthropic: Messages API `cache_control` markers on prefix blocks + the
  `cache_edits` preview feature (when available) for tool-use / thinking
  suppression.
- Mock: ignored or echoed into test harness.

## Streaming, retries, fallback

- Provider owns stream parsing.
- Provider owns retry budget for transport errors (connection reset,
  rate-limit retry-after, …). Tool failures are **not** retried here; the
  agent sees them as tool_results.
- If the provider has both WS and HTTP transports (Codex does), it may
  fall back on failure. We don't bake this in; only the interface.

## MockProvider details

Used everywhere offline:

- Constructed with a scripted sequence of `SamplingDelta[]`.
- Optionally a function `(request) => SamplingDelta[]` for reactive tests.
- Exposes a `callLog` for assertions ("did the runner send the expected
  tail?").

Tests live in `tests/unit/llm/mock.test.ts` and `tests/smoke/*`.

## Anthropic adapter

Phase 1 lands the skeleton: constructor takes an API key, `sample` throws
`NotImplemented` but `capabilities` + `id` are populated. Real streaming,
cache_control and cache_edits land in a follow-up commit.
