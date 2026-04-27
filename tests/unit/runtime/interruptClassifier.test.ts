import { describe, it, expect } from 'vitest';

import { newEventId } from '@harness/core/ids.js';
import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import type { HarnessEvent } from '@harness/core/events.js';

/**
 * Step 5 contract: when an `interrupt` arrives during a turn, the
 * runner must classify the resulting turn_complete as `interrupted`
 * rather than letting the empty-actions path fire as
 * `errored:model_returned_no_actions`. Misclassification made
 * user-initiated cancellation look like a model bug in transcripts.
 */

class SlowProvider implements LlmProvider {
  readonly id = 'slow';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  async *sample(_req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    // Wait long enough for the test to publish an interrupt while we
    // sit here. When the abort fires we exit the loop without
    // emitting any actions — the historical bug case.
    for (let i = 0; i < 50; i++) {
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    // If we somehow reach the end uninterrupted, emit a normal reply
    // so the test fails loudly rather than hanging.
    yield { kind: 'text_delta', text: 'should not reach here', channel: 'reply' };
    yield { kind: 'end', stopReason: 'end_turn' };
  }
}

describe('runtime: interrupt classifier', () => {
  it('classifies a mid-sampling interrupt as turn_complete{interrupted}, not errored', async () => {
    const runtime = await bootstrap({
      provider: new SlowProvider(),
      systemPrompt: 'sys',
      microCompact: false,
    });

    const turnDone = new Promise<{ status: string; summary?: string }>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3_000);
        const sub = runtime.bus.subscribe(
          (ev) => {
            if (ev.kind === 'turn_complete') {
              clearTimeout(t);
              sub.unsubscribe();
              resolve({
                status: ev.payload.status,
                ...(ev.payload.summary !== undefined ? { summary: ev.payload.summary } : {}),
              });
            }
          },
          { threadId: runtime.rootThreadId },
        );
      },
    );

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'long' },
    });
    runtime.bus.publish(seed);

    // Give the sampler ~50ms head-start, then publish an interrupt.
    await new Promise((r) => setTimeout(r, 50));
    const ev: HarnessEvent = {
      id: newEventId(),
      threadId: runtime.rootThreadId,
      kind: 'interrupt',
      payload: { reason: 'test cancel' },
      createdAt: new Date().toISOString(),
    } as HarnessEvent;
    await runtime.store.append(ev);
    runtime.bus.publish(ev);

    const result = await turnDone;
    expect(result.status).toBe('interrupted');
    expect(result.summary).toBe('user_interrupt');
  }, 5_000);
});
