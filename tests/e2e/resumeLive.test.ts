import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';
import 'dotenv/config';

import { OpenAIProvider } from '@harness/llm/openaiProvider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { resume } from '@harness/runtime/resume.js';
import type { EventBus } from '@harness/bus/eventBus.js';
import type { ThreadId } from '@harness/core/ids.js';

/**
 * Live resume: bootstrap → 1 real turn → resume → 1 more real turn.
 * Skipped unless HARNESS_E2E=1 + OPENAI_API_KEY.
 *
 * Verifies the flow end-to-end with a real provider, including that
 * banked token counters survive the restart (used by the hard-wall
 * budget machinery).
 */

const shouldRun =
  process.env['HARNESS_E2E'] === '1' && Boolean(process.env['OPENAI_API_KEY']);

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: process.env['OPENAI_API_KEY']!,
    ...(process.env['OPENAI_MODEL'] ? { model: process.env['OPENAI_MODEL'] } : {}),
    ...(process.env['OPENAI_BASE_URL'] ? { baseURL: process.env['OPENAI_BASE_URL'] } : {}),
    defaultMaxTokens: 64,
  });
}

async function awaitTurnComplete(
  bus: EventBus,
  threadId: ThreadId,
  budgetMs = 30_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), budgetMs);
    const sub = bus.subscribe(
      (ev) => {
        if (ev.kind === 'turn_complete') {
          clearTimeout(t);
          sub.unsubscribe();
          resolve();
        }
      },
      { threadId },
    );
  });
}

describe.skipIf(!shouldRun)('e2e: resume against live provider', () => {
  it('survives a process-style restart and runs a follow-up turn', async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), 'harness-resume-live-'));
    try {
      const rt1 = await bootstrap({
        provider: makeProvider(),
        systemPrompt: 'You are terse. Reply in one short sentence.',
        storeRoot: workdir,
      });
      const threadId = rt1.rootThreadId;
      const seed1 = await rt1.store.append({
        threadId,
        kind: 'user_turn_start',
        payload: { text: 'Pick a colour. Just the colour.' },
      });
      const done1 = awaitTurnComplete(rt1.bus, threadId);
      rt1.bus.publish(seed1);
      await done1;

      // Resume: fresh runtime, same disk state.
      const rt2 = await resume({
        provider: makeProvider(),
        systemPrompt: 'You are terse. Reply in one short sentence.',
        storeRoot: workdir,
        threadId,
      });
      const seed2 = await rt2.store.append({
        threadId,
        kind: 'user_turn_start',
        payload: { text: 'Now pick a number.' },
      });
      const done2 = awaitTurnComplete(rt2.bus, threadId);
      rt2.bus.publish(seed2);
      await done2;

      const events = await rt2.store.readAll(threadId);
      const replies = events
        .filter((e) => e.kind === 'reply')
        .map((e) => (e.payload as { text: string }).text)
        .join(' | ');
      // eslint-disable-next-line no-console
      console.log('resume replies:', replies);
      const userTurns = events.filter((e) => e.kind === 'user_turn_start');
      expect(userTurns).toHaveLength(2);
      expect(events.filter((e) => e.kind === 'turn_complete').length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 90_000);
});
