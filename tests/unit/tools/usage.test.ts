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
 * `usage` tool — pull-style accounting. The model asks; the runtime
 * answers with the live counters and any configured caps. Nothing the
 * runtime does is supposed to inject these numbers into the prompt
 * unprompted (see runtime/tokenBudget.test.ts for that invariant).
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

async function runTurn(
  bus: import('@harness/bus/eventBus.js').EventBus,
  store: import('@harness/store/sessionStore.js').SessionStore,
  threadId: import('@harness/core/ids.js').ThreadId,
  text: string,
): Promise<void> {
  await new Promise<void>(async (resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3_000);
    const sub = bus.subscribe(
      (ev) => {
        if (ev.kind === 'turn_complete') {
          sub.unsubscribe();
          clearTimeout(t);
          resolve();
        }
      },
      { threadId },
    );
    const seed = await store.append({ threadId, kind: 'user_turn_start', payload: { text } });
    bus.publish(seed);
  });
}

describe('tools: usage', () => {
  it('returns live token counters and configured caps', async () => {
    // First sampling: model calls `usage`.
    // Second sampling: model replies based on the (mocked) result.
    const provider = new ScriptedProvider((_req, i) => {
      if (i === 0) {
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_u' as ToolCallId, name: 'usage' },
          { kind: 'tool_call_end', toolCallId: 'tc_u' as ToolCallId, args: {} },
          {
            kind: 'usage',
            tokens: { promptTokens: 200, cachedPromptTokens: 0, completionTokens: 50 },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'done', channel: 'reply' },
        {
          kind: 'usage',
          tokens: { promptTokens: 100, cachedPromptTokens: 0, completionTokens: 30 },
        },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({
      provider,
      systemPrompt: 'sys',
      tokenBudget: { maxTurnTokens: 5_000, maxThreadTokens: 50_000 },
    });
    await runTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'go');

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const usageResult = events.find(
      (e) =>
        e.kind === 'tool_result' &&
        (e.payload as { toolCallId: string }).toolCallId === 'tc_u',
    );
    expect(usageResult).toBeDefined();
    const out = (usageResult!.payload as { ok: boolean; output: unknown }).output as {
      tokensThisTurn: number;
      tokensThisThread: number;
      samplingCount: number;
      caps: { maxTurnTokens?: number; maxThreadTokens?: number };
    };
    // After sampling #1 the runner has 250 tokens banked. The usage call
    // is intercepted *during* sampling #1's action dispatch — but the
    // accumulator is updated AFTER actions dispatch (right before
    // sampling_complete is emitted). So at the moment usage runs, the
    // counter still reflects the *previous* sampling's contribution
    // (zero on the first turn). This is the contract: usage reports
    // what's been *committed*, not the in-flight step.
    expect(out.tokensThisTurn).toBe(0);
    expect(out.tokensThisThread).toBe(0);
    expect(out.samplingCount).toBe(1); // current sampling index
    expect(out.caps.maxTurnTokens).toBe(5_000);
    expect(out.caps.maxThreadTokens).toBe(50_000);
  });

  it('reports empty caps when no token budget is configured', async () => {
    const provider = new ScriptedProvider((_req, i) => {
      if (i === 0) {
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_u' as ToolCallId, name: 'usage' },
          { kind: 'tool_call_end', toolCallId: 'tc_u' as ToolCallId, args: {} },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'done', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    await runTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'go');
    const events = await runtime.store.readAll(runtime.rootThreadId);
    const usageResult = events.find(
      (e) =>
        e.kind === 'tool_result' &&
        (e.payload as { toolCallId: string }).toolCallId === 'tc_u',
    );
    const out = (usageResult!.payload as { ok: boolean; output: unknown }).output as {
      caps: Record<string, unknown>;
    };
    expect(out.caps).toEqual({});
  });

  it('reflects accumulated tokens after a prior sampling on a later turn', async () => {
    // Two turns: turn 1 burns tokens via a real reply; turn 2 immediately
    // calls usage — by then the accumulator from turn 1 is committed and
    // contributes to thread counter (per-turn counter resets).
    const provider = new ScriptedProvider((_req, i) => {
      if (i === 0) {
        return [
          { kind: 'text_delta', text: 'first', channel: 'reply' },
          {
            kind: 'usage',
            tokens: { promptTokens: 700, cachedPromptTokens: 0, completionTokens: 300 },
          },
          { kind: 'end', stopReason: 'end_turn' },
        ];
      }
      if (i === 1) {
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_u' as ToolCallId, name: 'usage' },
          { kind: 'tool_call_end', toolCallId: 'tc_u' as ToolCallId, args: {} },
          {
            kind: 'usage',
            tokens: { promptTokens: 50, cachedPromptTokens: 0, completionTokens: 20 },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'done', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    await runTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'one');
    await runTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'two');

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const usageResult = events.find(
      (e) =>
        e.kind === 'tool_result' &&
        (e.payload as { toolCallId: string }).toolCallId === 'tc_u',
    );
    const out = (usageResult!.payload as { ok: boolean; output: unknown }).output as {
      tokensThisTurn: number;
      tokensThisThread: number;
    };
    // Turn 1 banked 1000 → thread total = 1000. Per-turn resets at the
    // start of turn 2 so tokensThisTurn is 0 at the moment of the call.
    expect(out.tokensThisTurn).toBe(0);
    expect(out.tokensThisThread).toBe(1_000);
  });

  it('default-execute path returns zeros for registry hygiene', async () => {
    // The tool's default execute() exists so the registry can hand it
    // out for tests / non-runner callers; in a real runner the path is
    // intercepted. Here we verify the default returns the documented
    // shape.
    const { usageTool } = await import('@harness/tools/impl/usage.js');
    const result = await usageTool.execute(
      {} as never,
      {} as never,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      tokensThisTurn: 0,
      tokensThisThread: 0,
      samplingCount: 0,
      caps: {},
    });
  });
});
