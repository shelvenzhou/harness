import { describe, expect, it } from 'vitest';

import { EventBus } from '@harness/bus/eventBus.js';
import { CompactionHandler } from '@harness/context/compactionHandler.js';
import { CompactionTrigger } from '@harness/context/compactionTrigger.js';
import { SubagentCompactor } from '@harness/context/subagentCompactor.js';
import { newEventId, newThreadId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { MemorySessionStore } from '@harness/store/index.js';

class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: false,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  async *sample(_req: SamplingRequest, _signal: AbortSignal): AsyncIterable<SamplingDelta> {
    yield { kind: 'text_delta', text: 'compaction summary 42', channel: 'reply' };
    yield { kind: 'end', stopReason: 'end_turn' };
  }
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

describe('smoke: cold-path compaction with SubagentCompactor', () => {
  it('threshold cross → compact_request → SubagentCompactor → compaction_event', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: '00-aaaa-bbbb-00' });
    await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'hello' } });
    await store.append({ threadId: tid, kind: 'reply', payload: { text: 'hi' } });
    await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'next' } });

    const trigger = new CompactionTrigger({ thresholdTokens: 1_000, cooldownSamples: 5 });
    trigger.start(bus, store);
    const handler = new CompactionHandler({
      compactor: new SubagentCompactor({ bus, store, provider: new ScriptedProvider() }),
      trigger,
    });
    handler.start(bus, store);

    const observed: HarnessEvent[] = [];
    bus.subscribe(
      (ev) => {
        observed.push(ev);
      },
      { kinds: ['compaction_event'] },
    );

    bus.publish({
      id: newEventId(),
      threadId: tid,
      kind: 'sampling_complete',
      payload: {
        samplingIndex: 1,
        providerId: 't',
        promptTokens: 0,
        cachedPromptTokens: 0,
        completionTokens: 0,
        wallMs: 0,
        projection: { projectedItems: 0, elidedCount: 0, estimatedTokens: 5_000, pinnedHandles: 0 },
        toolCallCount: 0,
      },
      createdAt: new Date().toISOString(),
    } as HarnessEvent);

    // First flush kicks off the compactor; the subagent runner needs
    // multiple async ticks to land its turn_complete on the bus.
    for (let i = 0; i < 5 && observed.length === 0; i++) await flush(8);

    expect(observed.length).toBe(1);
    const payload = observed[0]?.payload as
      | { tokensBefore?: number; retainedUserTurns?: number; summary?: string }
      | undefined;
    expect(payload?.tokensBefore ?? 0).toBeGreaterThan(0);
    expect(payload?.retainedUserTurns).toBe(2);
    expect(payload?.summary).toBe('compaction summary 42');
  });
});
