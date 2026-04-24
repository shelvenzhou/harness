import { describe, it, expect } from 'vitest';
import 'dotenv/config';

import { OpenAIProvider } from '@harness/llm/openaiProvider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';

/**
 * Real OpenAI round-trip. Skipped unless:
 *   - HARNESS_E2E=1
 *   - OPENAI_API_KEY is set
 *
 * Copy .env.example to .env to configure. OPENAI_BASE_URL lets you point
 * this at any OpenAI-compatible endpoint for cheaper testing.
 */

const shouldRun =
  process.env['HARNESS_E2E'] === '1' && Boolean(process.env['OPENAI_API_KEY']);

describe.skipIf(!shouldRun)('e2e: openai provider', () => {
  it('constructs with env config', () => {
    const p = new OpenAIProvider({
      apiKey: process.env['OPENAI_API_KEY']!,
      ...(process.env['OPENAI_MODEL'] ? { model: process.env['OPENAI_MODEL'] } : {}),
      ...(process.env['OPENAI_BASE_URL'] ? { baseURL: process.env['OPENAI_BASE_URL'] } : {}),
    });
    expect(p.id).toBe('openai');
    expect(p.capabilities.nativeToolUse).toBe(true);
  });

  it('runs a full turn and produces a non-empty reply', async () => {
    const provider = new OpenAIProvider({
      apiKey: process.env['OPENAI_API_KEY']!,
      ...(process.env['OPENAI_MODEL'] ? { model: process.env['OPENAI_MODEL'] } : {}),
      ...(process.env['OPENAI_BASE_URL'] ? { baseURL: process.env['OPENAI_BASE_URL'] } : {}),
      defaultMaxTokens: 64,
    });
    const runtime = await bootstrap({
      provider,
      systemPrompt: 'You are a terse assistant. Reply in one short sentence.',
    });

    // Seed the root thread with a user turn and wait for turn_complete.
    const done = new Promise<void>((resolve) => {
      const sub = runtime.bus.subscribe(
        (ev) => {
          if (ev.kind === 'turn_complete') {
            sub.unsubscribe();
            resolve();
          }
        },
        { threadId: runtime.rootThreadId, kinds: ['turn_complete'] },
      );
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'Say "hi" and nothing else.' },
    });
    runtime.bus.publish(seed);

    await Promise.race([
      done,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 20_000)),
    ]);

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const replies = events
      .filter((e) => e.kind === 'reply')
      .map((e) => (e.payload as { text: string }).text)
      .join('');
    expect(replies.trim().length).toBeGreaterThan(0);
  }, 30_000);
});
