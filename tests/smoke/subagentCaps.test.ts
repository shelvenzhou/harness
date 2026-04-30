import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';

/**
 * Step 4 contract: SubagentPool must reject `spawn` calls that violate
 * structural caps with a `tool_result.ok=false`, and must trip
 * `maxTokens` budgets like the existing wall/turn/toolCall caps.
 *
 * Two scenarios:
 *   1. maxConcurrentTotal=0 => parent's first spawn fails fast; the
 *      LLM gets a tool error and finishes the turn with a reply.
 *   2. child given maxTokens budget that's too small => child runs one
 *      sampling step, accumulates >cap tokens, pool trips the budget,
 *      parent observes subtask_complete{budget_exceeded, reason=budget:maxTokens}.
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
    private readonly childScript: SamplingDelta[][] = [],
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

describe('smoke: subagent structural caps', () => {
  it('rejects spawn when maxConcurrentTotal would be exceeded; LLM sees the tool error', async () => {
    const provider = new ScriptedProvider([
      // parent turn 1: spawn — should be refused by the pool.
      [
        { kind: 'tool_call_begin', toolCallId: 'tc_spawn' as never, name: 'spawn' },
        {
          kind: 'tool_call_end',
          toolCallId: 'tc_spawn' as never,
          args: { task: '[child] anything', role: 'r', budget: {} },
        },
        { kind: 'end', stopReason: 'tool_use' },
      ],
      // parent turn 2: after seeing the rejection, finish with a reply.
      [
        { kind: 'text_delta', text: 'gave up', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ],
    ]);

    const runtime = await bootstrap({
      provider,
      systemPrompt: 'sys',
      microCompact: false,
      // 0 means no children allowed at all — first spawn refuses.
      subagentMaxConcurrentTotal: 0,
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'fork' },
    });
    runtime.bus.publish(seed);

    for (let i = 0; i < 80; i++) {
      await settle(20);
      const events = await runtime.store.readAll(runtime.rootThreadId);
      if (events.some((e) => e.kind === 'turn_complete')) break;
    }

    const events = await runtime.store.readAll(runtime.rootThreadId);
    // Parent never sees a subtask_complete because no child was created.
    expect(events.some((e) => e.kind === 'subtask_complete')).toBe(false);
    // The spawn tool_result must be ok=false with a typed error.
    const tr = events.find(
      (e) => e.kind === 'tool_result' && (e.payload as { toolCallId: string }).toolCallId === 'tc_spawn',
    );
    expect(tr).toBeDefined();
    const trPayload = tr!.payload as {
      ok: boolean;
      error?: { kind: string; message: string };
    };
    expect(trPayload.ok).toBe(false);
    expect(trPayload.error?.kind).toBe('maxConcurrentTotal');
    // Parent finished cleanly after seeing the refusal.
    const tc = events.find((e) => e.kind === 'turn_complete');
    expect(tc).toBeDefined();
    expect((tc!.payload as { status: string }).status).toBe('completed');
  }, 10_000);

  it('child that exceeds maxTokens is interrupted; parent sees budget_exceeded', async () => {
    const provider = new ScriptedProvider(
      [
        // parent: spawn a child with a tiny token budget.
        [
          { kind: 'tool_call_begin', toolCallId: 'tc_spawn' as never, name: 'spawn' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_spawn' as never,
            args: {
              task: '[child] keep chatting',
              role: 'researcher',
              budget: { maxTokens: 50 },
            },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        [
          { kind: 'text_delta', text: 'ok', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      ],
      [
        // child turn 1: emits usage that already busts the 50-token cap.
        [
          { kind: 'text_delta', text: 'hello', channel: 'reply' },
          {
            kind: 'usage',
            tokens: { promptTokens: 100, cachedPromptTokens: 0, completionTokens: 50 },
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
      await settle(20);
      const events = await runtime.store.readAll(runtime.rootThreadId);
      if (events.some((e) => e.kind === 'subtask_complete')) break;
    }

    const parentEvents = await runtime.store.readAll(runtime.rootThreadId);
    const subtask = parentEvents.find((e) => e.kind === 'subtask_complete');
    expect(subtask).toBeDefined();
    const p = subtask!.payload as {
      status: string;
      summary?: string;
      reason?: string;
      budget?: { reason: string };
    };
    expect(p.status).toBe('budget_exceeded');
    expect(p.summary).toBe('hello');
    expect(p.reason).toBe('budget:maxTokens');
    expect(p.budget?.reason).toBe('maxTokens');
  }, 10_000);
});
