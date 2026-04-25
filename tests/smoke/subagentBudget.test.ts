import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';

/**
 * SubagentPool: when a child exceeds its `maxToolCalls` budget, the pool
 * interrupts it and the parent receives subtask_complete{status:
 * 'budget_exceeded'} rather than a normal completion.
 *
 * Setup:
 *   - parent spawns one child with maxToolCalls=1
 *   - child issues two shell tool calls in a row (exceeds cap on the 2nd)
 *   - assert: subtask_complete arrives with status 'budget_exceeded'
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
  private parentIdx = 0;
  private childIdx = 0;
  constructor(
    private readonly parentScript: SamplingDelta[][],
    private readonly childScript: SamplingDelta[][],
  ) {}

  async *sample(request: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    const firstUser = request.tail.find((i) => i.role === 'user');
    const text =
      firstUser?.content.find((c): c is { kind: 'text'; text: string } => c.kind === 'text')
        ?.text ?? '';
    const isChild = /^\[child\]/.test(text);
    const script = isChild ? this.childScript : this.parentScript;
    const idx = isChild ? this.childIdx++ : this.parentIdx++;
    const deltas = script[Math.min(idx, script.length - 1)] ?? [];
    for (const d of deltas) {
      if (signal.aborted) return;
      yield d;
    }
    if (!deltas.some((d) => d.kind === 'end')) yield { kind: 'end', stopReason: 'end_turn' };
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('smoke: subagent budgets', () => {
  it('child that exceeds maxToolCalls is interrupted; parent sees budget_exceeded', async () => {
    const provider = new ScriptedProvider(
      [
        // parent turn 1: spawn a child with tight budget
        [
          { kind: 'tool_call_begin', toolCallId: 'tc_spawn' as never, name: 'spawn' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_spawn' as never,
            args: {
              task: '[child] burn budget',
              role: 'researcher',
              budget: { maxToolCalls: 1 },
            },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        // parent turn 2: ack and finish
        [
          { kind: 'text_delta', text: 'ack', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      ],
      [
        // child turn 1: shell call #1 (within budget)
        [
          { kind: 'tool_call_begin', toolCallId: 'tc_c1' as never, name: 'shell' },
          { kind: 'tool_call_end', toolCallId: 'tc_c1' as never, args: { cmd: 'echo a' } },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        // child turn 2: shell call #2 (over budget — pool interrupts before result lands)
        [
          { kind: 'tool_call_begin', toolCallId: 'tc_c2' as never, name: 'shell' },
          { kind: 'tool_call_end', toolCallId: 'tc_c2' as never, args: { cmd: 'echo b' } },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        // fallback
        [{ kind: 'text_delta', text: 'done', channel: 'reply' }, { kind: 'end', stopReason: 'end_turn' }],
      ],
    );

    const runtime = await bootstrap({
      provider,
      systemPrompt: 'sys',
      microCompact: false,
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'fork' },
    });
    runtime.bus.publish(seed);

    for (let i = 0; i < 80; i++) {
      await settle(40);
      const events = await runtime.store.readAll(runtime.rootThreadId);
      if (events.some((e) => e.kind === 'subtask_complete')) break;
    }

    const parentEvents = await runtime.store.readAll(runtime.rootThreadId);
    const subtask = parentEvents.find((e) => e.kind === 'subtask_complete');
    expect(subtask).toBeDefined();
    const p = subtask!.payload as { status: string; summary?: string };
    expect(p.status).toBe('budget_exceeded');
    expect(p.summary).toContain('maxToolCalls');
  }, 10_000);
});
