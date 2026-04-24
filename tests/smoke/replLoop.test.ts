import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';

import { MockProvider } from '@harness/llm/mockProvider.js';
import type { SamplingDelta } from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { TerminalAdapter } from '@harness/adapters/terminal.js';

async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('smoke: terminal REPL end-to-end', () => {
  it('user text → runner → mock provider → reply reaches stdout', async () => {
    const provider = new MockProvider({
      react: (req): SamplingDelta[] => {
        const last = req.tail[req.tail.length - 1];
        const text =
          last?.content.find((c): c is { kind: 'text'; text: string } => c.kind === 'text')
            ?.text ?? '';
        return [
          { kind: 'text_delta', text: `echo:${text}`, channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ];
      },
    });

    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const input = new PassThrough();
    const output = new PassThrough();
    const captured: string[] = [];
    output.on('data', (b: Buffer) => captured.push(b.toString('utf8')));

    const adapter = new TerminalAdapter({
      store: runtime.store,
      input,
      output,
    });
    await adapter.start({
      bus: runtime.bus,
      threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
    });

    input.write('hello\n');
    await settle(100);

    const joined = captured.join('');
    expect(joined).toContain('echo:hello');
    await adapter.stop();
  });

  it('tool_call round-trip: model → shell stub → tool_result → next reply', async () => {
    let call = 0;
    const provider = new MockProvider({
      react: (): SamplingDelta[] => {
        call += 1;
        if (call === 1) {
          return [
            { kind: 'tool_call_begin', toolCallId: 'tc_1' as never, name: 'shell' },
            {
              kind: 'tool_call_end',
              toolCallId: 'tc_1' as never,
              args: { cmd: 'echo hi' },
            },
            { kind: 'end', stopReason: 'tool_use' },
          ];
        }
        return [
          { kind: 'text_delta', text: 'done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ];
      },
    });
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const input = new PassThrough();
    const output = new PassThrough();
    const captured: string[] = [];
    output.on('data', (b: Buffer) => captured.push(b.toString('utf8')));

    const adapter = new TerminalAdapter({
      store: runtime.store,
      input,
      output,
    });
    await adapter.start({
      bus: runtime.bus,
      threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
    });

    input.write('go\n');
    await settle(200);

    const all = await runtime.store.readAll(runtime.rootThreadId);
    expect(all.some((e) => e.kind === 'tool_call')).toBe(true);
    expect(all.some((e) => e.kind === 'tool_result')).toBe(true);
    expect(all.some((e) => e.kind === 'turn_complete')).toBe(true);
    expect(captured.join('')).toContain('done');
    await adapter.stop();
  });
});
