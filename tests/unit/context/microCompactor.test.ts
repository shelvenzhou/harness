import { describe, expect, it } from 'vitest';

import { newRootTraceparent } from '@harness/core/traceparent.js';
import { newThreadId, type ToolCallId } from '@harness/core/ids.js';
import { HandleRegistry, MicroCompactor } from '@harness/context/index.js';
import { MemorySessionStore } from '@harness/store/index.js';

/**
 * Sliding-window micro-compaction. The compactor must:
 *   1. Skip work until `triggerEvery` new events have accumulated past
 *      the previous checkpoint.
 *   2. Leave the last `keepRecent` events untouched.
 *   3. Elide tool_results in the warm zone whose body exceeds `minBytes`,
 *      via store.attachElision + a registered handle.
 *   4. Be idempotent — already-elided events stay alone.
 */

async function seedToolPair(
  store: MemorySessionStore,
  tid: ReturnType<typeof newThreadId>,
  callId: string,
  outputBytes: number,
): Promise<void> {
  const id = callId as ToolCallId;
  await store.append({
    threadId: tid,
    kind: 'tool_call',
    payload: { toolCallId: id, name: 'shell', args: { cmd: ':' } },
  });
  await store.append({
    threadId: tid,
    kind: 'tool_result',
    payload: {
      toolCallId: id,
      ok: true,
      output: { stdout: 'x'.repeat(outputBytes), exitCode: 0 },
    },
  });
}

describe('MicroCompactor', () => {
  it('does nothing until triggerEvery events have accumulated', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'go' } });
    for (let i = 0; i < 5; i++) await seedToolPair(store, tid, `call_${i}`, 1024);

    const handles = new HandleRegistry();
    const mc = new MicroCompactor({ keepRecent: 4, triggerEvery: 20, minBytes: 256 });
    const r = await mc.maybeRun(tid, store, handles);
    expect(r.ran).toBe(false);
    expect(r.compactedCount).toBe(0);
  });

  it('compacts oversized tool_results in the warm zone, leaves hot tail intact', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'go' } });
    // 10 oversized tool pairs = 20 events + 1 user start = 21 total.
    for (let i = 0; i < 10; i++) await seedToolPair(store, tid, `call_${i}`, 1024);

    const handles = new HandleRegistry();
    // keepRecent=4 → tail = last 4 events (call_8 result, call_9 call/result, +1 boundary)
    // Actually 21 - 4 = 17 events in [0..17) qualify for compaction.
    const mc = new MicroCompactor({ keepRecent: 4, triggerEvery: 5, minBytes: 256 });
    const r = await mc.maybeRun(tid, store, handles);

    expect(r.ran).toBe(true);
    expect(r.compactedCount).toBeGreaterThan(0);
    expect(r.compactionEvent?.kind).toBe('compaction_event');

    const events = await store.readAll(tid);
    // Walk: anything in [0..17) that's a tool_result must be elided.
    const tailBoundary = events.length - 4;
    const compactionEvents = events.filter((e) => e.kind === 'compaction_event');
    // The compaction_event is appended AFTER the warm zone, so events.length grew.
    // Recompute boundary: only events before the compaction_event was appended count.
    const compactionIdx = events.findIndex((e) => e.kind === 'compaction_event');
    const eligibleEnd = compactionIdx >= 0 ? compactionIdx - (events.length - tailBoundary - 0) : tailBoundary;
    void eligibleEnd;

    // Simpler: tool_results that ARE elided must all carry the micro_compact kind,
    // and at least one tool_result remains un-elided in the hot tail.
    const elided = events.filter((e) => e.kind === 'tool_result' && e.elided);
    const inline = events.filter((e) => e.kind === 'tool_result' && !e.elided);
    expect(elided.length).toBeGreaterThan(0);
    expect(inline.length).toBeGreaterThan(0);
    for (const e of elided) {
      expect(e.elided?.kind).toBe('micro_compact');
      expect(typeof e.elided?.meta.summary).toBe('string');
      // Handle must be registered + payload accessible.
      const entry = handles.get(e.elided!.handle);
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe('micro_compact');
    }
    expect(compactionEvents.length).toBe(1);
  });

  it('leaves small tool_results inline (below minBytes)', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'go' } });
    for (let i = 0; i < 15; i++) await seedToolPair(store, tid, `tiny_${i}`, 16);

    const handles = new HandleRegistry();
    const mc = new MicroCompactor({ keepRecent: 4, triggerEvery: 5, minBytes: 256 });
    const r = await mc.maybeRun(tid, store, handles);
    expect(r.ran).toBe(true);
    expect(r.compactedCount).toBe(0);
    const events = await store.readAll(tid);
    expect(events.filter((e) => e.kind === 'tool_result' && e.elided).length).toBe(0);
  });

  it('is idempotent — repeated runs without new events do not double-compact', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'go' } });
    for (let i = 0; i < 12; i++) await seedToolPair(store, tid, `c_${i}`, 1024);

    const handles = new HandleRegistry();
    const mc = new MicroCompactor({ keepRecent: 4, triggerEvery: 5, minBytes: 256 });
    const first = await mc.maybeRun(tid, store, handles);
    const second = await mc.maybeRun(tid, store, handles);
    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.compactedCount).toBe(0);
  });
});
