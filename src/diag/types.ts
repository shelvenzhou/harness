import type { HarnessEvent } from '@harness/core/events.js';
import type { ThreadId, TurnId } from '@harness/core/ids.js';
import type { SamplingRequest } from '@harness/llm/provider.js';

/**
 * Diagnostic sink. One or more sinks subscribe to the EventBus (for tool
 * calls, replies, sampling_complete, etc.) and receive a separate hook
 * for the full prompt that can't be cheaply round-tripped through an
 * event (too large for the hot path).
 *
 * See design-docs/07-diagnostics.md.
 */
export interface DiagSink {
  readonly id: string;
  onPrompt(
    ctx: { threadId: ThreadId; turnId: TurnId; samplingIndex: number },
    request: SamplingRequest,
    stats: {
      projectedItems: number;
      elidedCount: number;
      estimatedTokens: number;
      pinnedHandles: number;
    },
  ): Promise<string | undefined>;
  onEvent(event: HarnessEvent): void | Promise<void>;
  close(): Promise<void>;
}
