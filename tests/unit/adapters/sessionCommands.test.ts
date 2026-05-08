import { describe, expect, it } from 'vitest';

import {
  attachPreviews,
  formatStatus,
  parseSessionCommand,
  recentThreads,
  resolveThreadRef,
} from '@harness/adapters/sessionCommands.js';
import { newEventId, type ThreadId } from '@harness/core/ids.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import type { Thread } from '@harness/core/thread.js';
import { MemorySessionStore } from '@harness/store/index.js';

/**
 * The slash-command surface (/status, /new, /resume) is shared between
 * the terminal and Discord adapters via this helper. Tests here pin the
 * grammar (what counts as a command), the resolution semantics (index vs
 * id-prefix), and the listing filter (archived threads must not surface).
 */

function makeThread(id: string, title: string | undefined, updatedAt: string): Thread {
  return {
    id: id as ThreadId,
    ...(title !== undefined ? { title } : {}),
    status: title?.startsWith('discord:archived:') ? 'archived' : 'active',
    rootTraceparent: '00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-00',
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('parseSessionCommand', () => {
  it('matches /status, /new, /resume exactly', () => {
    expect(parseSessionCommand('/status')).toEqual({ kind: 'status' });
    expect(parseSessionCommand('/new')).toEqual({ kind: 'new' });
    expect(parseSessionCommand('/resume')).toEqual({ kind: 'resume', arg: undefined });
    expect(parseSessionCommand('/resume thr_abc')).toEqual({ kind: 'resume', arg: 'thr_abc' });
    expect(parseSessionCommand('/resume   2  ')).toEqual({ kind: 'resume', arg: '2' });
  });

  it('ignores anything that is not a session command', () => {
    expect(parseSessionCommand('hello')).toBeUndefined();
    expect(parseSessionCommand('/exit')).toBeUndefined();
    expect(parseSessionCommand('/interrupt')).toBeUndefined();
    expect(parseSessionCommand('/statusquo')).toBeUndefined();
  });
});

describe('recentThreads', () => {
  it('sorts by updatedAt desc and drops archived threads', () => {
    const threads: Thread[] = [
      makeThread('thr_aaaa1111', 'a', '2026-05-01T00:00:00Z'),
      makeThread('thr_bbbb2222', undefined, '2026-05-03T00:00:00Z'),
      makeThread('thr_cccc3333', 'discord:archived:C1:2026-04-01', '2026-05-04T00:00:00Z'),
      makeThread('thr_dddd4444', 'd', '2026-05-02T00:00:00Z'),
    ];
    const result = recentThreads(threads, 10);
    expect(result.map((t) => t.threadId)).toEqual(['thr_bbbb2222', 'thr_dddd4444', 'thr_aaaa1111']);
  });
});

describe('resolveThreadRef', () => {
  const listed = [
    { threadId: 'thr_aaaa1111' as ThreadId, title: 'a', updatedAt: '' },
    { threadId: 'thr_bbbb2222' as ThreadId, title: 'b', updatedAt: '' },
    { threadId: 'thr_aaaa9999' as ThreadId, title: 'c', updatedAt: '' },
  ];

  it('resolves a 1-based index from the listed array', () => {
    const r = resolveThreadRef(listed, '2');
    expect(r.ok && r.threadId).toBe('thr_bbbb2222');
  });

  it('rejects an out-of-range index', () => {
    const r = resolveThreadRef(listed, '99');
    expect(r.ok).toBe(false);
  });

  it('resolves a unique id-prefix', () => {
    const r = resolveThreadRef(listed, 'thr_bbb');
    expect(r.ok && r.threadId).toBe('thr_bbbb2222');
  });

  it('rejects an ambiguous prefix', () => {
    const r = resolveThreadRef(listed, 'thr_aaaa');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous');
  });

  it('rejects an unknown prefix', () => {
    const r = resolveThreadRef(listed, 'thr_zzzz');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-found');
  });

  it('reports missing-arg when no input is supplied', () => {
    const r = resolveThreadRef(listed, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing-arg');
  });
});

describe('formatStatus', () => {
  it('renders current marker, recent list, and previews when present', () => {
    const now = Date.parse('2026-05-07T12:00:00Z');
    const out = formatStatus({
      currentThreadId: 'thr_aaaa1111' as ThreadId,
      currentTitle: 'hello',
      turnActive: false,
      recent: [
        {
          threadId: 'thr_aaaa1111' as ThreadId,
          title: 'hello',
          updatedAt: '2026-05-07T11:59:30Z',
          preview: 'first prompt was about caching',
        },
        {
          threadId: 'thr_bbbb2222' as ThreadId,
          title: undefined,
          updatedAt: '2026-05-06T12:00:00Z',
        },
      ],
      now,
    });
    expect(out).toContain('current: thr_aaaa1111');
    expect(out).toContain('"hello"');
    expect(out).toContain('turn: idle');
    expect(out).toContain('(current)');
    expect(out).toContain('thr_bbbb2222');
    expect(out).toContain('1d ago');
    expect(out).toContain('› first prompt was about caching');
  });
});

describe('attachPreviews', () => {
  it('reads first user_turn_start text and truncates long prompts', async () => {
    const store = new MemorySessionStore();
    const a = 'thr_aaaa1111' as ThreadId;
    const b = 'thr_bbbb2222' as ThreadId;
    await store.createThread({ id: a, rootTraceparent: newRootTraceparent() });
    await store.createThread({ id: b, rootTraceparent: newRootTraceparent() });
    await store.append({
      id: newEventId(),
      threadId: a,
      kind: 'user_turn_start',
      payload: { text: 'how do I configure prompt caching?' },
    });
    // Long text gets truncated.
    await store.append({
      id: newEventId(),
      threadId: b,
      kind: 'user_turn_start',
      payload: { text: 'x'.repeat(500) },
    });
    const enriched = await attachPreviews(
      store,
      [
        { threadId: a, title: undefined, updatedAt: '' },
        { threadId: b, title: undefined, updatedAt: '' },
      ],
      80,
    );
    expect(enriched[0]!.preview).toBe('how do I configure prompt caching?');
    expect(enriched[1]!.preview?.endsWith('…')).toBe(true);
    expect(enriched[1]!.preview?.length).toBe(80);
  });

  it('leaves preview undefined when the thread has no user_turn_start yet', async () => {
    const store = new MemorySessionStore();
    const a = 'thr_aaaa1111' as ThreadId;
    await store.createThread({ id: a, rootTraceparent: newRootTraceparent() });
    const enriched = await attachPreviews(store, [
      { threadId: a, title: undefined, updatedAt: '' },
    ]);
    expect(enriched[0]!.preview).toBeUndefined();
  });
});
