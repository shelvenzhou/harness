import { describe, it, expect } from 'vitest';

import { EventBus } from '@harness/bus/eventBus.js';
import { CompactionHandler } from '@harness/context/compactionHandler.js';
import { CompactionTrigger } from '@harness/context/compactionTrigger.js';
import type { Compactor, CompactionRequest, CompactionResult } from '@harness/context/compactor.js';
import { newEventId, newThreadId } from '@harness/core/ids.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';
import { MemorySessionStore } from '@harness/store/index.js';

/**
 * Step 3 contract: the trigger-handler pair must close the cold-path
 * compaction loop. compact_request → handler runs the Compactor →
 * compaction_event lands → trigger.acknowledge releases cooldown.
 *
 * Strategy is injected so we can run a deterministic Compactor mock
 * here; the StaticCompactor default and the future
 * subagent-backed compactor are interchangeable from the handler's
 * point of view.
 */

class CountingCompactor implements Compactor {
  public calls = 0;
  async compact(req: CompactionRequest): Promise<CompactionResult> {
    this.calls += 1;
    return {
      summary: {
        reinject: { systemReinject: '' },
        summary: `(compacted ${req.events.length} events)`,
        recentUserTurns: [],
        ghostSnapshots: [],
        activeHandles: [],
      },
      atEventId: req.events[req.events.length - 1]?.id ?? ('' as never),
      tokensBefore: 100,
      tokensAfter: 30,
      durationMs: 1,
    };
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function compactRequest(threadId: ThreadId): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'compact_request',
    payload: { reason: 'manual' },
    createdAt: new Date().toISOString(),
  } as HarnessEvent;
}

describe('context: compaction handler', () => {
  it('runs the Compactor and emits a compaction_event when a compact_request fires', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: '00-aaaa-bbbb-00' });
    await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'hello' } });

    const compactor = new CountingCompactor();
    const handler = new CompactionHandler({ compactor });
    handler.start(bus, store);

    const observed: HarnessEvent[] = [];
    bus.subscribe((ev) => observed.push(ev), { kinds: ['compaction_event'] });

    bus.publish(compactRequest(tid));
    await flush();

    expect(compactor.calls).toBe(1);
    expect(observed.length).toBe(1);
    expect(observed[0]!.kind).toBe('compaction_event');
    const events = await store.readAll(tid);
    expect(events.some((e) => e.kind === 'compaction_event')).toBe(true);
  });

  it('acknowledges the trigger so cooldown can release on the next threshold cross', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: '00-aaaa-bbbb-00' });

    const trigger = new CompactionTrigger({ thresholdTokens: 1_000, cooldownSamples: 10 });
    trigger.start(bus, store);
    const handler = new CompactionHandler({ compactor: new CountingCompactor(), trigger });
    handler.start(bus, store);

    const requests: HarnessEvent[] = [];
    bus.subscribe((ev) => requests.push(ev), { kinds: ['compact_request'] });

    // First sampling crosses the threshold — trigger publishes a
    // compact_request, handler runs the compactor, then acknowledge()
    // clears the per-thread cooldown index.
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
    await flush();
    expect(requests.length).toBe(1);

    // A second crossing just after acknowledge should fire again
    // immediately — without acknowledge, the cooldown would suppress
    // it for 10 sampling steps. We pick samplingIndex=2 specifically:
    // pre-fix the trigger's lastFiredSamplingIndex would still be 1,
    // and the gap (2-1)<10 would suppress.
    bus.publish({
      id: newEventId(),
      threadId: tid,
      kind: 'sampling_complete',
      payload: {
        samplingIndex: 2,
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
    await flush();
    expect(requests.length).toBe(2);
  });

  it('drops a second compact_request that arrives while a compaction is still in flight', async () => {
    let release: () => void = () => undefined;
    const slow: Compactor = {
      compact: () =>
        new Promise<CompactionResult>((resolve) => {
          release = () =>
            resolve({
              summary: {
                reinject: { systemReinject: '' },
                summary: '',
                recentUserTurns: [],
                ghostSnapshots: [],
                activeHandles: [],
              },
              atEventId: '' as never,
              tokensBefore: 0,
              tokensAfter: 0,
              durationMs: 0,
            });
        }),
    };
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: '00-aaaa-bbbb-00' });
    const handler = new CompactionHandler({ compactor: slow });
    handler.start(bus, store);

    const observed: HarnessEvent[] = [];
    bus.subscribe((ev) => observed.push(ev), { kinds: ['compaction_event'] });

    bus.publish(compactRequest(tid));
    bus.publish(compactRequest(tid));
    await flush();
    // Still in flight — no compaction_event yet.
    expect(observed.length).toBe(0);

    release();
    await flush();
    // Only one compaction_event emitted; the second request was
    // dropped by the in-flight guard.
    expect(observed.length).toBe(1);
  });
});
