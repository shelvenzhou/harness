import { describe, expect, it } from 'vitest';

import { ProviderUsageRegistry } from '@harness/llm/providerUsageRegistry.js';

describe('ProviderUsageRegistry', () => {
  it('returns undefined for absent provider', () => {
    const r = new ProviderUsageRegistry();
    expect(r.get('cc')).toBeUndefined();
    expect(r.has('cc')).toBe(false);
    expect(r.entries()).toEqual([]);
  });

  it('records first patch with timestamp + provider key', () => {
    const r = new ProviderUsageRegistry();
    r.update('cc', { lastSessionId: 's1', lastModel: 'm' });
    const snap = r.get('cc');
    expect(snap?.provider).toBe('cc');
    expect(snap?.lastSessionId).toBe('s1');
    expect(snap?.lastModel).toBe('m');
    expect(typeof snap?.lastUpdateAt).toBe('string');
  });

  it('merges patches: undefined fields keep prior values', () => {
    const r = new ProviderUsageRegistry();
    r.update('cc', { lastSessionId: 's1', lastModel: 'm', lastCostUsd: 0.01 });
    r.update('cc', { lastSessionId: 's2' }); // model + cost should survive
    const snap = r.get('cc');
    expect(snap?.lastSessionId).toBe('s2');
    expect(snap?.lastModel).toBe('m');
    expect(snap?.lastCostUsd).toBe(0.01);
  });

  it('keeps separate snapshots per provider id', () => {
    const r = new ProviderUsageRegistry();
    r.update('cc', { lastSessionId: 'cc-1' });
    r.update('codex', { lastSessionId: 'cx-1' });
    expect(r.entries()).toHaveLength(2);
    expect(r.get('cc')?.lastSessionId).toBe('cc-1');
    expect(r.get('codex')?.lastSessionId).toBe('cx-1');
  });
});
