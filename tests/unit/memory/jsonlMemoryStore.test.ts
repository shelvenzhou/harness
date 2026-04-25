import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlMemoryStore } from '@harness/memory/index.js';

/**
 * The whole reason this backend exists: a fact written in one process
 * must be readable by the next process pointed at the same file. Tests
 * here simulate that by closing one store and opening a fresh one over
 * the same path.
 */

describe('JsonlMemoryStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-mem-'));
    path = join(dir, 'memory.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists set across instances', async () => {
    const a = new JsonlMemoryStore({ path });
    await a.set('user.name', 'shelven', { pinned: true });
    await a.close();

    const b = new JsonlMemoryStore({ path });
    const got = await b.get('user.name');
    expect(got?.value).toBe('shelven');
    expect(got?.pinned).toBe(true);
    const pinned = await b.pinned();
    expect(pinned).toHaveLength(1);
  });

  it('replays update + delete in order', async () => {
    const a = new JsonlMemoryStore({ path });
    await a.set('plan', 'v1');
    await a.update('plan', { value: 'v2' });
    await a.set('throwaway', 'x');
    await a.delete('throwaway');
    await a.close();

    const b = new JsonlMemoryStore({ path });
    const plan = await b.get('plan');
    const throwaway = await b.get('throwaway');
    expect(plan?.value).toBe('v2');
    expect(throwaway).toBeUndefined();
  });

  it('tolerates a torn trailing line on replay', async () => {
    const a = new JsonlMemoryStore({ path });
    await a.set('user.name', 'shelven');
    await a.close();
    // Append a half-written entry to simulate a crash mid-write.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"op":"set","key":"broken","val', 'utf-8');

    const b = new JsonlMemoryStore({ path });
    const ok = await b.get('user.name');
    expect(ok?.value).toBe('shelven');
    const broken = await b.get('broken');
    expect(broken).toBeUndefined();
  });

  it('reports persistent + non-cross-process capabilities', () => {
    const m = new JsonlMemoryStore({ path });
    expect(m.capabilities.persistent).toBe(true);
    expect(m.capabilities.crossProcess).toBe(false);
  });
});
