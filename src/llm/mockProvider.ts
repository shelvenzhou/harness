import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from './provider.js';

/**
 * Scripted provider for offline tests and the initial REPL.
 *
 * Two modes:
 *   - Static script: a fixed sequence of SamplingDelta yielded on every call.
 *   - Reactive: a function `(request) => SamplingDelta[]` inspected per call.
 *
 * The call log lets tests assert on what the runner actually sent.
 */

export interface MockProviderOptions {
  id?: string;
  capabilities?: Partial<LlmCapabilities>;
  script?: SamplingDelta[] | Array<SamplingDelta[]>;
  react?: (request: SamplingRequest, callIndex: number) => SamplingDelta[];
}

const DEFAULT_CAPS: LlmCapabilities = {
  prefixCache: true,
  cacheEdits: true,
  nativeToolUse: true,
  nativeReasoning: false,
  maxContextTokens: 200_000,
};

export class MockProvider implements LlmProvider {
  readonly id: string;
  readonly capabilities: LlmCapabilities;
  private callIndex = 0;
  private readonly script?: SamplingDelta[][];
  private readonly react?: (req: SamplingRequest, idx: number) => SamplingDelta[];
  readonly callLog: SamplingRequest[] = [];

  constructor(opts: MockProviderOptions = {}) {
    this.id = opts.id ?? 'mock';
    this.capabilities = { ...DEFAULT_CAPS, ...opts.capabilities };
    if (opts.script) {
      this.script = Array.isArray(opts.script[0])
        ? (opts.script as SamplingDelta[][])
        : [opts.script as SamplingDelta[]];
    }
    if (opts.react !== undefined) this.react = opts.react;
  }

  async *sample(request: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    this.callLog.push(request);
    const idx = this.callIndex++;
    const deltas = this.pickDeltas(request, idx);
    for (const delta of deltas) {
      if (signal.aborted) return;
      yield delta;
    }
    if (!deltas.some((d) => d.kind === 'end')) {
      yield { kind: 'end', stopReason: 'end_turn' };
    }
  }

  private pickDeltas(request: SamplingRequest, idx: number): SamplingDelta[] {
    if (this.react) return this.react(request, idx);
    if (this.script) {
      const pick = this.script[Math.min(idx, this.script.length - 1)];
      return pick ?? [];
    }
    // Default: echo last user text back as a reply.
    const last = request.tail[request.tail.length - 1];
    const text =
      last?.content.find((c): c is { kind: 'text'; text: string } => c.kind === 'text')?.text ??
      '(no input)';
    return [
      { kind: 'text_delta', text: `mock: ${text}`, channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ];
  }

  reset(): void {
    this.callIndex = 0;
    this.callLog.length = 0;
  }
}
