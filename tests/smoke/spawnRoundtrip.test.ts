import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';

/**
 * Smoke: parent spawns a child, child replies and completes, parent's
 * event log gets a subtask_complete routed by the SubagentPool.
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
    // Decide which side we're on by inspecting the first user message.
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

class RecordingProvider implements LlmProvider {
  readonly id: string;
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  readonly seenRequests: SamplingRequest[] = [];
  private idx = 0;

  constructor(id: string, private readonly script: SamplingDelta[][]) {
    this.id = id;
  }

  async *sample(request: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    this.seenRequests.push(request);
    const deltas = this.script[Math.min(this.idx++, this.script.length - 1)] ?? [];
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

describe('smoke: spawn round-trip', () => {
  it('parent spawns a child; parent sees subtask_complete', async () => {
    const provider = new ScriptedProvider(
      [
        // parent turn 1: spawn a child
        [
          { kind: 'tool_call_begin', toolCallId: 'tc_spawn' as never, name: 'spawn' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_spawn' as never,
            args: { task: '[child] do the thing', role: 'researcher', budget: {} },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
        // parent turn 2: reply and finish
        [
          { kind: 'text_delta', text: 'ack', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      ],
      [
        // child: one reply and done
        [
          { kind: 'text_delta', text: 'child done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      ],
    );

    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'please fork a child' },
    });
    runtime.bus.publish(seed);

    // Give both threads time to run.
    for (let i = 0; i < 50; i++) {
      await settle(40);
      const events = await runtime.store.readAll(runtime.rootThreadId);
      if (events.some((e) => e.kind === 'subtask_complete')) break;
    }

    const parentEvents = await runtime.store.readAll(runtime.rootThreadId);
    expect(parentEvents.some((e) => e.kind === 'spawn_request')).toBe(true);
    const spawnRequest = parentEvents.find((e) => e.kind === 'spawn_request');
    expect(spawnRequest).toBeDefined();
    const spawnPayload = spawnRequest!.payload as { childThreadId: string };
    const subtask = parentEvents.find((e) => e.kind === 'subtask_complete');
    expect(subtask).toBeDefined();
    const subPayload = subtask!.payload as {
      childThreadId: string;
      status: string;
      summary?: string;
    };
    const spawnToolResult = parentEvents.find(
      (e) =>
        e.kind === 'tool_result' &&
        typeof (e.payload as { output?: { childThreadId?: string } }).output?.childThreadId === 'string',
    );
    expect(spawnToolResult).toBeDefined();
    const spawnToolResultPayload = spawnToolResult!.payload as {
      output: { childThreadId: string };
    };
    expect(spawnPayload.childThreadId).toBe(subPayload.childThreadId);
    expect(spawnPayload.childThreadId).toBe(spawnToolResultPayload.output.childThreadId);
    expect(subPayload.status).toBe('completed');
    // SubagentPool routes based on the child's turn_complete summary.
    expect(subPayload.summary).toBe('child done');
  });

  it('injects runtime model metadata for root and alias-routed children', async () => {
    const parent = new RecordingProvider('parent', [
      [
        { kind: 'tool_call_begin', toolCallId: 'tc_spawn' as never, name: 'spawn' },
        {
          kind: 'tool_call_end',
          toolCallId: 'tc_spawn' as never,
          args: {
            task: 'child on deepseek',
            provider: 'deepseek',
            budget: {},
          },
        },
        { kind: 'end', stopReason: 'tool_use' },
      ],
      [
        { kind: 'text_delta', text: 'ack', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ],
    ]);
    const child = new RecordingProvider('child', [
      [
        { kind: 'text_delta', text: 'done', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ],
    ]);

    const runtime = await bootstrap({
      provider: parent,
      systemPrompt: 'sys',
      runtimeModelInfo: {
        alias: 'main',
        provider: 'openai',
        model: 'gpt-5.4',
        apiMode: 'responses',
      },
      providerFactories: { deepseek: () => child },
      providerFactoryModelInfo: {
        deepseek: {
          alias: 'deepseek',
          provider: 'openai',
          model: 'deepseek-chat',
          apiMode: 'chat_completions',
          baseURL: 'https://api.deepseek.com/v1',
        },
      },
    });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'please fork a child' },
    });
    runtime.bus.publish(seed);

    for (let i = 0; i < 50; i++) {
      await settle(40);
      const events = await runtime.store.readAll(runtime.rootThreadId);
      if (events.some((e) => e.kind === 'subtask_complete')) break;
    }

    expect(parent.seenRequests[0]?.prefix.systemPrompt).toContain('[runtime model]');
    expect(parent.seenRequests[0]?.prefix.systemPrompt).toContain('alias=main');
    expect(parent.seenRequests[0]?.prefix.systemPrompt).toContain('model=gpt-5.4');
    expect(child.seenRequests[0]?.prefix.systemPrompt).toContain('alias=deepseek');
    expect(child.seenRequests[0]?.prefix.systemPrompt).toContain('model=deepseek-chat');
    expect(child.seenRequests[0]?.prefix.systemPrompt).toContain('apiMode=chat_completions');
  });
});
