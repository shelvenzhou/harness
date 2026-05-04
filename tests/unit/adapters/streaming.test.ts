import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { TerminalAdapter } from '@harness/adapters/terminal.js';
import { EventBus } from '@harness/bus/eventBus.js';
import { StreamBus } from '@harness/bus/streamBus.js';
import { newEventId, newThreadId, newTurnId } from '@harness/core/ids.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import { MemorySessionStore } from '@harness/store/index.js';
import type { HarnessEvent } from '@harness/core/events.js';

/**
 * The TerminalAdapter must:
 *   - render text/reasoning deltas inline as they arrive on the
 *     StreamBus (so users see thinking happening),
 *   - and then NOT re-print the same text when the persisted
 *     reply/preamble/reasoning event lands at sampling end.
 *
 * Tests use PassThrough streams (non-TTY) so we go through the
 * readline branch — keeps these focused on the bus → render path.
 */

async function makeAdapter() {
  const bus = new EventBus();
  const streamBus = new StreamBus();
  const store = new MemorySessionStore();
  const tid = newThreadId();
  const turnId = newTurnId();
  await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
  const input = new PassThrough();
  const output = new PassThrough();
  const captured: string[] = [];
  output.on('data', (chunk) => captured.push(chunk.toString('utf8')));
  const adapter = new TerminalAdapter({ store, input, output });
  await adapter.start({
    bus,
    streamBus,
    threadBinding: { kind: 'single', threadId: tid },
  });
  return { adapter, bus, streamBus, threadId: tid, turnId, captured };
}

function makeReplyEvent(threadId: ReturnType<typeof newThreadId>, text: string): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'reply',
    createdAt: new Date().toISOString(),
    payload: { text },
  } as HarnessEvent;
}
function makeReasoningEvent(threadId: ReturnType<typeof newThreadId>, text: string): HarnessEvent {
  return {
    id: newEventId(),
    threadId,
    kind: 'reasoning',
    createdAt: new Date().toISOString(),
    payload: { text },
  } as HarnessEvent;
}

describe('TerminalAdapter streaming', () => {
  it('renders text_delta inline and dedupes the matching reply event', async () => {
    const { adapter, bus, streamBus, threadId, turnId, captured } = await makeAdapter();
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'hel' });
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'lo' });
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    bus.publish(makeReplyEvent(threadId, 'hello'));
    await new Promise((r) => setImmediate(r));

    const out = captured.join('');
    // Streamed content must appear exactly once — we don't want the
    // persisted reply to re-print "hello" after we already streamed it.
    expect(out.match(/hello/g) ?? []).toHaveLength(1);
    // We did open a streamed line with the prefix.
    expect(out).toContain('▸ hel');
    await adapter.stop();
  });

  it('falls back to a fresh print when the persisted reply does not match streamed content', async () => {
    const { adapter, bus, streamBus, threadId, turnId, captured } = await makeAdapter();
    streamBus.publish({ kind: 'text_delta', threadId, turnId, text: 'partial' });
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    // Different final text (e.g. provider reclassified mid-stream).
    bus.publish(makeReplyEvent(threadId, 'completely different'));
    await new Promise((r) => setImmediate(r));

    const out = captured.join('');
    expect(out).toContain('partial');
    expect(out).toContain('▸ completely different');
    await adapter.stop();
  });

  it('streams reasoning deltas and dedupes the matching reasoning event', async () => {
    const { adapter, bus, streamBus, threadId, turnId, captured } = await makeAdapter();
    streamBus.publish({ kind: 'reasoning_delta', threadId, turnId, text: 'thinking…' });
    streamBus.publish({ kind: 'sampling_flush', threadId, turnId });
    bus.publish(makeReasoningEvent(threadId, 'thinking…'));
    await new Promise((r) => setImmediate(r));

    const out = captured.join('');
    expect(out).toContain('✻ thinking…');
    expect(out.match(/thinking…/g) ?? []).toHaveLength(1);
    await adapter.stop();
  });

  it('renders reasoning when only the persisted event is present (no streaming)', async () => {
    const { adapter, bus, threadId, captured } = await makeAdapter();
    bus.publish(makeReasoningEvent(threadId, 'cold-path thoughts'));
    await new Promise((r) => setImmediate(r));

    const out = captured.join('');
    expect(out).toContain('✻ cold-path thoughts');
    await adapter.stop();
  });
});
