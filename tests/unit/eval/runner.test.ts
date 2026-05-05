import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { runEval } from '../../eval/index.js';
import { builtinTasks, getTask } from '../../eval/tasks/index.js';
import { echoGreetingTask } from '../../eval/tasks/echoGreeting.js';
import { writeFileTask } from '../../eval/tasks/writeFile.js';
import type { EvalTask } from '../../eval/types.js';

/**
 * Eval runner unit tests, driven by scripted providers so we exercise the
 * full bus path without touching a real LLM. Live e2e lives in
 * tests/e2e/evalLive.test.ts.
 */

class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  private i = 0;
  constructor(private readonly react: (req: SamplingRequest, i: number) => SamplingDelta[]) {}
  async *sample(req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    const deltas = this.react(req, this.i++);
    for (const d of deltas) {
      if (signal.aborted) return;
      yield d;
    }
    if (!deltas.some((d) => d.kind === 'end')) yield { kind: 'end', stopReason: 'end_turn' };
  }
}

describe('eval/runner', () => {
  it('passes the echo-greeting task when the model emits the marker', async () => {
    const provider = new ScriptedProvider(() => [
      { kind: 'text_delta', text: 'harness-echo-ack-9417', channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ]);
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const result = await runEval(echoGreetingTask, runtime, { timeoutMs: 2_000 });
    expect(result.status).toBe('pass');
    expect(result.observed.replyText).toContain('harness-echo-ack-9417');
    expect(result.observed.toolCalls).toHaveLength(0);
    expect(result.observed.samplingCount).toBeGreaterThanOrEqual(1);
  });

  it('fails the echo-greeting task when the marker is missing', async () => {
    const provider = new ScriptedProvider(() => [
      { kind: 'text_delta', text: 'something else', channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ]);
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const result = await runEval(echoGreetingTask, runtime, { timeoutMs: 2_000 });
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/marker phrase missing/);
  });

  it('fails the echo-greeting task when the model unnecessarily uses a tool', async () => {
    const provider = new ScriptedProvider((_req, i) => {
      if (i === 0) {
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_1' as never, name: 'shell' },
          { kind: 'tool_call_end', toolCallId: 'tc_1' as never, args: { cmd: 'true' } },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'harness-echo-ack-9417', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const result = await runEval(echoGreetingTask, runtime, { timeoutMs: 4_000 });
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/expected no tool calls/);
  });

  it('passes the write-file task when the model uses the write tool correctly', async () => {
    let capturedPath = '';
    const provider = new ScriptedProvider((req, i) => {
      if (i === 0) {
        // Find the prompt path the task interpolated, so we know where to write.
        const lastUser = [...req.tail].reverse().find((m) => m.role === 'user');
        const promptText =
          lastUser?.content
            .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
            .map((c) => c.text)
            .join('\n') ?? '';
        const m = promptText.match(/\s+(\/[^\s]+greeting\.txt)/);
        capturedPath = m?.[1] ?? '';
        return [
          {
            kind: 'tool_call_begin',
            toolCallId: 'tc_w' as never,
            name: 'write',
          },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_w' as never,
            args: { path: capturedPath, content: 'hello-from-harness', mode: 'overwrite' },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'DONE', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const result = await runEval(writeFileTask, runtime, { timeoutMs: 4_000 });
    expect(result.status).toBe('pass');
    expect(result.observed.toolCalls.find((t) => t.name === 'write')).toBeDefined();
    // capturedPath should match the workdir-derived path.
    expect(capturedPath).toContain('greeting.txt');
  });

  it('reports timeout when the model never closes the turn', async () => {
    // Provider returns nothing and yields no end → turn never completes.
    const provider = new ScriptedProvider(() => []);
    // Override: yield no end either.
    const stuck: LlmProvider = {
      id: 'stuck',
      capabilities: provider.capabilities,
      sample(_r, signal) {
        return {
          [Symbol.asyncIterator](): AsyncIterator<SamplingDelta> {
            let done = false;
            return {
              async next(): Promise<IteratorResult<SamplingDelta>> {
                if (!done) {
                  done = true;
                  await new Promise((resolve) => {
                    const t = setTimeout(resolve, 5_000);
                    signal.addEventListener('abort', () => {
                      clearTimeout(t);
                      resolve(undefined);
                    });
                  });
                }
                return { done: true, value: undefined as never };
              },
            };
          },
        };
      },
    };
    const runtime = await bootstrap({ provider: stuck, systemPrompt: 'sys' });
    const result = await runEval(echoGreetingTask, runtime, { timeoutMs: 200 });
    expect(result.status).toBe('timeout');
  });

  it('returns the verify failure as the runner reason when verify rejects', async () => {
    const customTask: EvalTask = {
      id: 'custom-fail',
      description: 'always fails',
      prompt: 'do whatever',
      verify: () => ({ ok: false, reason: 'custom failure reason' }),
    };
    const provider = new ScriptedProvider(() => [
      { kind: 'text_delta', text: 'hi', channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ]);
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const result = await runEval(customTask, runtime, { timeoutMs: 2_000 });
    expect(result.status).toBe('fail');
    expect(result.reason).toBe('custom failure reason');
  });

  it('cleans up the workdir after the run by default', async () => {
    let captured = '';
    const captureTask: EvalTask = {
      id: 'capture-workdir',
      description: 'records its workdir',
      prompt: 'noop',
      setup: (ctx) => {
        captured = ctx.workdir;
      },
      verify: () => ({ ok: true }),
    };
    const provider = new ScriptedProvider(() => [
      { kind: 'text_delta', text: '.', channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ]);
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    await runEval(captureTask, runtime, { timeoutMs: 2_000 });
    await expect(readFile(path.join(captured, 'whatever'), 'utf8')).rejects.toThrow();
  });

  it('built-in registry exposes the bundled tasks by id', () => {
    expect(builtinTasks.map((t) => t.id).sort()).toEqual([
      'echo-greeting',
      'harness-spawn-verify',
      'harness-usage-aware',
      'self-verify-write',
      'write-file',
    ]);
    expect(getTask('echo-greeting')).toBeDefined();
    expect(getTask('does-not-exist')).toBeUndefined();
  });
});
