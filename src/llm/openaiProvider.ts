import OpenAI from 'openai';
import type { Stream } from 'openai/core/streaming.js';
import type {
  EasyInputMessage,
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFormatTextConfig,
  ResponseInput,
  ResponseInputItem,
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
 * OpenAI Responses-API provider.
 *
 * The Chat Completions API doesn't surface reasoning text on the
 * stream — for o1/o3/gpt-5 you only see the final answer plus a
 * reasoning_tokens count. The Responses API streams `response
 * .reasoning_text.delta` (and the older `response.reasoning_summary
 * _text.delta`) in addition to `response.output_text.delta`, so
 * thinking is actually visible.
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
 * Non-OpenAI endpoints that don't implement Responses API will fail
 * here. That's the trade-off the caller asked for: thinking text
 * everywhere, at the cost of cross-vendor portability.
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

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_RETRIES = 2;

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false, // Server-side automatic caching; no client knob.
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: true,
    maxContextTokens: 128_000,
  };

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;
  private readonly reasoning: Reasoning | undefined;

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
    // Default to summary='auto' so reasoning streams without the
    // caller having to opt in. effort is left unset so the API uses
    // the model default (GPT-5.x defaults to 'none' or 'medium'
    // depending on the model).
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
    const input = toResponsesInput(request.tail);
    const tools = toResponsesTools(request.prefix);

    const params: ResponseCreateParamsStreaming = {
      model: request.model ?? this.model,
      instructions: request.prefix.systemPrompt,
      input,
      ...(tools.length > 0 ? { tools } : {}),
      stream: true,
      // Stateless: don't have OpenAI persist responses on its side.
      // Matches the Chat Completions behaviour we replaced and avoids
      // accidentally leaking conversation state between sessions.
      store: false,
      max_output_tokens: request.maxTokens ?? this.defaultMaxTokens,
      temperature: request.temperature ?? this.defaultTemperature,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      ...(request.responseFormat
        ? { text: { format: toResponsesTextFormat(request.responseFormat) } }
        : {}),
    };

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
    let usageEmitted = false;

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

    if (!usageEmitted && (promptTokens || completionTokens)) {
      yield {
        kind: 'usage',
        tokens: {
          promptTokens,
          cachedPromptTokens,
          completionTokens,
        },
      };
      usageEmitted = true;
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

export const __testOnly = {
  toResponsesInput,
  toResponsesTools,
  toResponsesTextFormat,
};
