import { describe, it, expect } from 'vitest';
import 'dotenv/config';

import { OpenAIProvider } from '@harness/llm/openaiProvider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { runEval } from '@harness/eval/index.js';
import { echoGreetingTask } from '@harness/eval/tasks/echoGreeting.js';
import { writeFileTask } from '@harness/eval/tasks/writeFile.js';

/**
 * Live eval e2e — exercises the eval harness against a real provider.
 *
 * Skipped unless:
 *   - HARNESS_E2E=1
 *   - OPENAI_API_KEY is set
 *
 * These tests are the entry point for hand-tuning prompts: when you change
 * a system prompt, tool spec, or compaction rule, run `pnpm test:e2e` and
 * check pass rate + token usage in the ObservedRun.
 */

const shouldRun =
  process.env['HARNESS_E2E'] === '1' && Boolean(process.env['OPENAI_API_KEY']);

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: process.env['OPENAI_API_KEY']!,
    ...(process.env['OPENAI_MODEL'] ? { model: process.env['OPENAI_MODEL'] } : {}),
    ...(process.env['OPENAI_BASE_URL'] ? { baseURL: process.env['OPENAI_BASE_URL'] } : {}),
    defaultMaxTokens: 256,
  });
}

describe.skipIf(!shouldRun)('e2e: eval harness against live provider', () => {
  it('echo-greeting task passes', async () => {
    const runtime = await bootstrap({
      provider: makeProvider(),
      systemPrompt: 'You are a terse assistant. Follow instructions exactly.',
    });
    const result = await runEval(echoGreetingTask, runtime, { timeoutMs: 30_000 });
    // eslint-disable-next-line no-console
    console.log('echo-greeting:', JSON.stringify(result, null, 2));
    expect(result.status).toBe('pass');
  }, 45_000);

  it('write-file task passes', async () => {
    const runtime = await bootstrap({
      provider: makeProvider(),
      systemPrompt:
        'You are a terse assistant with file-system tools. Use the `write` tool when asked to create files.',
    });
    const result = await runEval(writeFileTask, runtime, { timeoutMs: 45_000 });
    // eslint-disable-next-line no-console
    console.log('write-file:', JSON.stringify(result, null, 2));
    expect(result.status).toBe('pass');
  }, 60_000);
});
