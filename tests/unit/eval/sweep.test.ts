import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import type { ToolCallId } from '@harness/core/ids.js';

import { runSweep, formatSweepReport, type ModelEntry } from '../../eval/sweep.js';
import type { EvalTask } from '../../eval/types.js';

/**
 * Sweep mechanics — driven by scripted providers so we exercise the
 * cross-model loop without touching real LLMs. Live cross-model runs
 * happen via tests/eval/sweepCli.ts (manual invocation).
 */

interface ScriptedConfig {
  reactor: (req: SamplingRequest, i: number) => SamplingDelta[];
}

function makeScripted(cfg: ScriptedConfig): LlmProvider {
  let i = 0;
  const id = `scripted`;
  const capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  return {
    id,
    capabilities,
    async *sample(req: SamplingRequest, signal: AbortSignal) {
      const deltas = cfg.reactor(req, i++);
      for (const d of deltas) {
        if (signal.aborted) return;
        yield d;
      }
      if (!deltas.some((d) => d.kind === 'end')) {
        yield { kind: 'end', stopReason: 'end_turn' };
      }
    },
  };
}

const trivialPassTask: EvalTask = {
  id: 'trivial-pass',
  description: 'always pass',
  prompt: 'do anything',
  verify: () => ({ ok: true }),
};

const requireToolTask: EvalTask = {
  id: 'require-spawn',
  description: 'pass only if spawn was called',
  prompt: 'use spawn',
  verify(_ctx, observed) {
    return observed.toolCalls.some((t) => t.name === 'spawn')
      ? { ok: true }
      : { ok: false, reason: 'no spawn' };
  },
};

describe('eval/sweep', () => {
  it('runs every (task × model) cell and reports per-model totals', async () => {
    const modelA: ModelEntry = {
      label: 'naive-model',
      makeProvider: () =>
        makeScripted({
          reactor: () => [
            { kind: 'text_delta', text: 'naive', channel: 'reply' },
            {
              kind: 'usage',
              tokens: { promptTokens: 10, cachedPromptTokens: 0, completionTokens: 5 },
            },
            { kind: 'end', stopReason: 'end_turn' },
          ],
        }),
    };
    const modelB: ModelEntry = {
      label: 'spawning-model',
      makeProvider: () =>
        makeScripted({
          reactor: (_req, i) => {
            if (i === 0) {
              return [
                { kind: 'tool_call_begin', toolCallId: 'tc_s' as ToolCallId, name: 'spawn' },
                {
                  kind: 'tool_call_end',
                  toolCallId: 'tc_s' as ToolCallId,
                  args: { task: 'verify', budget: { maxTurns: 1 } },
                },
                { kind: 'end', stopReason: 'tool_use' },
              ];
            }
            return [
              { kind: 'text_delta', text: 'done', channel: 'reply' },
              { kind: 'end', stopReason: 'end_turn' },
            ];
          },
        }),
    };

    const result = await runSweep(
      [trivialPassTask, requireToolTask],
      [modelA, modelB],
      { systemPrompt: 'sys', perTaskTimeoutMs: 4_000 },
    );

    expect(result.cells).toHaveLength(4);

    // Naive model: passes trivial-pass, fails require-spawn.
    const naiveTrivial = result.cells.find(
      (c) => c.modelLabel === 'naive-model' && c.taskId === 'trivial-pass',
    );
    const naiveSpawn = result.cells.find(
      (c) => c.modelLabel === 'naive-model' && c.taskId === 'require-spawn',
    );
    expect(naiveTrivial?.status).toBe('pass');
    expect(naiveSpawn?.status).toBe('fail');
    expect(naiveSpawn?.toolNames).toEqual([]);

    // Spawning model: passes both, and require-spawn shows the spawn tool name.
    const spawnTrivial = result.cells.find(
      (c) => c.modelLabel === 'spawning-model' && c.taskId === 'trivial-pass',
    );
    const spawnSpawn = result.cells.find(
      (c) => c.modelLabel === 'spawning-model' && c.taskId === 'require-spawn',
    );
    expect(spawnTrivial?.status).toBe('pass');
    expect(spawnSpawn?.status).toBe('pass');
    expect(spawnSpawn?.toolNames).toContain('spawn');

    // Totals.
    expect(result.byModel['naive-model']).toMatchObject({ pass: 1, fail: 1 });
    expect(result.byModel['spawning-model']).toMatchObject({ pass: 2, fail: 0 });
  });

  it('accumulates token totals per model', async () => {
    const heavy: ModelEntry = {
      label: 'heavy',
      makeProvider: () =>
        makeScripted({
          reactor: () => [
            { kind: 'text_delta', text: 'x', channel: 'reply' },
            {
              kind: 'usage',
              tokens: { promptTokens: 1_000, cachedPromptTokens: 0, completionTokens: 500 },
            },
            { kind: 'end', stopReason: 'end_turn' },
          ],
        }),
    };
    const result = await runSweep([trivialPassTask, trivialPassTask], [heavy], {
      systemPrompt: 'sys',
      perTaskTimeoutMs: 2_000,
    });
    // Two tasks × 1500 tokens each = 2000 prompt + 1000 completion total.
    expect(result.byModel['heavy']?.totalPromptTokens).toBe(2_000);
    expect(result.byModel['heavy']?.totalCompletionTokens).toBe(1_000);
  });

  it('formats a sweep report as a markdown matrix + totals table', async () => {
    const m: ModelEntry = {
      label: 'm1',
      makeProvider: () =>
        makeScripted({
          reactor: () => [
            { kind: 'text_delta', text: 'ok', channel: 'reply' },
            { kind: 'end', stopReason: 'end_turn' },
          ],
        }),
    };
    const result = await runSweep([trivialPassTask], [m], {
      systemPrompt: 'sys',
      perTaskTimeoutMs: 2_000,
    });
    const report = formatSweepReport(result);
    expect(report).toContain('| model | trivial-pass |');
    expect(report).toContain('| m1 | ✓ |');
    expect(report).toMatch(/\| m1 \| 1 \| 0 \| 0 \| 0 \|/);
  });
});
