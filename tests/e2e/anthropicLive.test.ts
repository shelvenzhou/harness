import { describe, it, expect } from 'vitest';

import { AnthropicProvider } from '@harness/llm/anthropicProvider.js';

/**
 * E2E test against the real Anthropic API.
 *
 * Skipped unless `HARNESS_E2E=1` AND `ANTHROPIC_API_KEY` is set.
 *
 * Phase 1 only verifies provider construction and that capabilities are
 * reported — the sample() path is not implemented yet. Once phase 2
 * lands, this file picks up real round-trip assertions.
 */

const shouldRun =
  process.env['HARNESS_E2E'] === '1' && Boolean(process.env['ANTHROPIC_API_KEY']);

describe.skipIf(!shouldRun)('e2e: anthropic provider', () => {
  it('constructs with an api key and reports capabilities', () => {
    const p = new AnthropicProvider({ apiKey: process.env['ANTHROPIC_API_KEY']! });
    expect(p.id).toBe('anthropic');
    expect(p.capabilities.nativeToolUse).toBe(true);
  });

  it.skip('round-trips a hello-world prompt (unskip in phase 2)', () => {
    // Placeholder — phase 2 wires real streaming; assertion will become:
    // const runtime = await bootstrap({ provider, systemPrompt: '…' });
    // runtime.bus.publish(user_turn_start('hello'));
    // await waitForTurnComplete(runtime);
    // expect(getAllReplies()).toMatch(/./);
  });
});
