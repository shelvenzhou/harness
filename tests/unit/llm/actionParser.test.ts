import { describe, it, expect } from 'vitest';

import { parseSampling } from '@harness/llm/actionParser.js';
import type { SamplingDelta } from '@harness/llm/provider.js';
import { newToolCallId } from '@harness/core/ids.js';

async function* stream(deltas: SamplingDelta[]): AsyncIterable<SamplingDelta> {
  for (const d of deltas) yield d;
}

describe('parseSampling', () => {
  it('collects text into a single reply and marks final on end_turn', async () => {
    const parsed = await parseSampling(
      stream([
        { kind: 'text_delta', text: 'hello' },
        { kind: 'text_delta', text: ' world' },
        { kind: 'end', stopReason: 'end_turn' },
      ]),
    );
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({ kind: 'reply', text: 'hello world', final: true });
  });

  it('splits preamble and reply channels', async () => {
    const parsed = await parseSampling(
      stream([
        { kind: 'text_delta', text: 'about to do X', channel: 'preamble' },
        { kind: 'text_delta', text: 'done', channel: 'reply' },
        { kind: 'end', stopReason: 'end_turn' },
      ]),
    );
    const kinds = parsed.actions.map((a) => a.kind);
    expect(kinds).toEqual(['preamble', 'reply']);
  });

  it('emits tool_call action with merged args', async () => {
    const tc = newToolCallId();
    const parsed = await parseSampling(
      stream([
        { kind: 'tool_call_begin', toolCallId: tc, name: 'read' },
        { kind: 'tool_call_end', toolCallId: tc, args: { path: '/tmp/x' } },
        { kind: 'end', stopReason: 'tool_use' },
      ]),
    );
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({
      kind: 'tool_call',
      name: 'read',
      args: { path: '/tmp/x' },
    });
  });
});
