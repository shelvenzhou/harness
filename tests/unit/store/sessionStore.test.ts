import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { newEventId, newHandleRef, newThreadId } from '@harness/core/ids.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import { MemorySessionStore, JsonlSessionStore } from '@harness/store/index.js';

describe('MemorySessionStore', () => {
  it('append + readAll preserves order', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    const a = await store.append({
      threadId: tid,
      kind: 'user_turn_start',
      payload: { text: 'a' },
    });
    const b = await store.append({
      threadId: tid,
      kind: 'reply',
      payload: { text: 'b' },
    });
    const all = await store.readAll(tid);
    expect(all.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('readSince returns tail after cursor', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    const a = await store.append({ threadId: tid, kind: 'reply', payload: { text: 'a' } });
    await store.append({ threadId: tid, kind: 'reply', payload: { text: 'b' } });
    const tail = await store.readSince(tid, a.id);
    expect(tail.map((e) => (e.payload as { text: string }).text)).toEqual(['b']);
  });

  it('attachElision updates the stored event', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    const ev = await store.append({
      threadId: tid,
      kind: 'tool_result',
      payload: { toolCallId: 'tc_1' as never, ok: true, output: 'x' },
    });
    await store.attachElision(tid, ev.id, {
      handle: newHandleRef(),
      kind: 'test',
      meta: {},
    });
    const loaded = await store.getEvent(tid, ev.id);
    expect(loaded?.elided?.kind).toBe('test');
  });
});

describe('JsonlSessionStore', () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    for (const dir of cleanups.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists events to disk and reloads them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-store-'));
    cleanups.push(root);
    const tid = newThreadId();
    {
      const store = new JsonlSessionStore({ root });
      await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
      await store.append({
        id: newEventId(),
        threadId: tid,
        kind: 'user_turn_start',
        payload: { text: 'hi' },
      });
      await store.close();
    }
    // Reload.
    const store = new JsonlSessionStore({ root });
    const thread = await store.getThread(tid);
    expect(thread?.id).toBe(tid);
    const events = await store.readAll(tid);
    expect(events.map((e) => e.kind)).toEqual(['user_turn_start']);
    // Spot-check: the jsonl file has a line per event.
    const content = await readFile(join(root, tid, 'events.jsonl'), 'utf8');
    expect(content.split('\n').filter(Boolean).length).toBe(1);
  });
});
