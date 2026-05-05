import OpenAI from 'openai';
import type { Stream } from 'openai/core/streaming.js';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.js';

import type { ToolCallId } from '@harness/core/ids.js';

import type {
  LlmCapabilities,
  LlmProvider,
  ProjectedContent,
  ProjectedItem,
  ResponseFormatSpec,
  SamplingDelta,
  SamplingRequest,
  StablePrefix,
} from './provider.js';

/**
 * OpenAI-compatible chat-completions provider.
 *
 * Uses the Chat Completions API so this provider also works against any
 * OpenAI-compatible endpoint (Azure, Together, Groq, OpenRouter, local
 * vLLM, etc.) by pointing `baseURL` elsewhere.
 *
 * Translates StablePrefix + ProjectedItem[] into the API's messages
 * array, and the streaming chunks back into our SamplingDelta shape.
 */

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  /**
   * Per-request retry budget for transport-level failures (network
   * errors, 5xx, 408, 429). Mid-stream errors are NOT retried — only
   * the initial connect/handshake. Default 2 (3 total attempts).
   * The OpenAI SDK exposes the same knob; we forward via the
   * client constructor so the same budget applies to non-streaming
   * paths if any are added later.
   */
  maxRetries?: number;
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_RETRIES = 2;

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false, // OpenAI caches automatically for long prefixes; no client control.
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 128_000,
  };

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;

  constructor(opts: OpenAIProviderOptions) {
    if (!opts.apiKey) throw new Error('OpenAIProvider requires an apiKey');
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 32768;
    this.defaultTemperature = opts.defaultTemperature ?? 0.7;
  }

  async *sample(
    request: SamplingRequest,
    signal: AbortSignal,
  ): AsyncIterable<SamplingDelta> {
    const messages = toChatMessages(request.prefix, request.tail);
    const tools = toChatTools(request.prefix);

    // OpenAI renamed `max_tokens` to `max_completion_tokens` for newer
    // (reasoning) models. `max_completion_tokens` is accepted across all
    // currently-supported chat-completions models, so we send that
    // universally.
    const stream = (await this.client.chat.completions.create(
      {
        model: request.model ?? this.model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: request.maxTokens ?? this.defaultMaxTokens,
        temperature: request.temperature ?? this.defaultTemperature,
        ...(request.responseFormat
          ? { response_format: toResponseFormat(request.responseFormat) }
          : {}),
      },
      { signal },
    )) as unknown as Stream<ChatCompletionChunk>;

    // Tool-call chunks arrive indexed; accumulate arg JSON per index and
    // emit SamplingDelta lifecycle events once complete.
    interface PartialToolCall {
      id: ToolCallId;
      name: string;
      argsText: string;
      began: boolean;
    }
    const partials = new Map<number, PartialToolCall>();
    // With `stream_options.include_usage: true`, OpenAI sends the usage
    // chunk AFTER the chunk that carries finish_reason (as a standalone
    // chunk with no `choices`). Defer the `end` delta until the loop
    // closes so we can emit `usage` first.
    let finalUsage:
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        }
      | undefined;
    let pendingStop: ReturnType<typeof mapStopReason> | undefined;
    let toolEndsEmitted = false;

    const emitToolEndsOnce = function* (): Generator<SamplingDelta> {
      if (toolEndsEmitted) return;
      toolEndsEmitted = true;
      for (const p of partials.values()) {
        if (!p.began) continue;
        yield {
          kind: 'tool_call_end',
          toolCallId: p.id,
          args: tryParseJson(p.argsText),
        };
      }
    };

    try {
      for await (const chunk of stream) {
        if (signal.aborted) return;
        if (chunk.usage) finalUsage = chunk.usage;
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          // Don't tag with channel here. Let actionParser apply the
          // preamble heuristic: text flushed because of a following
          // tool_call gets `preamble`; trailing text gets `reply`.
          yield { kind: 'text_delta', text: delta.content };
        }
        // Reasoning content is non-standard on the Chat Completions API
        // surface — newer reasoning models (o1/o3 family + the OpenAI
        // Responses API shim) attach a `reasoning_content` field on the
        // delta; some compatible endpoints use `reasoning`. Probe both.
        const reasoningText = readReasoningField(delta);
        if (reasoningText) {
          yield { kind: 'reasoning_delta', text: reasoningText };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let p = partials.get(idx);
            if (!p) {
              p = {
                id: (tc.id ?? `tc_${idx}`) as ToolCallId,
                name: tc.function?.name ?? '',
                argsText: '',
                began: false,
              };
              partials.set(idx, p);
            } else if (tc.id && p.id !== (tc.id as ToolCallId)) {
              p.id = tc.id as ToolCallId;
            }
            if (tc.function?.name && !p.name) p.name = tc.function.name;
            if (tc.function?.arguments) p.argsText += tc.function.arguments;
            if (!p.began && p.name) {
              p.began = true;
              yield { kind: 'tool_call_begin', toolCallId: p.id, name: p.name };
            }
            if (tc.function?.arguments) {
              yield {
                kind: 'tool_call_arg_delta',
                toolCallId: p.id,
                argsPartial: tc.function.arguments,
              };
            }
          }
        }
        if (choice.finish_reason) {
          pendingStop = mapStopReason(choice.finish_reason);
          for (const d of emitToolEndsOnce()) yield d;
          // Don't yield `end` yet — wait for the trailing usage chunk.
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      throw err;
    }

    // Stream closed — emit any tool_call_ends we missed (defensive), the
    // usage if it arrived, and the terminal `end`.
    for (const d of emitToolEndsOnce()) yield d;
    if (finalUsage) {
      yield {
        kind: 'usage',
        tokens: {
          promptTokens: finalUsage.prompt_tokens ?? 0,
          cachedPromptTokens: finalUsage.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: finalUsage.completion_tokens ?? 0,
        },
      };
    }
    yield { kind: 'end', stopReason: pendingStop ?? 'end_turn' };
  }
}

// ─── translation helpers ───────────────────────────────────────────────────

function toChatMessages(
  prefix: StablePrefix,
  tail: ProjectedItem[],
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  // Pinned memory + compacted summary now arrive as synthetic head-of-tail
  // items (with cacheTags PINNED_MEMORY_CACHE_TAG / COMPACTED_SUMMARY_CACHE_TAG)
  // so the system message stays byte-stable across pin/unpin and compaction
  // events. The provider's automatic prompt-prefix cache hits as long as
  // system + tools don't mutate.
  messages.push({ role: 'system', content: prefix.systemPrompt });

  let pendingAssistant:
    | {
        textChunks: string[];
        toolCalls: NonNullable<
          Extract<ChatCompletionMessageParam, { role: 'assistant' }>['tool_calls']
        >;
      }
    | undefined;
  const flushAssistant = (): void => {
    if (!pendingAssistant) return;
    messages.push({
      role: 'assistant',
      ...(pendingAssistant.textChunks.length > 0
        ? { content: pendingAssistant.textChunks.join('') }
        : { content: null }),
      ...(pendingAssistant.toolCalls.length > 0 ? { tool_calls: pendingAssistant.toolCalls } : {}),
    });
    pendingAssistant = undefined;
  };

  for (const item of tail) {
    if (item.role === 'user') {
      flushAssistant();
      messages.push({ role: 'user', content: contentToText(item.content) });
      continue;
    }
    if (item.role === 'tool_result') {
      flushAssistant();
      for (const c of item.content) {
        if (c.kind === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: c.toolCallId,
            content: JSON.stringify(c.ok ? (c.output ?? null) : { error: c.error ?? 'error' }),
          });
        } else if (c.kind === 'elided') {
          // Elided tool_result. We MUST still emit a `tool` role message
          // with the original tool_call_id so OpenAI's pairing invariant
          // holds — otherwise the next request errors with
          // "tool_calls did not have response messages". Body becomes a
          // compact placeholder; the LLM can `restore(handle)` to inline
          // the full content on the next sampling.
          if (c.toolCallId) {
            messages.push({
              role: 'tool',
              tool_call_id: c.toolCallId,
              content: JSON.stringify({
                elided: true,
                handle: c.handle,
                kind: c.originKind,
                summary: c.summary,
                hint: 'call restore(handle) to rehydrate full content',
              }),
            });
          } else {
            // Elided block that wasn't standing in for a tool_result —
            // safe to render as plain user text.
            messages.push({
              role: 'user',
              content: `[elided handle=${c.handle} kind=${c.originKind}] ${c.summary ?? ''}`,
            });
          }
        }
      }
      continue;
    }
    if (!pendingAssistant) {
      pendingAssistant = { textChunks: [], toolCalls: [] };
    }
    const textChunks: string[] = [];
    const toolCalls: NonNullable<
      Extract<ChatCompletionMessageParam, { role: 'assistant' }>['tool_calls']
    > = [];
    for (const c of item.content) {
      switch (c.kind) {
        case 'text':
          textChunks.push(c.text);
          break;
        case 'tool_use':
          toolCalls.push({
            id: c.toolCallId,
            type: 'function',
            function: {
              name: c.name,
              arguments: JSON.stringify(c.args ?? {}),
            },
          });
          break;
        case 'elided':
          textChunks.push(`[elided handle=${c.handle} ${c.originKind}] ${c.summary ?? ''}`);
          break;
        case 'tool_result':
          // Should never appear in assistant content; ignore defensively.
          break;
      }
    }
    pendingAssistant.textChunks.push(...textChunks);
    pendingAssistant.toolCalls.push(...toolCalls);
  }

  flushAssistant();

  return messages;
}

export const __testOnly = {
  toChatMessages,
  toResponseFormat,
  readReasoningField,
};

function toChatTools(prefix: StablePrefix): ChatCompletionTool[] {
  return prefix.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.argsSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    },
  }));
}

function contentToText(content: ProjectedContent[]): string {
  return content
    .map((c) => {
      if (c.kind === 'text') return c.text;
      if (c.kind === 'elided') return `[elided ${c.originKind}] ${c.summary ?? ''}`;
      return '';
    })
    .join('');
}

function tryParseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function mapStopReason(
  reason: string,
): 'end_turn' | 'max_tokens' | 'tool_use' | 'error' {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'error';
  }
}

/**
 * Translate the harness's `ResponseFormatSpec` into the OpenAI Chat
 * Completions `response_format` shape. JSON-schema mode picks up
 * `strict: true` by default so the API enforces shape; callers can
 * opt out by setting `strict: false`.
 */
function toResponseFormat(
  spec: ResponseFormatSpec,
): NonNullable<ChatCompletionCreateParamsStreaming['response_format']> {
  if (spec.type === 'json_object') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: spec.name,
      schema: spec.schema as Record<string, unknown>,
      strict: spec.strict ?? true,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
    },
  };
}

/**
 * Pull the model's reasoning text out of a streaming delta. The
 * official ChatCompletionChunk type doesn't declare these fields, so
 * we widen and probe several common spellings:
 *   - `reasoning_content` — o1/o3 family on the Chat Completions API
 *     and the Responses API passthrough.
 *   - `reasoning` — OpenRouter's `reasoning` extension and some other
 *     OpenAI-compatible gateways.
 *   - `thinking` — Anthropic-style; surfaces on Anthropic-compatible
 *     shims that pretend to be OpenAI.
 *   - `reasoning.text` / `thinking.text` — object forms used by a few
 *     gateways that wrap Anthropic's structured `thinking` blocks.
 * Returns the empty string when none are set.
 */
function readReasoningField(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return '';
  const obj = delta as Record<string, unknown>;
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (v && typeof v === 'object') {
      const text = (v as Record<string, unknown>)['text'];
      if (typeof text === 'string' && text.length > 0) return text;
    }
  }
  return '';
}
