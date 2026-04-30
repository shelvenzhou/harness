import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TerminalAdapter } from '@harness/adapters/terminal.js';
import { EventBus } from '@harness/bus/eventBus.js';
import { newThreadId } from '@harness/core/ids.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import { MemorySessionStore } from '@harness/store/index.js';
import type { HarnessEvent } from '@harness/core/events.js';

/**
 * Step 5 contract: the TerminalAdapter must turn the first SIGINT into
 * an `interrupt` event on the bus and the second SIGINT (within the
 * doubleInterruptMs window) into a graceful adapter shutdown that
 * resolves `whenShutdown()`. Pre-fix the adapter ignored SIGINT
 * entirely, so Ctrl-C just killed the process and the runtime never
 * saw a chance to drain.
 *
 * We can't actually deliver SIGINT here (the test harness handles it
 * itself), so we synthesise the same effect by emitting the SIGINT
 * event on `process` — Node fires registered listeners for synthesised
 * `process.emit('SIGINT')` calls.
 */

let sigintListenersBefore: number;

beforeEach(() => {
  sigintListenersBefore = process.listenerCount('SIGINT');
});
afterEach(() => {
  // Make sure we didn't leak a listener.
  expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
});

async function makeAdapter(doubleInterruptMs = 2_000) {
  const bus = new EventBus();
  const store = new MemorySessionStore();
  const tid = newThreadId();
  await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
  const input = new PassThrough();
  const output = new PassThrough();
  const adapter = new TerminalAdapter({
    store,
    input,
    output,
    doubleInterruptMs,
  });
  await adapter.start({ bus, threadBinding: { kind: 'single', threadId: tid } });
  return { adapter, bus, store, threadId: tid, output };
}

function readOutput(stream: PassThrough): string {
  const chunks = stream.read();
  return chunks ? chunks.toString('utf8') : '';
}

describe('adapter: terminal SIGINT handling', () => {
  it('first SIGINT publishes an interrupt; second within window resolves whenShutdown', async () => {
    const { adapter, bus, output } = await makeAdapter(50);

    const interrupts: HarnessEvent[] = [];
    bus.subscribe(
      (ev) => {
        interrupts.push(ev);
      },
      { kinds: ['interrupt'] },
    );

    // Drain whatever the prompt wrote.
    await new Promise((r) => setImmediate(r));
    output.read();

    // First SIGINT → interrupt event + visible feedback.
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(interrupts.length).toBe(1);
    expect((interrupts[0]!.payload as { reason: string }).reason).toContain('user');
    const firstOutput = readOutput(output);
    expect(firstOutput).toContain('interrupting');

    // Second SIGINT inside the window → graceful shutdown.
    const shutdown = adapter.whenShutdown();
    process.emit('SIGINT');
    await shutdown; // resolves cleanly
    const secondOutput = readOutput(output);
    expect(secondOutput).toContain('exiting');
  });

  it('two SIGINTs spaced beyond the window stay as soft interrupts', async () => {
    const { adapter, bus } = await makeAdapter(20);

    const interrupts: HarnessEvent[] = [];
    bus.subscribe(
      (ev) => {
        interrupts.push(ev);
      },
      { kinds: ['interrupt'] },
    );
    await new Promise((r) => setImmediate(r));

    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 50)); // beyond doubleInterruptMs=20
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 10));

    expect(interrupts.length).toBe(2);

    // Adapter must still be live; clean up explicitly.
    await adapter.stop();
  });

  it('renders turn_complete reason when summary is absent', async () => {
    const { adapter, bus, output, threadId } = await makeAdapter(20);
    await new Promise((r) => setImmediate(r));
    output.read();

    bus.publish({
      id: 'evt_turn_complete' as never,
      threadId,
      kind: 'turn_complete',
      createdAt: new Date().toISOString(),
      payload: {
        status: 'interrupted',
        reason: 'test cancel',
      },
    } as HarnessEvent);
    await new Promise((r) => setImmediate(r));

    expect(readOutput(output)).toContain('[turn interrupted: test cancel]');
    await adapter.stop();
  });
});
