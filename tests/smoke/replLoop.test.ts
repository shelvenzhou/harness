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
});
