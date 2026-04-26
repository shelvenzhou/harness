import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';

/**
 * Regression: when a `user_turn_start` for a new turn arrives while the
 * previous turn's tick is still unwinding, the runner used to drop the
 * seed (the old `tickPending` boolean threw away the actual event kind).
 * After the fix, scheduleTick queues seeds and tick drains them FIFO.
 *
 * The test reproduces the race by issuing two turns back-to-back from the
 * same await chain — the second `user_turn_start` is published right after
 * `await done` resolves on turn 1, before tick has had a chance to fully
 * unwind.
 */

class SimpleProvider implements LlmProvider {
  readonly id = 'simple';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  private i = 0;
  async *sample(_req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    const idx = this.i++;
    if (signal.aborted) return;
    yield { kind: 'text_delta', text: `t${idx}`, channel: 'reply' };
    yield {
      kind: 'usage',
      tokens: { promptTokens: 10, cachedPromptTokens: 0, completionTokens: 5 },
    };
    yield { kind: 'end', stopReason: 'end_turn' };
  }
}

async function runOneTurn(
  bus: import('@harness/bus/eventBus.js').EventBus,
  store: import('@harness/store/sessionStore.js').SessionStore,
  threadId: import('@harness/core/ids.js').ThreadId,
  text: string,
): Promise<{ status: 'completed' | 'interrupted' | 'errored'; summary?: string }> {
  return new Promise(async (resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 2_000);
    const sub = bus.subscribe(
      (ev) => {
        if (ev.kind === 'turn_complete') {
          sub.unsubscribe();
          clearTimeout(t);
          resolve({
            status: ev.payload.status,
            ...(ev.payload.summary !== undefined ? { summary: ev.payload.summary } : {}),
          });
        }
      },
      { threadId },
    );
    const seed = await store.append({ threadId, kind: 'user_turn_start', payload: { text } });
    bus.publish(seed);
  });
}

describe('runtime: pending seeds queue (regression)', () => {
  it('processes back-to-back user_turn_start without losing the second', async () => {
    const runtime = await bootstrap({
      provider: new SimpleProvider(),
      systemPrompt: 'sys',
    });

    const first = await runOneTurn(
      runtime.bus,
      runtime.store,
      runtime.rootThreadId,
      'one',
    );
    expect(first.status).toBe('completed');
    expect(first.summary).toBe('t0');

    // No artificial delay: the second turn is issued before the previous
    // tick has fully unwound. Pre-fix, this hit the dropped-seed bug.
    const second = await runOneTurn(
      runtime.bus,
      runtime.store,
      runtime.rootThreadId,
      'two',
    );
    expect(second.status).toBe('completed');
    expect(second.summary).toBe('t1');
  });

  it('processes three turns in tight succession', async () => {
    const runtime = await bootstrap({
      provider: new SimpleProvider(),
      systemPrompt: 'sys',
    });

    for (let i = 0; i < 3; i++) {
      const r = await runOneTurn(
        runtime.bus,
        runtime.store,
        runtime.rootThreadId,
        `turn-${i}`,
      );
      expect(r.status).toBe('completed');
      expect(r.summary).toBe(`t${i}`);
    }
  });
});
