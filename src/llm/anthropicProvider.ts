import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from './provider.js';

/**
 * Anthropic Claude provider — **skeleton only**.
 *
 * The interface is stable enough for the rest of the runtime to depend on
 * it today. Actual streaming + tool-use translation + cache_control /
 * cache_edits support lands in a follow-up commit (phase 2).
 *
 * See design-docs/05-llm-provider.md. Unsupported calls throw
 * `AnthropicNotImplementedError` rather than silently returning empty
 * streams, so misconfigured CI surfaces quickly.
 */

export class AnthropicNotImplementedError extends Error {
  constructor(feature: string) {
    super(`AnthropicProvider: ${feature} is not implemented yet (phase 2)`);
    this.name = 'AnthropicNotImplementedError';
  }
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Defaults. Overridable per request. */
  defaultMaxTokens?: number;
}

const DEFAULT_MODEL = 'claude-opus-4-7';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly capabilities: LlmCapabilities = {
    prefixCache: true,
    cacheEdits: true,
    nativeToolUse: true,
    nativeReasoning: true,
    maxContextTokens: 200_000,
  };

  constructor(private readonly opts: AnthropicProviderOptions) {
    if (!opts.apiKey) throw new Error('AnthropicProvider requires an apiKey');
  }

  get model(): string {
    return this.opts.model ?? DEFAULT_MODEL;
  }

  // eslint-disable-next-line require-yield
  async *sample(
    _request: SamplingRequest,
    _signal: AbortSignal,
  ): AsyncIterable<SamplingDelta> {
    throw new AnthropicNotImplementedError('sample');
  }
}
