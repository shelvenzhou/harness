import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import type { ToolCallId } from '@harness/core/ids.js';

/**
 * Hard-wall token budget tests. The runtime must terminate the turn with
 * status='errored' and a tokens_exceeded summary when caps trip.
 *
 * Principle (design-docs/00-overview.md): the runtime enforces caps as
 * mechanism, not as advice. There must be no "soft" prompt injection
 * telling the model it's running low — the model just gets cut off at
 * the next sampling boundary.
 */

interface Step {
  deltas: SamplingDelta[];
  promptTokens: number;
  completionTokens: number;
}

class BudgetTestProvider implements LlmProvider {
  readonly id = 'budget-test';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  private i = 0;
  constructor(private readonly steps: Step[]) {}
  async *sample(_req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    const step = this.steps[Math.min(this.i, this.steps.length - 1)];
    this.i += 1;
    if (!step) return;
    for (const d of step.deltas) {
      if (signal.aborted) return;
      yield d;
    }
    yield {
      kind: 'usage',
      tokens: {
        promptTokens: step.promptTokens,
        cachedPromptTokens: 0,
        completionTokens: step.completionTokens,
      },
    };
    if (!step.deltas.some((d) => d.kind === 'end')) {
      yield { kind: 'end', stopReason: 'end_turn' };
    }
  }
}

async function runUntilTerminal(
  bus: import('@harness/bus/eventBus.js').EventBus,
  store: import('@harness/store/sessionStore.js').SessionStore,
  threadId: import('@harness/core/ids.js').ThreadId,
  text: string,
): Promise<{
  status: 'completed' | 'interrupted' | 'errored';
  summary?: string;
  samplingCount: number;
}> {
  let samplingCount = 0;
  const done = new Promise<{ status: 'completed' | 'interrupted' | 'errored'; summary?: string }>(
    (resolve) => {
      const sub = bus.subscribe(
        (ev) => {
          if (ev.kind === 'sampling_complete') samplingCount += 1;
          if (ev.kind === 'turn_complete') {
            sub.unsubscribe();
            resolve({
              status: ev.payload.status,
              ...(ev.payload.summary !== undefined ? { summary: ev.payload.summary } : {}),
            });
          }
        },
        { threadId },
      );
    },
  );

  const seed = await store.append({ threadId, kind: 'user_turn_start', payload: { text } });
  bus.publish(seed);

  const result = await Promise.race([
    done,
    new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('timeout')), 3_000)),
  ]);
  return { ...result, samplingCount };
}

describe('runtime: token budget hard-wall', () => {
  it('completes normally when no cap is configured', async () => {
    const provider = new BudgetTestProvider([
      {
        deltas: [
          { kind: 'text_delta', text: 'hi', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
        promptTokens: 1_000,
        completionTokens: 500,
      },
    ]);
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const result = await runUntilTerminal(
      runtime.bus,
      runtime.store,
      runtime.rootThreadId,
      'go',
    );
    expect(result.status).toBe('completed');
  });

  it('errors the turn when maxTurnTokens is exceeded after the first sampling', async () => {
    // First sampling forces a tool call (so we re-sample), already over the cap.
    // Second sampling boundary trips the cap before the request is built.
    const provider = new BudgetTestProvider([
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: 'tc_1' as ToolCallId, name: 'shell' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_1' as ToolCallId,
            args: { cmd: 'echo a' },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        promptTokens: 600,
        completionTokens: 600,
      },
      // This step must not run — the cap should fire first.
      {
        deltas: [
          { kind: 'text_delta', text: 'should-not-appear', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
        promptTokens: 100,
        completionTokens: 100,
      },
    ]);
    const runtime = await bootstrap({
      provider,
      systemPrompt: 'sys',
      tokenBudget: { maxTurnTokens: 1_000 },
    });
    const result = await runUntilTerminal(
      runtime.bus,
      runtime.store,
      runtime.rootThreadId,
      'go',
    );
    expect(result.status).toBe('errored');
    expect(result.summary).toMatch(/tokens_exceeded:turn/);
    // Only the first sampling ran; the cap stopped the second.
    expect(result.samplingCount).toBe(1);
    // The "should-not-appear" reply must not be in the store.
    const events = await runtime.store.readAll(runtime.rootThreadId);
    const replies = events
      .filter((e) => e.kind === 'reply')
      .map((e) => (e.payload as { text: string }).text)
      .join('');
    expect(replies).not.toContain('should-not-appear');
  });

  it('errors the turn when maxThreadTokens is exceeded across turns', async () => {
    const provider = new BudgetTestProvider([
      {
        deltas: [
          { kind: 'text_delta', text: 'first', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
        promptTokens: 500,
        completionTokens: 500,
      },
      // Second turn: the very first sampling should still run (cap is
      // checked BEFORE sampling, but at the start of turn 2 we have 1000
      // banked, so the check fires and we error out without sampling).
      {
        deltas: [
          { kind: 'text_delta', text: 'second', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
        promptTokens: 500,
        completionTokens: 500,
      },
    ]);
    const runtime = await bootstrap({
      provider,
      systemPrompt: 'sys',
      tokenBudget: { maxThreadTokens: 1_000 },
    });

    const first = await runUntilTerminal(
      runtime.bus,
      runtime.store,
      runtime.rootThreadId,
      'one',
    );
    expect(first.status).toBe('completed');

    const second = await runUntilTerminal(
      runtime.bus,
      runtime.store,
      runtime.rootThreadId,
      'two',
    );
    expect(second.status).toBe('errored');
    expect(second.summary).toMatch(/tokens_exceeded:thread/);
    expect(second.samplingCount).toBe(0); // cap fired before any sample.
  });

  it('resets per-turn counter at the start of each turn', async () => {
    const provider = new BudgetTestProvider([
      {
        deltas: [
          { kind: 'text_delta', text: 'one', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
        promptTokens: 600,
        completionTokens: 300,
      },
      {
        deltas: [
          { kind: 'text_delta', text: 'two', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
        promptTokens: 600,
        completionTokens: 300,
      },
    ]);
    const runtime = await bootstrap({
      provider,
      systemPrompt: 'sys',
      tokenBudget: { maxTurnTokens: 1_000 }, // 900 < 1000 each turn
    });

    const first = await runUntilTerminal(
      runtime.bus,
      runtime.store,
      runtime.rootThreadId,
      'one',
    );
    expect(first.status).toBe('completed');

    const second = await runUntilTerminal(
      runtime.bus,
      runtime.store,
      runtime.rootThreadId,
      'two',
    );
    expect(second.status).toBe('completed');
  });

  it('does not inject any soft warning into the prompt', async () => {
    // Verifies the principle: even when running close to the cap, the
    // model never sees the cap or its remaining budget. The runtime
    // mechanism stays out of the prompt.
    const seenPrompts: SamplingRequest[] = [];
    class SnoopProvider implements LlmProvider {
      readonly id = 'snoop';
      readonly capabilities: LlmCapabilities = {
        prefixCache: false,
        cacheEdits: false,
        nativeToolUse: true,
        nativeReasoning: false,
        maxContextTokens: 100_000,
      };
      async *sample(req: SamplingRequest): AsyncIterable<SamplingDelta> {
        seenPrompts.push(req);
        yield { kind: 'text_delta', text: 'ok', channel: 'reply' };
        yield {
          kind: 'usage',
          tokens: { promptTokens: 400, cachedPromptTokens: 0, completionTokens: 100 },
        };
        yield { kind: 'end', stopReason: 'end_turn' };
      }
    }
    const runtime = await bootstrap({
      provider: new SnoopProvider(),
      systemPrompt: 'sys',
      tokenBudget: { maxTurnTokens: 600, maxThreadTokens: 600 },
    });
    await runUntilTerminal(runtime.bus, runtime.store, runtime.rootThreadId, 'go');

    expect(seenPrompts.length).toBeGreaterThanOrEqual(1);
    // Assert no runtime-injected budget *advisory* leaked into the prompt.
    // We narrow to phrases that would only appear if the runtime were
    // pushing soft warnings; the word "budget" alone is too broad
    // (the spawn tool's spec legitimately uses "budget" for child caps).
    const full = JSON.stringify(seenPrompts);
    expect(full).not.toMatch(/tokens?\s+(used|remaining)/i);
    expect(full).not.toMatch(/approaching\s+(the\s+)?(token|budget)/i);
    expect(full).not.toMatch(/please\s+(consider|wrap|finish)/i);
    expect(full).not.toMatch(/tokens_exceeded/i);
  });
});
