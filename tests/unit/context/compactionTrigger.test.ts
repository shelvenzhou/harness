import { describe, it, expect } from 'vitest';

import { EventBus } from '@harness/bus/eventBus.js';
import { CompactionTrigger } from '@harness/context/compactionTrigger.js';
import { newEventId, newThreadId } from '@harness/core/ids.js';
import type { ThreadId } from '@harness/core/ids.js';
import { MemorySessionStore } from '@harness/store/index.js';
import type { HarnessEvent } from '@harness/core/events.js';

/**
 * CompactionTrigger is mechanism-only: subscribe to sampling_complete,
 * publish compact_request when estimatedTokens crosses threshold,
 * respect cooldown. The actual compaction handling is downstream and
 * not asserted here.
 */

function samplingComplete(
  threadId: ThreadId,
  samplingIndex: number,
  estimatedTokens: number,
): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'sampling_complete',
    payload: {
      samplingIndex,
      providerId: 'test',
      promptTokens: 0,
      cachedPromptTokens: 0,
      completionTokens: 0,
      wallMs: 0,
      projection: {
        projectedItems: 0,
        elidedCount: 0,
        estimatedTokens,
        pinnedHandles: 0,
      },
      toolCallCount: 0,
    },
    createdAt: new Date().toISOString(),
  } as HarnessEvent;
}

async function setup(threshold: number, cooldown?: number): Promise<{
  bus: EventBus;
  store: MemorySessionStore;
  threadId: ThreadId;
  trigger: CompactionTrigger;
  fired: HarnessEvent[];
}> {
  const bus = new EventBus();
  const store = new MemorySessionStore();
  const threadId = newThreadId();
  await store.createThread({ id: threadId, rootTraceparent: '00-aaaa-bbbb-00' });

  const trigger = new CompactionTrigger({
    thresholdTokens: threshold,
    ...(cooldown !== undefined ? { cooldownSamples: cooldown } : {}),
  });
  trigger.start(bus, store);
  const fired: HarnessEvent[] = [];
  bus.subscribe(
    (ev) => {
      fired.push(ev);
    },
    { kinds: ['compact_request'] },
  );
  return { bus, store, threadId, trigger, fired };
}

async function flush(): Promise<void> {
  // Allow microtasks (the trigger's async maybeFire chain) to drain.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('context: compaction trigger', () => {
  it('does not fire below threshold', async () => {
    const { bus, threadId, fired } = await setup(10_000);
    bus.publish(samplingComplete(threadId, 1, 5_000));
    await flush();
    expect(fired).toHaveLength(0);
  });

  it('fires once when threshold is crossed', async () => {
    const { bus, store, threadId, fired } = await setup(10_000);
    bus.publish(samplingComplete(threadId, 1, 12_000));
    await flush();
    expect(fired).toHaveLength(1);
    expect(fired[0]?.kind).toBe('compact_request');
    expect(fired[0]?.threadId).toBe(threadId);
    // Persisted alongside being published.
    const events = await store.readAll(threadId);
    expect(events.some((e) => e.kind === 'compact_request')).toBe(true);
  });

  it('respects cooldown after firing', async () => {
    const { bus, threadId, fired } = await setup(10_000, 3);
    bus.publish(samplingComplete(threadId, 1, 12_000));
    await flush();
    bus.publish(samplingComplete(threadId, 2, 13_000));
    await flush();
    bus.publish(samplingComplete(threadId, 3, 14_000));
    await flush();
    // Index 1 fired; indices 2, 3 are within cooldown=3 → no new fire.
    expect(fired).toHaveLength(1);
    // Index 4 is exactly cooldown samples later → fires again.
    bus.publish(samplingComplete(threadId, 4, 15_000));
    await flush();
    expect(fired).toHaveLength(2);
  });

  it('separate threads have independent cooldowns', async () => {
    const { bus, threadId, fired, store } = await setup(10_000, 5);
    const otherThread = newThreadId();
    await store.createThread({ id: otherThread, rootTraceparent: '00-bbbb-cccc-00' });

    bus.publish(samplingComplete(threadId, 1, 12_000));
    await flush();
    bus.publish(samplingComplete(otherThread, 1, 12_000));
    await flush();
    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.threadId).sort()).toEqual([threadId, otherThread].sort());
  });

  it('acknowledge resets cooldown for a thread', async () => {
    const { bus, threadId, fired, trigger } = await setup(10_000, 5);
    bus.publish(samplingComplete(threadId, 1, 12_000));
    await flush();
    expect(fired).toHaveLength(1);
    trigger.acknowledge(threadId);
    bus.publish(samplingComplete(threadId, 2, 13_000));
    await flush();
    expect(fired).toHaveLength(2);
  });

  it('stop() unsubscribes and silences further triggers', async () => {
    const { bus, threadId, fired, trigger } = await setup(10_000);
    trigger.stop();
    bus.publish(samplingComplete(threadId, 1, 50_000));
    await flush();
    expect(fired).toHaveLength(0);
  });
});
