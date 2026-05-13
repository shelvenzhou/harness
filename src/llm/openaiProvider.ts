import OpenAI from 'openai';
import type { Stream } from 'openai/core/streaming.js';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions.js';
import type {
  EasyInputMessage,
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFormatTextConfig,
  ResponseInput,
  ResponseInputItem,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses.js';
import type { Reasoning, ReasoningEffort } from 'openai/resources/shared.js';

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
 * OpenAI provider.
 *
 * Defaults to the Responses API because it can surface reasoning
 * summaries and encrypted reasoning carry-forward state. Set
 * `apiMode:'chat_completions'` for OpenAI-compatible endpoints that
 * only implement `/v1/chat/completions`.
 *
 * Translation overview:
 *   StablePrefix.systemPrompt      → `instructions`
 *   StablePrefix.tools             → `tools` (FunctionTool, top-level
 *                                     `name`/`parameters`)
 *   ProjectedItem[]                → `input` (ResponseInput); each
 *                                     assistant tool_use becomes its
 *                                     own `function_call` input item
 *                                     and each tool_result becomes a
 *                                     `function_call_output` item
 *   stream events                  → SamplingDelta
 *
 * In Chat Completions mode the same harness projection maps to
 * `messages` + `tools`. Some OpenAI-compatible endpoints (notably
 * DeepSeek thinking models) also stream and require echoed
 * `reasoning_content`; opaque Responses provider_state remains
 * Responses-only.
 */

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
  apiMode?: OpenAIApiMode;
  chatMaxTokensParam?: 'max_completion_tokens' | 'max_tokens';
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  /**
   * Per-request retry budget for transport-level failures (network
   * errors, 5xx, 408, 429). Mid-stream errors are NOT retried — only
   * the initial connect/handshake. Default 2 (3 total attempts).
   */
  maxRetries?: number;
  /**
   * Optional reasoning controls. `effort` selects how much budget the
   * model can spend thinking; `summary` opts into the reasoning
   * summary stream. Defaults to `{ summary: 'auto' }` so reasoning
   * text shows up automatically on reasoning-capable models.
   */
  reasoning?: {
    effort?: ReasoningEffort | null;
    summary?: 'auto' | 'concise' | 'detailed' | null;
  };
}

export type OpenAIApiMode = 'responses' | 'chat_completions';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_RETRIES = 2;

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai';
  readonly capabilities: LlmCapabilities;

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly apiMode: OpenAIApiMode;
  private readonly chatMaxTokensParam: 'max_completion_tokens' | 'max_tokens';
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number | undefined;
  private readonly reasoning: Reasoning | undefined;

  constructor(opts: OpenAIProviderOptions) {
    if (!opts.apiKey) throw new Error('OpenAIProvider requires an apiKey');
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.apiMode = opts.apiMode ?? 'responses';
    this.chatMaxTokensParam = opts.chatMaxTokensParam ?? 'max_completion_tokens';
    this.capabilities = {
      prefixCache: false, // Server-side automatic caching; no client knob.
      cacheEdits: false,
      nativeToolUse: true,
      // Responses exposes OpenAI reasoning deltas/state. DeepSeek chat
      // models expose reasoning_content on Chat Completions chunks.
      nativeReasoning: this.apiMode === 'responses' || supportsChatReasoningContent(this.model),
      maxContextTokens: 128_000,
    };
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 32768;
    this.defaultTemperature = opts.defaultTemperature;
    if (opts.reasoning) {
      this.reasoning = {
        ...(opts.reasoning.effort !== undefined ? { effort: opts.reasoning.effort } : {}),
        ...(opts.reasoning.summary !== undefined ? { summary: opts.reasoning.summary } : {}),
      };
    } else {
      this.reasoning = { summary: 'auto' };
    }
  }

  async *sample(
    request: SamplingRequest,
    signal: AbortSignal,
  ): AsyncIterable<SamplingDelta> {
    if (this.apiMode === 'chat_completions') {
      yield* this.sampleChatCompletions(request, signal);
      return;
    }
    yield* this.sampleResponses(request, signal);
  }

  private async *sampleResponses(
    request: SamplingRequest,
    signal: AbortSignal,
  ): AsyncIterable<SamplingDelta> {
    const params = toResponsesCreateParams(request, {
      model: this.model,
      defaultMaxTokens: this.defaultMaxTokens,
      ...(this.defaultTemperature !== undefined
        ? { defaultTemperature: this.defaultTemperature }
        : {}),
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
    });

    const stream = (await this.client.responses.create(params, {
      signal,
    })) as unknown as Stream<ResponseStreamEvent>;

    // Function-call lifecycle is keyed by the streaming `item_id` (an
    // internal id different from `call_id` — call_id is the stable id
    // tools see and what we surface as ToolCallId).
    interface PendingToolCall {
      callId: ToolCallId;
      name: string;
      began: boolean;
    }
    const pending = new Map<string, PendingToolCall>();
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'error' | undefined;
    let promptTokens = 0;
    let cachedPromptTokens = 0;
    let completionTokens = 0;

    try {
      for await (const event of stream) {
        if (signal.aborted) return;
        switch (event.type) {
          case 'response.output_text.delta': {
            yield { kind: 'text_delta', text: event.delta };
            break;
          }
          case 'response.reasoning_text.delta':
          case 'response.reasoning_summary_text.delta': {
            yield { kind: 'reasoning_delta', text: event.delta };
            break;
          }
          case 'response.output_item.added': {
            const item = event.item;
            if (item.type === 'function_call') {
              const callId = item.call_id as ToolCallId;
              const itemId = item.id ?? callId;
              pending.set(itemId, { callId, name: item.name, began: true });
              yield { kind: 'tool_call_begin', toolCallId: callId, name: item.name };
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            const tc = pending.get(event.item_id);
            if (!tc) break;
            yield {
              kind: 'tool_call_arg_delta',
              toolCallId: tc.callId,
              argsPartial: event.delta,
            };
            break;
          }
          case 'response.function_call_arguments.done': {
            const tc = pending.get(event.item_id);
            if (!tc) break;
            yield {
              kind: 'tool_call_end',
              toolCallId: tc.callId,
              args: tryParseJson(event.arguments),
            };
            pending.delete(event.item_id);
            break;
          }
          case 'response.completed': {
            const u = event.response.usage;
            if (u) {
              promptTokens = u.input_tokens ?? 0;
              cachedPromptTokens = u.input_tokens_details?.cached_tokens ?? 0;
              completionTokens = u.output_tokens ?? 0;
            }
            const reasoningItems = event.response.output?.filter(isEncryptedReasoningItem) ?? [];
            if (reasoningItems.length > 0) {
              yield { kind: 'provider_state', providerId: this.id, items: reasoningItems };
            }
            // If the response carried any tool calls, the runner needs
            // to dispatch them — flag stop=tool_use so the agent loop
            // continues sampling after results come back.
            const hasTool = event.response.output?.some(
              (o) => o.type === 'function_call',
            );
            stopReason = stopReason ?? (hasTool ? 'tool_use' : 'end_turn');
            break;
          }
          case 'response.incomplete': {
            const reason = event.response.incomplete_details?.reason;
            stopReason = reason === 'max_output_tokens' ? 'max_tokens' : 'error';
            const u = event.response.usage;
            if (u) {
              promptTokens = u.input_tokens ?? 0;
              cachedPromptTokens = u.input_tokens_details?.cached_tokens ?? 0;
              completionTokens = u.output_tokens ?? 0;
            }
            break;
          }
          case 'response.failed': {
            stopReason = 'error';
            break;
          }
          default:
            // Ignore other event types (output_item.done,
            // content_part.added, refusal events, audio, web/file
            // search calls, etc.) — they don't affect our action
            // contract.
            break;
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      throw err;
    }

    // Defensive: if a tool_call item never received a `done` event
    // (truncated stream), close it with whatever we have. The runner
    // expects every begun tool_call to end.
    for (const tc of pending.values()) {
      if (!tc.began) continue;
      yield { kind: 'tool_call_end', toolCallId: tc.callId, args: {} };
    }
    pending.clear();

    if (promptTokens || completionTokens) {
      yield {
        kind: 'usage',
        tokens: {
          promptTokens,
          cachedPromptTokens,
          completionTokens,
        },
      };
    }
    yield { kind: 'end', stopReason: stopReason ?? 'end_turn' };
  }

  private async *sampleChatCompletions(
    request: SamplingRequest,
    signal: AbortSignal,
  ): AsyncIterable<SamplingDelta> {
    const params = toChatCreateParams(request, {
      model: this.model,
      defaultMaxTokens: this.defaultMaxTokens,
      chatMaxTokensParam: this.chatMaxTokensParam,
      ...(this.defaultTemperature !== undefined
        ? { defaultTemperature: this.defaultTemperature }
        : {}),
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
    });

    const stream = (await this.client.chat.completions.create(params, {
      signal,
    })) as unknown as Stream<ChatCompletionChunk>;

    interface PendingChatToolCall {
      id?: ToolCallId;
      name?: string;
      args: string;
      began: boolean;
    }
    const pending = new Map<number, PendingChatToolCall>();
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'error' | undefined;
    let promptTokens = 0;
    let cachedPromptTokens = 0;
    let completionTokens = 0;

    const ensureBegun = function* (
      index: number,
      tc: PendingChatToolCall,
    ): Generator<SamplingDelta> {
      if (tc.began) return;
      const id = (tc.id ?? `call_${index}`) as ToolCallId;
      const name = tc.name ?? 'unknown';
      tc.id = id;
      tc.name = name;
      tc.began = true;
      yield { kind: 'tool_call_begin', toolCallId: id, name };
      if (tc.args.length > 0) {
        yield { kind: 'tool_call_arg_delta', toolCallId: id, argsPartial: tc.args };
      }
    };

    try {
      for await (const chunk of stream) {
        if (signal.aborted) return;
        const u = chunk.usage;
        if (u) {
          promptTokens = u.prompt_tokens ?? 0;
          cachedPromptTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
          completionTokens = u.completion_tokens ?? 0;
        }

        for (const choice of chunk.choices) {
          const delta = choice.delta;
          const reasoningContent = chatDeltaReasoningContent(delta);
          if (reasoningContent) {
            yield { kind: 'reasoning_delta', text: reasoningContent };
          }
          if (delta.content) {
            yield { kind: 'text_delta', text: delta.content };
          }
          for (const toolDelta of delta.tool_calls ?? []) {
            const index = toolDelta.index;
            const tc = pending.get(index) ?? { args: '', began: false };
            if (toolDelta.id) tc.id = toolDelta.id as ToolCallId;
            if (toolDelta.function?.name) tc.name = toolDelta.function.name;
            const argDelta = toolDelta.function?.arguments ?? '';
            if (!tc.began && tc.id && tc.name) {
              yield* ensureBegun(index, tc);
            }
            if (argDelta) {
              if (tc.began && tc.id) {
                yield {
                  kind: 'tool_call_arg_delta',
                  toolCallId: tc.id,
                  argsPartial: argDelta,
                };
              }
              tc.args += argDelta;
            }
            pending.set(index, tc);
          }
          if (choice.finish_reason) {
            stopReason = chatFinishReasonToStopReason(choice.finish_reason);
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      throw err;
    }

    for (const [index, tc] of pending) {
      yield* ensureBegun(index, tc);
      yield {
        kind: 'tool_call_end',
        toolCallId: tc.id ?? (`call_${index}` as ToolCallId),
        args: tryParseJson(tc.args),
      };
    }
    pending.clear();

    if (promptTokens || completionTokens) {
      yield {
        kind: 'usage',
        tokens: {
          promptTokens,
          cachedPromptTokens,
          completionTokens,
        },
      };
    }

    yield { kind: 'end', stopReason: stopReason ?? 'end_turn' };
  }
}

// ─── translation helpers ───────────────────────────────────────────────────

/**
 * Translate the projected tail into Responses API input items.
 *
 * Each assistant tool_use becomes its own `function_call` input item
 * (call_id is the stable id the API echoes back on tool results).
 * Each tool_result becomes a `function_call_output` item paired by
 * call_id. User text is wrapped in `EasyInputMessage`.
 *
 * Elided handles get one of two treatments:
 *   - elided tool_result → still emitted as `function_call_output`
 *     with a stub body so the API's pairing invariant holds; the LLM
 *     can `restore(handle)` to rehydrate.
 *   - elided non-tool block → flattened into a user-role message so
 *     it's still in context.
 */
function toResponsesInput(tail: ProjectedItem[]): ResponseInput {
  const items: ResponseInputItem[] = [];
  for (const item of tail) {
    if (item.role === 'user') {
      items.push(
        easyMessage('user', contentToText(item.content)),
      );
      continue;
    }
    if (item.role === 'tool_result') {
      for (const c of item.content) {
        if (c.kind === 'tool_result') {
          items.push({
            type: 'function_call_output',
            call_id: c.toolCallId,
            output: JSON.stringify(
              c.ok ? (c.output ?? null) : { error: c.error ?? 'error' },
            ),
          });
        } else if (c.kind === 'elided') {
          if (c.toolCallId) {
            items.push({
              type: 'function_call_output',
              call_id: c.toolCallId,
              output: JSON.stringify({
                elided: true,
                handle: c.handle,
                kind: c.originKind,
                summary: c.summary,
                hint: 'call restore(handle) to rehydrate full content',
              }),
            });
          } else {
            items.push(
              easyMessage(
                'user',
                `[elided handle=${c.handle} kind=${c.originKind}] ${c.summary ?? ''}`,
              ),
            );
          }
        }
      }
      continue;
    }
    // assistant
    const textChunks: string[] = [];
    for (const c of item.content) {
      switch (c.kind) {
        case 'text':
          textChunks.push(c.text);
          break;
        case 'reasoning':
          textChunks.push(`[reasoning] ${c.text}`);
          break;
        case 'tool_use':
          if (textChunks.length > 0) {
            items.push(easyMessage('assistant', textChunks.join('')));
            textChunks.length = 0;
          }
          items.push({
            type: 'function_call',
            call_id: c.toolCallId,
            name: c.name,
            arguments: JSON.stringify(c.args ?? {}),
          });
          break;
        case 'provider_state':
          if (textChunks.length > 0) {
            items.push(easyMessage('assistant', textChunks.join('')));
            textChunks.length = 0;
          }
          if (c.providerId === 'openai') {
            for (const providerItem of c.items) {
              if (isResponsesInputItem(providerItem)) items.push(providerItem);
            }
          }
          break;
        case 'elided':
          textChunks.push(`[elided handle=${c.handle} ${c.originKind}] ${c.summary ?? ''}`);
          break;
        case 'tool_result':
          // Should never appear in assistant content; ignore defensively.
          break;
      }
    }
    if (textChunks.length > 0) {
      items.push(easyMessage('assistant', textChunks.join('')));
    }
  }
  return items;
}

function easyMessage(
  role: EasyInputMessage['role'],
  content: string,
): EasyInputMessage {
  return { role, content };
}

function toResponsesTools(prefix: StablePrefix): FunctionTool[] {
  return prefix.tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: (t.argsSchema as Record<string, unknown>) ?? {
      type: 'object',
      properties: {},
    },
    // strict=true would force OpenAI to reject any args that don't
    // match parameters exactly. Most tools in the harness don't ship
    // schemas tight enough for that, so leave it off.
    strict: false,
  }));
}

interface ChatMessageOptions {
  reasoningContent?: boolean;
}

interface PendingChatAssistantMessage {
  textChunks: string[];
  reasoningChunks: string[];
  toolCalls: ChatCompletionMessageToolCall[];
}

type ChatAssistantMessageWithReasoning = ChatCompletionMessageParam & {
  role: 'assistant';
  reasoning_content?: string;
};

function toChatMessages(
  prefix: StablePrefix,
  tail: ProjectedItem[],
  opts: ChatMessageOptions = {},
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: prefix.systemPrompt },
  ];
  let pendingAssistant: PendingChatAssistantMessage | undefined;

  const assistant = (): PendingChatAssistantMessage => {
    pendingAssistant ??= { textChunks: [], reasoningChunks: [], toolCalls: [] };
    return pendingAssistant;
  };

  const flushAssistant = (): void => {
    if (!pendingAssistant) return;
    const text = pendingAssistant.textChunks.join('');
    const reasoning = pendingAssistant.reasoningChunks.join('');
    const toolCalls = pendingAssistant.toolCalls;
    if (!text && !reasoning && toolCalls.length === 0) {
      pendingAssistant = undefined;
      return;
    }
    const content = opts.reasoningContent
      ? (text.length > 0 ? text : null)
      : [reasoning ? `[reasoning] ${reasoning}` : '', text].filter(Boolean).join('');
    const message: ChatAssistantMessageWithReasoning = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(opts.reasoningContent ? { reasoning_content: reasoning } : {}),
    };
    messages.push(message);
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
            content: JSON.stringify(
              c.ok ? (c.output ?? null) : { error: c.error ?? 'error' },
            ),
          });
        } else if (c.kind === 'elided' && c.toolCallId) {
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
        } else if (c.kind === 'elided') {
          messages.push({
            role: 'user',
            content: `[elided handle=${c.handle} kind=${c.originKind}] ${c.summary ?? ''}`,
          });
        }
      }
      continue;
    }

    for (const c of item.content) {
      switch (c.kind) {
        case 'text':
          assistant().textChunks.push(c.text);
          break;
        case 'reasoning':
          assistant().reasoningChunks.push(c.text);
          break;
        case 'tool_use':
          assistant().toolCalls.push({
            id: c.toolCallId,
            type: 'function',
            function: {
              name: c.name,
              arguments: JSON.stringify(c.args ?? {}),
            },
          });
          break;
        case 'elided':
          assistant().textChunks.push(
            `[elided handle=${c.handle} ${c.originKind}] ${c.summary ?? ''}`,
          );
          break;
        case 'provider_state':
        case 'tool_result':
          break;
      }
    }
    if (!opts.reasoningContent) flushAssistant();
  }
  flushAssistant();
  return messages;
}

function toChatTools(prefix: StablePrefix): ChatCompletionTool[] {
  return prefix.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.argsSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
      strict: false,
    },
  }));
}

function contentToText(content: ProjectedContent[]): string {
  return content
    .map((c) => {
      if (c.kind === 'text') return c.text;
      if (c.kind === 'reasoning') return `[reasoning] ${c.text}`;
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

/**
 * Translate the harness's `ResponseFormatSpec` into the Responses API
 * `text.format` shape (note: nested under `text`, not top-level
 * `response_format` like Chat Completions).
 */
function toResponsesTextFormat(spec: ResponseFormatSpec): ResponseFormatTextConfig {
  if (spec.type === 'json_object') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    name: spec.name,
    schema: spec.schema as Record<string, unknown>,
    strict: spec.strict ?? true,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
  };
}

function toResponsesCreateParams(
  request: SamplingRequest,
  defaults: {
    model: string;
    defaultMaxTokens: number;
    defaultTemperature?: number;
    reasoning?: Reasoning;
  },
): ResponseCreateParamsStreaming {
  const model = request.model ?? defaults.model;
  const input = toResponsesInput(request.tail);
  const tools = toResponsesTools(request.prefix);
  const temperature = supportsTemperature(model)
    ? (request.temperature ?? defaults.defaultTemperature)
    : undefined;
  const reasoning = reasoningForModel(model, defaults.reasoning);
  const includeEncryptedReasoning = supportsReasoning(model) && tools.length > 0;

  return {
    model,
    instructions: request.prefix.systemPrompt,
    input,
    ...(tools.length > 0 ? { tools } : {}),
    stream: true,
    // Stateless: don't have OpenAI persist responses on its side.
    // Matches the Chat Completions behaviour we replaced and avoids
    // accidentally leaking conversation state between sessions.
    store: false,
    ...(includeEncryptedReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
    max_output_tokens: request.maxTokens ?? defaults.defaultMaxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(request.responseFormat
      ? { text: { format: toResponsesTextFormat(request.responseFormat) } }
      : {}),
  };
}

function toChatCreateParams(
  request: SamplingRequest,
  defaults: {
    model: string;
    defaultMaxTokens: number;
    chatMaxTokensParam: 'max_completion_tokens' | 'max_tokens';
    defaultTemperature?: number;
    reasoning?: Reasoning;
  },
): ChatCompletionCreateParamsStreaming {
  const model = request.model ?? defaults.model;
  const tools = toChatTools(request.prefix);
  const temperature = supportsTemperature(model)
    ? (request.temperature ?? defaults.defaultTemperature)
    : undefined;
  const reasoning = reasoningForModel(model, defaults.reasoning);
  const maxTokensKey = defaults.chatMaxTokensParam;
  return {
    model,
    messages: toChatMessages(request.prefix, request.tail, {
      reasoningContent: supportsChatReasoningContent(model),
    }),
    ...(tools.length > 0 ? { tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    [maxTokensKey]: request.maxTokens ?? defaults.defaultMaxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoning?.effort !== undefined ? { reasoning_effort: reasoning.effort } : {}),
    ...(request.responseFormat
      ? { response_format: toChatResponseFormat(request.responseFormat) }
      : {}),
  } as unknown as ChatCompletionCreateParamsStreaming;
}

function toChatResponseFormat(spec: ResponseFormatSpec): Record<string, unknown> {
  if (spec.type === 'json_object') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: spec.name,
      schema: spec.schema,
      strict: spec.strict ?? true,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
    },
  };
}

function chatFinishReasonToStopReason(
  reason: ChatCompletionChunk.Choice['finish_reason'],
): 'end_turn' | 'max_tokens' | 'tool_use' | 'error' {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
    default:
      return 'error';
  }
}

function supportsTemperature(model: string): boolean {
  const id = model.toLowerCase();
  if (id.startsWith('gpt-5')) return false;
  if (/^o\d/.test(id)) return false;
  if (id.includes('codex')) return false;
  return true;
}

function reasoningForModel(model: string, reasoning: Reasoning | undefined): Reasoning | undefined {
  if (reasoning === undefined) return undefined;
  return supportsReasoning(model) ? reasoning : undefined;
}

function supportsReasoning(model: string): boolean {
  const id = model.toLowerCase();
  return id.startsWith('gpt-5') || /^o\d/.test(id);
}

function supportsChatReasoningContent(model: string): boolean {
  return model.toLowerCase().includes('deepseek');
}

function chatDeltaReasoningContent(delta: unknown): string | undefined {
  const reasoningContent = (delta as { reasoning_content?: unknown }).reasoning_content;
  return typeof reasoningContent === 'string' ? reasoningContent : undefined;
}

function isEncryptedReasoningItem(item: unknown): item is ResponseReasoningItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'reasoning' &&
    typeof (item as { encrypted_content?: unknown }).encrypted_content === 'string'
  );
}

function isResponsesInputItem(item: unknown): item is ResponseInputItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as { type?: unknown }).type === 'string'
  );
}

export const __testOnly = {
  toResponsesInput,
  toResponsesTools,
  toResponsesTextFormat,
  toResponsesCreateParams,
  toChatMessages,
  toChatTools,
  toChatResponseFormat,
  toChatCreateParams,
  chatFinishReasonToStopReason,
  supportsTemperature,
  supportsReasoning,
  supportsChatReasoningContent,
  chatDeltaReasoningContent,
  isEncryptedReasoningItem,
};
