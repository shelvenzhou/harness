import type { ToolCallId } from '@harness/core/ids.js';

/**
 * LLM provider interface — see design-docs/05-llm-provider.md.
 */

export interface LlmCapabilities {
  prefixCache: boolean;
  cacheEdits: boolean;
  nativeToolUse: boolean;
  nativeReasoning: boolean;
  maxContextTokens: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema for the tool's arguments. */
  argsSchema: unknown;
}

/**
 * Opaque pieces of the prompt, passed to the provider as-is. The provider
 * may put `prefix` in a `system` field + cache_control markers, or inline
 * it into a messages array — that's the provider's business.
 */
export interface StablePrefix {
  systemPrompt: string;
  pinnedMemory: string[];
  compactedSummary?: string;
  /** Tool specs belong to the prefix because they change rarely. */
  tools: ToolSpec[];
}

export interface ProjectedItem {
  /** Role from the model's POV; 'user' also carries tool_result turns. */
  role: 'user' | 'assistant' | 'tool_result';
  /** Arbitrary structured content. Providers flatten to their native shape. */
  content: ProjectedContent[];
  /** Used by cache_edits — lets the provider target suppression. */
  cacheTag?: string;
}

export type ProjectedContent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; toolCallId: ToolCallId; name: string; args: unknown }
  | { kind: 'tool_result'; toolCallId: ToolCallId; ok: boolean; output?: unknown; error?: string }
  | {
      kind: 'elided';
      handle: string;
      originKind: string;
      summary?: string;
      /**
       * Set when the elided block stands in for a `tool_result` event. The
       * provider must still emit a `tool` role message with this id so the
       * provider API's tool-call/response pairing invariant holds.
       */
      toolCallId?: ToolCallId;
    };

export interface CacheEdits {
  clearToolUses?: ToolCallId[];
  clearThinking?: boolean;
}

export interface SamplingRequest {
  prefix: StablePrefix;
  tail: ProjectedItem[];
  temperature?: number;
  maxTokens?: number;
  cacheEdits?: CacheEdits;
  traceparent?: string;
  /** Provider-specific model id; interpreted by each provider. */
  model?: string;
}

export interface TokenUsage {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
}

export type SamplingDelta =
  | { kind: 'text_delta'; text: string; channel?: 'reply' | 'preamble' }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'tool_call_begin'; toolCallId: ToolCallId; name: string }
  | { kind: 'tool_call_arg_delta'; toolCallId: ToolCallId; argsPartial: string }
  | { kind: 'tool_call_end'; toolCallId: ToolCallId; args: unknown }
  | { kind: 'usage'; tokens: TokenUsage }
  | { kind: 'end'; stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'error' };

export interface LlmProvider {
  readonly id: string;
  readonly capabilities: LlmCapabilities;
  sample(request: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta>;
}
