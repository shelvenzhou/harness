import { describe, expect, it } from 'vitest';
import 'dotenv/config';

import { Mem0Store } from '@harness/memory/mem0Store.js';

/**
 * Live mem0 round-trip. Skipped unless:
 *   - HARNESS_E2E=1
 *   - MEM0_API_KEY is set
 *
 * Targets cloud by default. For a self-hosted server set MEM0_BASE_URL.
 *
 * The test uses a unique key per run so concurrent CI runs don't
 * collide; it cleans up after itself.
 */

const shouldRun =
  process.env['HARNESS_E2E'] === '1' && Boolean(process.env['MEM0_API_KEY']);

describe.skipIf(!shouldRun)('e2e: mem0 backend', () => {
  const userId = process.env['MEM0_USER_ID'] ?? `harness-e2e-${Date.now()}`;

  function makeStore(): Mem0Store {
    return new Mem0Store({
      apiKey: process.env['MEM0_API_KEY']!,
      ...(process.env['MEM0_BASE_URL'] ? { baseURL: process.env['MEM0_BASE_URL'] } : {}),
      defaultUserId: userId,
    });
  }

  it('set + get + delete round-trips against the live API', async () => {
    const m = makeStore();
    const key = `test.name.${Date.now()}`;
    await m.set(key, 'shelven', { pinned: true });

    const got = await m.get(key);
    expect(got?.value).toBe('shelven');
    expect(got?.pinned).toBe(true);

    const pinned = await m.pinned();
    expect(pinned.some((e) => e.key === key)).toBe(true);

    expect(await m.delete(key)).toBe(true);
    expect(await m.get(key)).toBeUndefined();
  }, 30_000);

  it('ingest extracts a fact via mem0 LLM pipeline', async () => {
    const m = makeStore();
    const out = await m.ingest({
      messages: [
        { role: 'user', content: 'My favourite ice cream flavour is matcha.' },
      ],
    });
    // mem0 may return zero or many extracted facts; we just assert the
    // call shape works end-to-end and search can find something near it.
    const hits = await m.search('ice cream', { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // Cleanup the freshly minted entries.
    for (const e of out) await m.delete(e.id).catch(() => undefined);
  }, 60_000);
});
