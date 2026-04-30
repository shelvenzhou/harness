import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { newToolCallId } from '@harness/core/ids.js';
import { ToolRegistry } from '@harness/tools/registry.js';
import { sessionTool, waitTool } from '@harness/tools/impl/index.js';
import type { Tool } from '@harness/tools/tool.js';

const FakeSchema = z.object({});

/**
 * Drive the runner through the full session lifecycle:
 *   1. Dispatch an async tool — agent gets back `{sessionId, status:'running'}`.
 *   2. wait({matcher:'session', sessionIds:[sid]}) — runner suspends.
 *   3. Session completes — wait wakes.
 *   4. session(sessionId) — agent reads the captured output, sees truncation flags.
 */

interface Step {
  deltas: SamplingDelta[];
}

class ScriptedProvider implements LlmProvider {
  readonly id = 'session-test-provider';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  public readonly steps: Step[];
  public readonly seenRequests: SamplingRequest[] = [];
  private i = 0;
  constructor(steps: Step[]) {
    this.steps = steps;
  }
  async *sample(req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    this.seenRequests.push(req);
    const idx = this.i++;
    const step = this.steps[Math.min(idx, this.steps.length - 1)]!;
    for (const d of step.deltas) {
      if (signal.aborted) return;
      yield d;
    }
    if (!step.deltas.some((d) => d.kind === 'end')) yield { kind: 'end', stopReason: 'end_turn' };
  }
}

/**
 * A test-only async tool whose body resolves on a controlled promise.
 * Lets the test pin the *moment* the session completes, so assertions
 * about wait-suspension and wake-up are deterministic.
 */
function makeFakeAsyncTool(payload: { release: Promise<unknown> }): Tool {
  return {
    name: 'fake_async',
    concurrency: 'safe',
    async: true,
    description: 'test-only async tool',
    schema: FakeSchema,
    async execute() {
      const out = await payload.release;
      return { ok: true, output: out };
    },
  };
}

describe('runtime: session tool + wait(session)', () => {
  it('wait wakes on session_complete and session() returns truncated output', async () => {
    let resolveSession: (v: unknown) => void = () => {};
    const release = new Promise<unknown>((r) => {
      resolveSession = r;
    });

    // Capture sessionId observed in turn-1 sampling 2 to feed into turn-2.
    let observedSessionId = '';

    const fetchToolCallId = 'tc_fake' as ReturnType<typeof newToolCallId>;
    const waitToolCallId = 'tc_wait' as ReturnType<typeof newToolCallId>;
    const sessToolCallId = 'tc_sess' as ReturnType<typeof newToolCallId>;

    const provider = new ScriptedProvider([
      // Sampling 1: dispatch the fake async tool.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: fetchToolCallId, name: 'fake_async' },
          { kind: 'tool_call_end', toolCallId: fetchToolCallId, args: {} },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Sampling 2: read the running session-id back out of the projection
      // and emit a wait(session) on it. We don't actually need to read
      // it from the prompt — the runner's tool_result event carries it,
      // and we'll ask the test driver to harvest it before this sampling
      // is pulled.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: waitToolCallId, name: 'wait' },
          {
            kind: 'tool_call_end',
            toolCallId: waitToolCallId,
            // sessionIds will be patched below before this sampling fires.
            args: { matcher: 'session', sessionIds: ['__placeholder__'] },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Sampling 3: session woke us up. Read it.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: sessToolCallId, name: 'session' },
          {
            kind: 'tool_call_end',
            toolCallId: sessToolCallId,
            args: { sessionId: '__placeholder__', maxTokens: 4 },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Sampling 4: reply final.
      {
        deltas: [
          { kind: 'text_delta', text: 'all done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      },
    ]);

    const registry = new ToolRegistry();
    registry.register(makeFakeAsyncTool({ release }));
    registry.register(waitTool);
    registry.register(sessionTool);

    const runtime = await bootstrap({ provider, systemPrompt: 'sys', registry });

    // Watch the bus for the session id (so we can patch the wait/session
    // sampling args once dispatch has happened).
    runtime.bus.subscribe(
      (ev) => {
        if (
          ev.kind === 'tool_result' &&
          (ev.payload as { toolCallId: string }).toolCallId === fetchToolCallId
        ) {
          const out = (ev.payload as { output?: { sessionId?: string } }).output;
          if (out?.sessionId) {
            observedSessionId = out.sessionId;
            // Patch sampling 2 + 3 args.
            const waitDelta = provider.steps[1]!.deltas.find(
              (d) => d.kind === 'tool_call_end',
            ) as Extract<SamplingDelta, { kind: 'tool_call_end' }>;
            (waitDelta.args as { sessionIds: string[] }).sessionIds = [observedSessionId];
            const sessDelta = provider.steps[2]!.deltas.find(
              (d) => d.kind === 'tool_call_end',
            ) as Extract<SamplingDelta, { kind: 'tool_call_end' }>;
            (sessDelta.args as { sessionId: string }).sessionId = observedSessionId;
          }
        }
      },
      { threadId: runtime.rootThreadId },
    );

    // Resolve the session AFTER the wait is in place. We wait for
    // sampling 2 (the wait dispatch) to have happened by polling
    // seenRequests length.
    void (async () => {
      while (provider.seenRequests.length < 2) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // Give the wait a beat to actually suspend.
      await new Promise((r) => setTimeout(r, 30));
      resolveSession('hello-output-12345'); // > 4 tokens worth of bytes
    })();

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    runtime.bus.publish(seed);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3_000);
      const sub = runtime.bus.subscribe(
        (ev) => {
          if (ev.kind === 'turn_complete') {
            clearTimeout(t);
            sub.unsubscribe();
            resolve();
          }
        },
        { threadId: runtime.rootThreadId },
      );
    });

    expect(observedSessionId).not.toBe('');

    const events = await runtime.store.readAll(runtime.rootThreadId);

    // session_complete event landed for our session id.
    const sessComplete = events.find(
      (e) =>
        e.kind === 'session_complete' &&
        (e.payload as { sessionId: string }).sessionId === observedSessionId,
    );
    expect(sessComplete).toBeDefined();
    expect((sessComplete!.payload as { ok: boolean }).ok).toBe(true);

    // Sampling 4 ran (= reply 'all done'), proving the wait actually woke.
    expect(provider.seenRequests.length).toBeGreaterThanOrEqual(4);

    // The session tool's tool_result reflects truncation: maxTokens=4 →
    // cap=16 bytes. Our output 'hello-output-12345' is 18 bytes → truncated.
    const sessRes = events.find(
      (e) => e.kind === 'tool_result' &&
        (e.payload as { toolCallId: string }).toolCallId === sessToolCallId,
    );
    expect(sessRes).toBeDefined();
    const sessOut = (sessRes!.payload as {
      output: {
        status: string;
        output: string;
        totalTokens: number;
        truncated: boolean;
        maxTokens: number;
      };
    }).output;
    expect(sessOut.status).toBe('done');
    expect(sessOut.maxTokens).toBe(4);
    expect(sessOut.truncated).toBe(true);
    expect(sessOut.output.length).toBeLessThanOrEqual(16);
    expect(sessOut.totalTokens).toBeGreaterThan(4);
  });

  it('wait(session, mode:"all") wakes only after every listed session completes', async () => {
    let releaseA: (v: unknown) => void = () => {};
    let releaseB: (v: unknown) => void = () => {};
    const promiseA = new Promise<unknown>((r) => {
      releaseA = r;
    });
    const promiseB = new Promise<unknown>((r) => {
      releaseB = r;
    });

    const tcA = 'tc_a' as ReturnType<typeof newToolCallId>;
    const tcB = 'tc_b' as ReturnType<typeof newToolCallId>;
    const tcWait = 'tc_w' as ReturnType<typeof newToolCallId>;

    const provider = new ScriptedProvider([
      // Step 1: dispatch both async tools.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: tcA, name: 'fake_async' },
          { kind: 'tool_call_end', toolCallId: tcA, args: {} },
          { kind: 'tool_call_begin', toolCallId: tcB, name: 'fake_async' },
          { kind: 'tool_call_end', toolCallId: tcB, args: {} },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Step 2: wait on both with mode:'all'. sessionIds patched live.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: tcWait, name: 'wait' },
          {
            kind: 'tool_call_end',
            toolCallId: tcWait,
            args: { matcher: 'session', sessionIds: ['__a__', '__b__'], mode: 'all' },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Step 3: reply.
      {
        deltas: [
          { kind: 'text_delta', text: 'both done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      },
    ]);

    let sidA = '';
    let sidB = '';

    const registry = new ToolRegistry();
    // We register one tool name shared by both calls — the runner makes
    // a fresh session per dispatch. Use two release promises that the
    // test resolves on demand.
    registry.register({
      name: 'fake_async',
      concurrency: 'safe',
      async: true,
      description: 'test',
      schema: FakeSchema,
      async execute(_args, ctx) {
        // Use the toolCallId to pick which release to wait on.
        if (ctx.toolCallId === tcA) return { ok: true, output: await promiseA };
        return { ok: true, output: await promiseB };
      },
    });
    registry.register(waitTool);
    registry.register(sessionTool);

    const runtime = await bootstrap({ provider, systemPrompt: 'sys', registry });

    runtime.bus.subscribe(
      (ev) => {
        if (ev.kind !== 'tool_result') return;
        const tcId = (ev.payload as { toolCallId: string }).toolCallId;
        const out = (ev.payload as { output?: { sessionId?: string } }).output;
        if (!out?.sessionId) return;
        if (tcId === tcA) sidA = out.sessionId;
        if (tcId === tcB) sidB = out.sessionId;
        if (sidA && sidB) {
          const waitDelta = provider.steps[1]!.deltas.find(
            (d) => d.kind === 'tool_call_end',
          ) as Extract<SamplingDelta, { kind: 'tool_call_end' }>;
          (waitDelta.args as { sessionIds: string[] }).sessionIds = [sidA, sidB];
        }
      },
      { threadId: runtime.rootThreadId },
    );

    // After step 2 (wait) is in place, fire only A. Sampling 3 must NOT
    // run yet — the wait is still gated on B.
    void (async () => {
      while (provider.seenRequests.length < 2) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));
      releaseA('a-output');
      // Give the runner a fair window to (incorrectly) wake on A only.
      await new Promise((r) => setTimeout(r, 100));
      // At this point, sampling 3 still must not have happened.
      expect(provider.seenRequests.length).toBe(2);
      releaseB('b-output');
    })();

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    runtime.bus.publish(seed);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3_000);
      const sub = runtime.bus.subscribe(
        (ev) => {
          if (ev.kind === 'turn_complete') {
            clearTimeout(t);
            sub.unsubscribe();
            resolve();
          }
        },
        { threadId: runtime.rootThreadId },
      );
    });

    // Both session_completes landed.
    const events = await runtime.store.readAll(runtime.rootThreadId);
    const completes = events.filter((e) => e.kind === 'session_complete');
    expect(completes.length).toBe(2);
    // Sampling 3 ran exactly once (after both completed).
    expect(provider.seenRequests.length).toBe(3);
  });
});
