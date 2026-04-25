import { describe, expect, it } from 'vitest';

import { InMemoryStore } from '@harness/memory/index.js';

/**
 * InMemoryStore is the canonical reference for the MemoryStore
 * interface. Tests here also act as a behaviour spec other backends
 * (JSONL, mem0, …) must match for the operations they support.
 */

describe('InMemoryStore', () => {
  it('set + get round-trips a value with default scope', async () => {
    const m = new InMemoryStore();
    await m.set('user.name', 'shelven');
    const got = await m.get('user.name');
    expect(got?.value).toBe('shelven');
    expect(got?.content).toBe('shelven');
    expect(got?.scope).toBe('global');
    expect(got?.pinned).toBe(false);
  });

  it('set with pinned=true is reported by pinned()', async () => {
    const m = new InMemoryStore();
    await m.set('user.name', 'shelven', { pinned: true });
    await m.set('project.lang', 'typescript');
    const pinned = await m.pinned();
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.key).toBe('user.name');
  });

  it('update flips pinned without changing value', async () => {
    const m = new InMemoryStore();
    await m.set('user.name', 'shelven');
    const updated = await m.update('user.name', { pinned: true });
    expect(updated?.pinned).toBe(true);
    expect(updated?.value).toBe('shelven');
  });

  it('namespaces isolate entries', async () => {
    const m = new InMemoryStore();
    await m.set('note', 'global note');
    await m.set('note', 'thread note', {
      scope: 'thread',
      namespace: { threadId: 'thr_xyz' as never },
    });
    const g = await m.get('note');
    const t = await m.get('note', { scope: 'thread', namespace: { threadId: 'thr_xyz' as never } });
    expect(g?.value).toBe('global note');
    expect(t?.value).toBe('thread note');
  });

  it('search prefers exact > prefix > substring', async () => {
    const m = new InMemoryStore();
    await m.set('user.name', 'shelven');
    await m.set('user.email', 'foo@bar');
    await m.set('project', 'shelven works on this');
    const hits = await m.search('shelven');
    expect(hits[0]?.reason).toBe('exact');
    expect(hits[0]?.entry.key).toBe('user.name');
    // 'project' content includes 'shelven' as substring → lower score.
    const projHit = hits.find((h) => h.entry.key === 'project');
    expect(projHit?.reason).toBe('substring');
  });

  it('ingest stores raw transcript when LLM extraction is unavailable', async () => {
    const m = new InMemoryStore();
    const out = await m.ingest({
      messages: [
        { role: 'user', content: 'my name is shelven' },
        { role: 'assistant', content: 'noted' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toContain('shelven');
    expect(out[0]?.source).toBe('extracted');
  });

  it('reports capabilities accurately', async () => {
    const m = new InMemoryStore();
    expect(m.capabilities.semanticSearch).toBe(false);
    expect(m.capabilities.persistent).toBe(false);
    expect(m.capabilities.crossProcess).toBe(false);
  });
});
