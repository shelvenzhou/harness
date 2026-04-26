import { describe, it, expect } from 'vitest';
import 'dotenv/config';

import { OpenAIProvider } from '@harness/llm/openaiProvider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { runEval } from '../eval/index.js';
import { echoGreetingTask } from '../eval/tasks/echoGreeting.js';
import { selfVerifyWriteTask } from '../eval/tasks/selfVerifyWrite.js';
import { spawnVerifyTask } from '../eval/tasks/spawnVerify.js';
import { usageAwareTask } from '../eval/tasks/usageAware.js';
import { writeFileTask } from '../eval/tasks/writeFile.js';

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

  // The three tasks below are *agentic-awareness probes*. They are not
  // expected to pass for every model — that's the whole point. They tell
  // you which models spontaneously self-check, query usage, and delegate
  // verification. Status is logged; the assertion is loose (no throw on
  // fail) so a sweep can report results across models without blowing up
  // the test run.

  it('self-verify-write probe', async () => {
    const runtime = await bootstrap({
      provider: makeProvider(),
      systemPrompt:
        'You are a careful coding agent with file-system tools. Use the `write`, `read`, `shell` tools as appropriate.',
    });
    const result = await runEval(selfVerifyWriteTask, runtime, { timeoutMs: 60_000 });
    // eslint-disable-next-line no-console
    console.log('self-verify-write:', JSON.stringify(result, null, 2));
    expect(['pass', 'fail']).toContain(result.status);
  }, 75_000);

  it('harness-usage-aware probe', async () => {
    const runtime = await bootstrap({
      provider: makeProvider(),
      systemPrompt:
        'You are a careful coding agent. You have a strict token budget. The `usage` tool returns your live token consumption when you call it.',
    });
    const result = await runEval(usageAwareTask, runtime, { timeoutMs: 60_000 });
    // eslint-disable-next-line no-console
    console.log('harness-usage-aware:', JSON.stringify(result, null, 2));
    expect(['pass', 'fail']).toContain(result.status);
  }, 75_000);

  it('harness-spawn-verify probe', async () => {
    const runtime = await bootstrap({
      provider: makeProvider(),
      systemPrompt:
        'You are a careful coding agent. The `spawn` tool forks an independent subagent for delegated work or verification.',
    });
    const result = await runEval(spawnVerifyTask, runtime, { timeoutMs: 60_000 });
    // eslint-disable-next-line no-console
    console.log('harness-spawn-verify:', JSON.stringify(result, null, 2));
    expect(['pass', 'fail']).toContain(result.status);
  }, 75_000);
});
