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

  it('persists elisions to a sidecar log and replays them on reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-elision-'));
    cleanups.push(root);
    const tid = newThreadId();
    const handle = newHandleRef();
    let evId: string;
    {
      const store = new JsonlSessionStore({ root });
      await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
      const ev = await store.append({
        threadId: tid,
        kind: 'tool_result',
        payload: { toolCallId: 'tc_1' as never, ok: true, output: 'big payload' },
      });
      evId = ev.id;
      await store.attachElision(tid, ev.id, {
        handle,
        kind: 'shell:stdout',
        meta: { bytes: 4_000_000 },
      });
      // Sidecar must exist; otherwise reload would lose the elision.
      const sidecar = await readFile(join(root, tid, 'elisions.jsonl'), 'utf8');
      expect(sidecar.split('\n').filter(Boolean).length).toBe(1);
      await store.close();
    }
    // Cold reload: no in-memory state survives.
    const store = new JsonlSessionStore({ root });
    const ev = await store.getEvent(tid, evId as never);
    expect(ev?.elided?.handle).toBe(handle);
    expect(ev?.elided?.kind).toBe('shell:stdout');
  });
});

describe('SessionStore.fork', () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    for (const dir of cleanups.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('memory: copies events up to a boundary into a new thread', async () => {
    const store = new MemorySessionStore();
    const src = newThreadId();
    await store.createThread({ id: src, rootTraceparent: newRootTraceparent() });
    const a = await store.append({ threadId: src, kind: 'reply', payload: { text: 'a' } });
    const b = await store.append({ threadId: src, kind: 'reply', payload: { text: 'b' } });
    await store.append({ threadId: src, kind: 'reply', payload: { text: 'c' } });

    const fid = newThreadId();
    const child = await store.fork({ source: src, untilEventId: b.id, newThreadId: fid });
    expect(child.parentThreadId).toBe(src);

    const copied = await store.readAll(fid);
    expect(copied.map((e) => (e.payload as { text: string }).text)).toEqual(['a', 'b']);
    // Fresh ids — fork is not a shallow alias.
    expect(copied[0]!.id).not.toBe(a.id);
    expect(copied[1]!.id).not.toBe(b.id);
    // Originals untouched.
    const orig = await store.readAll(src);
    expect(orig.length).toBe(3);
  });

  it('jsonl: forked thread persists and reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-fork-'));
    cleanups.push(root);
    const src = newThreadId();
    const fid = newThreadId();
    {
      const store = new JsonlSessionStore({ root });
      await store.createThread({ id: src, rootTraceparent: newRootTraceparent() });
      const a = await store.append({ threadId: src, kind: 'reply', payload: { text: 'a' } });
      await store.append({ threadId: src, kind: 'reply', payload: { text: 'b' } });
      await store.fork({ source: src, untilEventId: a.id, newThreadId: fid, title: 'fork' });
      await store.close();
    }
    const store = new JsonlSessionStore({ root });
    const child = await store.getThread(fid);
    expect(child?.parentThreadId).toBe(src);
    expect(child?.title).toBe('fork');
    const events = await store.readAll(fid);
    expect(events.map((e) => (e.payload as { text: string }).text)).toEqual(['a']);
  });
});
