import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { runEval } from '../../eval/index.js';
import { selfVerifyWriteTask } from '../../eval/tasks/selfVerifyWrite.js';
import { usageAwareTask } from '../../eval/tasks/usageAware.js';
import { spawnVerifyTask } from '../../eval/tasks/spawnVerify.js';
import type { ToolCallId } from '@harness/core/ids.js';

/**
 * Verifier-shape tests for the agentic-awareness tasks. We script
 * providers that exhibit the "naive" and "self-checking" patterns and
 * assert the verifier scores them correctly. No live LLM here; these
 * lock in the verifier semantics so prompt changes can't accidentally
 * make the bar trivial.
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

function extractWorkdirPath(req: SamplingRequest): string {
  const lastUser = [...req.tail].reverse().find((m) => m.role === 'user');
  const text =
    lastUser?.content
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text)
      .join('\n') ?? '';
  const m = text.match(/(\/[^\s]+\.txt)/);
  return m?.[1] ?? '';
}

describe('eval/tasks: agentic-awareness verifiers', () => {
  describe('self-verify-write', () => {
    it('FAILS when agent writes correctly but does not read back', async () => {
      let capturedPath = '';
      const provider = new ScriptedProvider((req, i) => {
        if (i === 0) {
          capturedPath = extractWorkdirPath(req);
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_w' as ToolCallId, name: 'write' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_w' as ToolCallId,
              args: { path: capturedPath, content: 'blueberry', mode: 'overwrite' },
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
      const result = await runEval(selfVerifyWriteTask, runtime, { timeoutMs: 4_000 });
      expect(result.status).toBe('fail');
      expect(result.reason).toMatch(/did not self-verify/);
    });

    it('PASSES when agent writes then reads back', async () => {
      let capturedPath = '';
      const provider = new ScriptedProvider((req, i) => {
        if (i === 0) {
          capturedPath = extractWorkdirPath(req);
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_w' as ToolCallId, name: 'write' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_w' as ToolCallId,
              args: { path: capturedPath, content: 'blueberry', mode: 'overwrite' },
            },
            { kind: 'end', stopReason: 'tool_use' },
          ];
        }
        if (i === 1) {
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_r' as ToolCallId, name: 'read' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_r' as ToolCallId,
              args: { path: capturedPath },
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
      const result = await runEval(selfVerifyWriteTask, runtime, { timeoutMs: 5_000 });
      expect(result.status).toBe('pass');
      expect(result.observed.toolCalls.map((t) => t.name)).toEqual(['write', 'read']);
    });

    it('PASSES when agent writes then shell-cats the file', async () => {
      let capturedPath = '';
      const provider = new ScriptedProvider((req, i) => {
        if (i === 0) {
          capturedPath = extractWorkdirPath(req);
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_w' as ToolCallId, name: 'write' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_w' as ToolCallId,
              args: { path: capturedPath, content: 'blueberry', mode: 'overwrite' },
            },
            { kind: 'end', stopReason: 'tool_use' },
          ];
        }
        if (i === 1) {
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_s' as ToolCallId, name: 'shell' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_s' as ToolCallId,
              args: { cmd: `cat ${capturedPath}` },
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
      const result = await runEval(selfVerifyWriteTask, runtime, { timeoutMs: 6_000 });
      expect(result.status).toBe('pass');
    });

    it('FAILS when contents are wrong even if a read happened', async () => {
      let capturedPath = '';
      const provider = new ScriptedProvider((req, i) => {
        if (i === 0) {
          capturedPath = extractWorkdirPath(req);
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_w' as ToolCallId, name: 'write' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_w' as ToolCallId,
              args: { path: capturedPath, content: 'banana', mode: 'overwrite' }, // wrong word
            },
            { kind: 'end', stopReason: 'tool_use' },
          ];
        }
        if (i === 1) {
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_r' as ToolCallId, name: 'read' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_r' as ToolCallId,
              args: { path: capturedPath },
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
      const result = await runEval(selfVerifyWriteTask, runtime, { timeoutMs: 5_000 });
      expect(result.status).toBe('fail');
      expect(result.reason).toMatch(/unexpected contents/);
    });
  });

  describe('harness-usage-aware', () => {
    it('FAILS when the agent never calls `usage`', async () => {
      const provider = new ScriptedProvider(() => [
        { kind: 'text_delta', text: 'fail-modes…\nDONE', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ]);
      const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
      const result = await runEval(usageAwareTask, runtime, { timeoutMs: 4_000 });
      expect(result.status).toBe('fail');
      expect(result.reason).toMatch(/did not call `usage`/);
    });

    it('PASSES when the agent calls `usage` then replies', async () => {
      const provider = new ScriptedProvider((_req, i) => {
        if (i === 0) {
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_u' as ToolCallId, name: 'usage' },
            { kind: 'tool_call_end', toolCallId: 'tc_u' as ToolCallId, args: {} },
            { kind: 'end', stopReason: 'tool_use' },
          ];
        }
        return [
          { kind: 'text_delta', text: 'fail-modes…\nDONE', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ];
      });
      const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
      const result = await runEval(usageAwareTask, runtime, { timeoutMs: 5_000 });
      expect(result.status).toBe('pass');
    });
  });

  describe('harness-spawn-verify', () => {
    it('FAILS when the agent verifies inline (no spawn)', async () => {
      const provider = new ScriptedProvider(() => [
        { kind: 'text_delta', text: '17*23 = 391. Verified by hand. DONE', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ]);
      const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
      const result = await runEval(spawnVerifyTask, runtime, { timeoutMs: 4_000 });
      expect(result.status).toBe('fail');
      expect(result.reason).toMatch(/did not delegate/);
    });

    it('PASSES when the agent spawns a subagent', async () => {
      const provider = new ScriptedProvider((_req, i) => {
        if (i === 0) {
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_sp' as ToolCallId, name: 'spawn' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_sp' as ToolCallId,
              args: { task: 'Verify 17*23 = 391', role: 'verifier', budget: { maxTurns: 1 } },
            },
            { kind: 'end', stopReason: 'tool_use' },
          ];
        }
        // Subagent's spawn returns a child id; parent doesn't need to wait
        // for subtask_complete for the verifier to check spawn was called.
        return [
          { kind: 'text_delta', text: '391', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ];
      });
      const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
      const result = await runEval(spawnVerifyTask, runtime, { timeoutMs: 5_000 });
      expect(result.status).toBe('pass');
      expect(result.observed.toolCalls.find((t) => t.name === 'spawn')).toBeDefined();
    });
  });
});
