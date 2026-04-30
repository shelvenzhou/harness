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
    private readonly seenRequests: SamplingRequest[] = [],
  ) {}

  async *sample(request: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    this.seenRequests.push(request);
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
  it('child that exceeds maxTokens preserves its reply and reports budget metadata', async () => {
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
              budget: { maxTokens: 1 },
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
        [
          { kind: 'text_delta', text: 'partial conclusion', channel: 'reply' },
          {
            kind: 'usage',
            tokens: { promptTokens: 20, cachedPromptTokens: 0, completionTokens: 10 },
          },
          { kind: 'end', stopReason: 'end_turn' },
        ],
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
    const spawnRequest = parentEvents.find((e) => e.kind === 'spawn_request');
    expect(spawnRequest).toBeDefined();
    const childThreadId = (spawnRequest!.payload as { childThreadId: string }).childThreadId;
    const subtask = parentEvents.find((e) => e.kind === 'subtask_complete');
    expect(subtask).toBeDefined();
    const p = subtask!.payload as {
      status: string;
      summary?: string;
      reason?: string;
      budget?: { reason: string; turnsUsed: number; toolCallsUsed: number; tokensUsed: number };
    };
    expect(p.status).toBe('budget_exceeded');
    expect(p.summary).toBe('partial conclusion');
    expect(p.reason).toBe('budget:maxTokens');
    expect(p.budget).toMatchObject({
      reason: 'maxTokens',
      turnsUsed: 1,
      toolCallsUsed: 0,
    });
    expect(p.budget?.tokensUsed).toBeGreaterThan(0);

    const childEvents = await runtime.store.readAll(childThreadId as never);
    const childTurnComplete = childEvents.find((e) => e.kind === 'turn_complete');
    expect(childTurnComplete).toBeDefined();
    expect(childTurnComplete!.payload).toMatchObject({
      status: 'interrupted',
      summary: 'partial conclusion',
      reason: 'budget:maxTokens',
    });
  }, 10_000);

  it('child sees budget guidance in the prompt and usage reports live remaining budget', async () => {
    const seenRequests: SamplingRequest[] = [];
    const provider = new ScriptedProvider(
      [
        [
          { kind: 'tool_call_begin', toolCallId: 'tc_spawn' as never, name: 'spawn' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_spawn' as never,
            args: {
              task: '[child] inspect budget',
              role: 'reviewer',
              budget: { maxTurns: 3, maxToolCalls: 4, maxWallMs: 5_000, maxTokens: 500 },
            },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        [
          { kind: 'text_delta', text: 'ack', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      ],
      [
        [
          { kind: 'tool_call_begin', toolCallId: 'tc_u' as never, name: 'usage' },
          { kind: 'tool_call_end', toolCallId: 'tc_u' as never, args: {} },
          {
            kind: 'usage',
            tokens: { promptTokens: 50, cachedPromptTokens: 0, completionTokens: 10 },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        [
          { kind: 'text_delta', text: 'done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      ],
      seenRequests,
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
    const spawnRequest = parentEvents.find((e) => e.kind === 'spawn_request');
    expect(spawnRequest).toBeDefined();
    const childThreadId = (spawnRequest!.payload as { childThreadId: string }).childThreadId;
    const childRequest = seenRequests.find((request) => {
      const firstUser = request.tail.find((item) => item.role === 'user');
      return firstUser?.content.some(
        (content) => content.kind === 'text' && content.text.includes('[child] inspect budget'),
      );
    });
    expect(childRequest?.prefix.systemPrompt).toContain('[subagent budget]');
    expect(childRequest?.prefix.systemPrompt).toContain('maxTurns=3');
    expect(childRequest?.prefix.systemPrompt).toContain('maxToolCalls=4');
    expect(childRequest?.prefix.systemPrompt).toContain('maxWallMs=5000');
    expect(childRequest?.prefix.systemPrompt).toContain('maxTokens=500');

    const childEvents = await runtime.store.readAll(childThreadId as never);
    const usageResult = childEvents.find(
      (event) =>
        event.kind === 'tool_result' &&
        (event.payload as { toolCallId?: string }).toolCallId === 'tc_u',
    );
    expect(usageResult).toBeDefined();
    const out = (usageResult!.payload as { output: unknown }).output as {
      subagentBudget?: {
        caps: { maxTurns?: number; maxToolCalls?: number; maxWallMs?: number; maxTokens?: number };
        used: { turns: number; toolCalls: number; wallMs: number; tokens: number };
        remaining: { turns?: number; toolCalls?: number; wallMs?: number; tokens?: number };
      };
    };
    expect(out.subagentBudget?.caps).toEqual({
      maxTurns: 3,
      maxToolCalls: 4,
      maxWallMs: 5_000,
      maxTokens: 500,
    });
    expect(out.subagentBudget?.used.turns).toBe(0);
    expect(out.subagentBudget?.used.toolCalls).toBe(1);
    expect(out.subagentBudget?.remaining.turns).toBe(3);
    expect(out.subagentBudget?.remaining.toolCalls).toBe(3);
    expect(out.subagentBudget?.remaining.tokens).toBe(500);
  }, 10_000);
});
