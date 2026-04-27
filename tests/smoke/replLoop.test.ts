import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { TerminalAdapter } from '@harness/adapters/terminal.js';

/**
 * Lightweight scripted provider — replaces the removed MockProvider for
 * tests. Kept inline because it exists only to exercise the event path.
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
  constructor(private readonly react: (req: SamplingRequest, i: number) => SamplingDelta[]) {}
  private i = 0;
  async *sample(request: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    const deltas = this.react(request, this.i++);
    for (const d of deltas) {
      if (signal.aborted) return;
      yield d;
    }
    if (!deltas.some((d) => d.kind === 'end')) yield { kind: 'end', stopReason: 'end_turn' };
  }
}

async function settle(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('smoke: terminal REPL end-to-end', () => {
  it('user text → runner → provider → reply reaches stdout', async () => {
    const provider = new ScriptedProvider((req) => {
      const last = req.tail[req.tail.length - 1];
      const text =
        last?.content.find((c): c is { kind: 'text'; text: string } => c.kind === 'text')
          ?.text ?? '';
      return [
        { kind: 'text_delta', text: `echo:${text}`, channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const input = new PassThrough();
    const output = new PassThrough();
    const captured: string[] = [];
    output.on('data', (b: Buffer) => captured.push(b.toString('utf8')));

    const adapter = new TerminalAdapter({ store: runtime.store, input, output });
    await adapter.start({
      bus: runtime.bus,
      threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
    });

    input.write('hello\n');
    await settle(150);

    expect(captured.join('')).toContain('echo:hello');
    await adapter.stop();
  });

  it('tool_call round-trip: model → shell stub → tool_result → next reply', async () => {
    const provider = new ScriptedProvider((_req, i) => {
      if (i === 0) {
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_1' as never, name: 'shell' },
          { kind: 'tool_call_end', toolCallId: 'tc_1' as never, args: { cmd: 'echo hi' } },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'done', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const input = new PassThrough();
    const output = new PassThrough();
    const captured: string[] = [];
    output.on('data', (b: Buffer) => captured.push(b.toString('utf8')));

    const adapter = new TerminalAdapter({ store: runtime.store, input, output });
    await adapter.start({
      bus: runtime.bus,
      threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
    });

    input.write('go\n');
    await settle(250);

    const all = await runtime.store.readAll(runtime.rootThreadId);
    expect(all.some((e) => e.kind === 'tool_call')).toBe(true);
    expect(all.some((e) => e.kind === 'tool_result')).toBe(true);
    expect(all.some((e) => e.kind === 'turn_complete')).toBe(true);
    expect(captured.join('')).toContain('done');
    await adapter.stop();
  });

  it('prints compaction events once micro-compaction runs', async () => {
    const provider = new ScriptedProvider((_req, i) => {
      if (i === 0) {
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_1' as never, name: 'shell' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_1' as never,
            args: { cmd: "printf '%0300d' 0" },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'done', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({
      provider,
      systemPrompt: 'sys',
      microCompact: { keepRecent: 0, triggerEvery: 1, minBytes: 32 },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const captured: string[] = [];
    output.on('data', (b: Buffer) => captured.push(b.toString('utf8')));

    const adapter = new TerminalAdapter({ store: runtime.store, input, output });
    await adapter.start({
      bus: runtime.bus,
      threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
    });

    input.write('go\n');
    await settle(300);

    expect(captured.join('')).toContain('[compacted reason=auto');
    expect(captured.join('')).toContain('done');
    await adapter.stop();
  });

  it('continues sampling after restore and can still reply', async () => {
    const provider = new ScriptedProvider((req, i) => {
      if (i === 0) {
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_1' as never, name: 'read' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_1' as never,
            args: { path: './README.md' },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      if (i === 1) {
        const elided = req.tail
          .flatMap((item) => item.content)
          .find((c) => c.kind === 'elided');
        const handle = elided && 'handle' in elided ? elided.handle : 'missing';
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_2' as never, name: 'restore' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_2' as never,
            args: { handle },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'done after restore', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });

    const input = new PassThrough();
    const output = new PassThrough();
    const captured: string[] = [];
    output.on('data', (b: Buffer) => captured.push(b.toString('utf8')));

    const adapter = new TerminalAdapter({ store: runtime.store, input, output });
    await adapter.start({
      bus: runtime.bus,
      threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
    });

    input.write('go\n');
    await settle(300);

    expect(captured.join('')).toContain('done after restore');
    expect(captured.join('')).not.toContain('model_stopped_without_final_reply');
    await adapter.stop();
  });

  it('wait suspends the turn and external_event resumes sampling', async () => {
    const provider = new ScriptedProvider((_req, i) => {
      if (i === 0) {
        return [
          { kind: 'tool_call_begin', toolCallId: 'tc_wait' as never, name: 'wait' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_wait' as never,
            args: { matcher: 'kind' },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ];
      }
      return [
        { kind: 'text_delta', text: 'awoken', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ];
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const input = new PassThrough();
    const output = new PassThrough();
    const captured: string[] = [];
    output.on('data', (b: Buffer) => captured.push(b.toString('utf8')));

    const adapter = new TerminalAdapter({ store: runtime.store, input, output });
    await adapter.start({
      bus: runtime.bus,
      threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
    });

    input.write('go\n');
    await settle(200);

    expect(captured.join('')).not.toContain('[turn errored');
    expect(captured.join('')).not.toContain('[turn completed');
    expect(captured.join('')).not.toContain('awoken');

    const { newEventId } = await import('@harness/core/ids.js');
    runtime.bus.publish({
      id: newEventId(),
      threadId: runtime.rootThreadId,
      kind: 'external_event',
      payload: { source: 'test', data: { wakeup: true } },
      createdAt: new Date().toISOString(),
    } as never);

    await settle(200);
    expect(captured.join('')).toContain('awoken');
    await adapter.stop();
  });

  it('prints a visible turn error when the model stops with tool_use but no tool call', async () => {
    const provider = new ScriptedProvider(() => [
      { kind: 'end', stopReason: 'tool_use' },
    ]);
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const input = new PassThrough();
    const output = new PassThrough();
    const captured: string[] = [];
    output.on('data', (b: Buffer) => captured.push(b.toString('utf8')));

    const adapter = new TerminalAdapter({ store: runtime.store, input, output });
    await adapter.start({
      bus: runtime.bus,
      threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
    });

    input.write('go\n');
    await settle(150);

    expect(captured.join('')).toContain('[turn errored: model_returned_tool_use_without_tool_calls]');
    await adapter.stop();
  });
});
