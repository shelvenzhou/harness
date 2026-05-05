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

  it('classifies untagged text before a tool_call as preamble (heuristic)', async () => {
    const tc = newToolCallId();
    const parsed = await parseSampling(
      stream([
        { kind: 'text_delta', text: "I'll look that up" },
        { kind: 'tool_call_begin', toolCallId: tc, name: 'shell' },
        { kind: 'tool_call_end', toolCallId: tc, args: { cmd: 'ls' } },
        { kind: 'end', stopReason: 'tool_use' },
      ]),
    );
    expect(parsed.actions.map((a) => a.kind)).toEqual(['preamble', 'tool_call']);
    expect(parsed.actions[0]).toMatchObject({ kind: 'preamble', text: "I'll look that up" });
  });

  it('classifies untagged text without a following tool_call as reply', async () => {
    const parsed = await parseSampling(
      stream([
        { kind: 'text_delta', text: 'just chatting' },
        { kind: 'end', stopReason: 'end_turn' },
      ]),
    );
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({ kind: 'reply', text: 'just chatting', final: true });
  });

  it('handles text → tool_call → text: leading is preamble, trailing is reply', async () => {
    const tc = newToolCallId();
    const parsed = await parseSampling(
      stream([
        { kind: 'text_delta', text: 'planning…' },
        { kind: 'tool_call_begin', toolCallId: tc, name: 'shell' },
        { kind: 'tool_call_end', toolCallId: tc, args: {} },
        { kind: 'text_delta', text: 'all done' },
        { kind: 'end', stopReason: 'end_turn' },
      ]),
    );
    expect(parsed.actions.map((a) => a.kind)).toEqual(['preamble', 'tool_call', 'reply']);
  });

  it('explicit channel="reply" overrides the preamble heuristic', async () => {
    const tc = newToolCallId();
    const parsed = await parseSampling(
      stream([
        { kind: 'text_delta', text: 'an answer', channel: 'reply' },
        { kind: 'tool_call_begin', toolCallId: tc, name: 'shell' },
        { kind: 'tool_call_end', toolCallId: tc, args: {} },
        { kind: 'end', stopReason: 'tool_use' },
      ]),
    );
    expect(parsed.actions.map((a) => a.kind)).toEqual(['reply', 'tool_call']);
  });

  it('collects reasoning_delta into reasoningText (separate from reply)', async () => {
    const parsed = await parseSampling(
      stream([
        { kind: 'reasoning_delta', text: 'think 1' },
        { kind: 'reasoning_delta', text: ' think 2' },
        { kind: 'text_delta', text: 'answer' },
        { kind: 'end', stopReason: 'end_turn' },
      ]),
    );
    expect(parsed.reasoningText).toBe('think 1 think 2');
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({ kind: 'reply', text: 'answer' });
  });

  it('collects provider_state separately from visible reasoning text', async () => {
    const item = { type: 'reasoning', encrypted_content: 'enc' };
    const parsed = await parseSampling(
      stream([
        { kind: 'provider_state', providerId: 'openai', items: [item] },
        { kind: 'end', stopReason: 'tool_use' },
      ]),
    );
    expect(parsed.providerState).toEqual([{ providerId: 'openai', items: [item] }]);
    expect(parsed.reasoningText).toBe('');
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
