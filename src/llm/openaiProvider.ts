import OpenAI from 'openai';
import type { Stream } from 'openai/core/streaming.js';
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';

import type { ToolCallId } from '@harness/core/ids.js';

import type {
  LlmCapabilities,
  LlmProvider,
  ProjectedContent,
  ProjectedItem,
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
}

const DEFAULT_MODEL = 'gpt-4o-mini';

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
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 1024;
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
    let finalUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    try {
      for await (const chunk of stream) {
        if (signal.aborted) return;
        const choice = chunk.choices[0];
        if (!choice) {
          if (chunk.usage) finalUsage = chunk.usage;
          continue;
        }
        const delta = choice.delta;
        if (delta?.content) {
          yield { kind: 'text_delta', text: delta.content, channel: 'reply' };
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
          for (const p of partials.values()) {
            if (!p.began) continue;
            yield {
              kind: 'tool_call_end',
              toolCallId: p.id,
              args: tryParseJson(p.argsText),
            };
          }
          if (finalUsage) {
            yield {
              kind: 'usage',
              tokens: {
                promptTokens: finalUsage.prompt_tokens ?? 0,
                cachedPromptTokens: 0,
                completionTokens: finalUsage.completion_tokens ?? 0,
              },
            };
          }
          yield { kind: 'end', stopReason: mapStopReason(choice.finish_reason) };
        }
        if (chunk.usage) finalUsage = chunk.usage;
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      throw err;
    }
  }
}

// ─── translation helpers ───────────────────────────────────────────────────

function toChatMessages(
  prefix: StablePrefix,
  tail: ProjectedItem[],
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  const systemParts = [prefix.systemPrompt];
  if (prefix.pinnedMemory.length > 0) {
    systemParts.push('\n[pinned memory]');
    for (const m of prefix.pinnedMemory) systemParts.push(`- ${m}`);
  }
  if (prefix.compactedSummary) {
    systemParts.push('\n[compacted summary]');
    systemParts.push(prefix.compactedSummary);
  }
  messages.push({ role: 'system', content: systemParts.join('\n') });

  for (const item of tail) {
    if (item.role === 'user') {
      messages.push({ role: 'user', content: contentToText(item.content) });
      continue;
    }
    if (item.role === 'tool_result') {
      for (const c of item.content) {
        if (c.kind === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: c.toolCallId,
            content: JSON.stringify(c.ok ? (c.output ?? null) : { error: c.error ?? 'error' }),
          });
        } else if (c.kind === 'elided') {
          // Elided tool_result — inject as a user message with handle hint,
          // since OpenAI's tool role expects a concrete tool_call_id.
          messages.push({
            role: 'user',
            content: `[elided tool result handle=${c.handle} kind=${c.originKind}] ${c.summary ?? ''}`,
          });
        }
      }
      continue;
    }
    // assistant
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
    messages.push({
      role: 'assistant',
      ...(textChunks.length > 0 ? { content: textChunks.join('') } : { content: null }),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return messages;
}

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
