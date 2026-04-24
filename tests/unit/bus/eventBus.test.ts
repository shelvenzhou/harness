import { describe, it, expect } from 'vitest';

import { EventBus } from '@harness/bus/eventBus.js';
import { newEventId, newThreadId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';

function reply(text: string, threadId = newThreadId()): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'reply',
    payload: { text },
    createdAt: new Date().toISOString(),
  } as HarnessEvent;
}

describe('EventBus', () => {
  it('delivers to subscribers matching threadId', async () => {
    const bus = new EventBus();
    const t1 = newThreadId();
    const t2 = newThreadId();
    const seen1: string[] = [];
    const seen2: string[] = [];
    bus.subscribe((e) => void seen1.push((e.payload as { text: string }).text), { threadId: t1 });
    bus.subscribe((e) => void seen2.push((e.payload as { text: string }).text), { threadId: t2 });
    bus.publish(reply('a', t1));
    bus.publish(reply('b', t2));
    await new Promise((r) => setImmediate(r));
    expect(seen1).toEqual(['a']);
    expect(seen2).toEqual(['b']);
  });

  it('filters by kinds', async () => {
    const bus = new EventBus();
    const t = newThreadId();
    const seen: string[] = [];
    bus.subscribe((e) => void seen.push(e.kind), { kinds: ['reply'] });
    bus.publish(reply('x', t));
    bus.publish({
      id: newEventId(),
      threadId: t,
      kind: 'preamble',
      payload: { text: 'p' },
      createdAt: new Date().toISOString(),
    } as HarnessEvent);
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(['reply']);
  });

  it('drops oldest when queue is full', async () => {
    const bus = new EventBus();
    const t = newThreadId();
    const seen: string[] = [];
    bus.subscribe(
      async (e) => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push((e.payload as { text: string }).text);
      },
      { queueDepth: 2 },
    );
    for (let i = 0; i < 6; i++) bus.publish(reply(String(i), t));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).toBeLessThanOrEqual(3); // first + last two (drop-oldest)
    expect(bus.stats()[0]?.dropped).toBeGreaterThan(0);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const sub = bus.subscribe((e) => void seen.push(e.kind));
    sub.unsubscribe();
    bus.publish(reply('x'));
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([]);
  });
});
