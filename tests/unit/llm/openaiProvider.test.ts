import { describe, expect, it } from 'vitest';

import type { ProjectedItem, StablePrefix } from '@harness/llm/provider.js';
import type { ToolCallId } from '@harness/core/ids.js';
import { __testOnly } from '@harness/llm/openaiProvider.js';

describe('OpenAIProvider message translation', () => {
  it('merges adjacent assistant tool_use items into one assistant tool_calls message', () => {
    const prefix: StablePrefix = {
      systemPrompt: 'sys',
      tools: [],
    };
    const tail: ProjectedItem[] = [
      {
        role: 'user',
        content: [{ kind: 'text', text: 'go' }],
      },
      {
        role: 'assistant',
        content: [
          {
            kind: 'tool_use',
            toolCallId: 'call_aaa' as ToolCallId,
            name: 'shell',
            args: { cmd: 'echo a' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            kind: 'tool_use',
            toolCallId: 'call_bbb' as ToolCallId,
            name: 'shell',
            args: { cmd: 'echo b' },
          },
        ],
      },
      {
        role: 'tool_result',
        content: [
          {
            kind: 'tool_result',
            toolCallId: 'call_aaa' as ToolCallId,
            ok: true,
            output: { stdout: 'a' },
          },
        ],
      },
      {
        role: 'tool_result',
        content: [
          {
            kind: 'tool_result',
            toolCallId: 'call_bbb' as ToolCallId,
            ok: true,
            output: { stdout: 'b' },
          },
        ],
      },
    ];

    const messages = __testOnly.toChatMessages(prefix, tail);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'go' });
    expect(messages[2]).toMatchObject({ role: 'assistant' });
    expect(
      'tool_calls' in messages[2]! && Array.isArray(messages[2].tool_calls)
        ? messages[2].tool_calls
        : [],
    ).toHaveLength(2);
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_aaa' });
    expect(messages[4]).toMatchObject({ role: 'tool', tool_call_id: 'call_bbb' });
  });
});

describe('OpenAIProvider response_format', () => {
  it('passes json_object straight through', () => {
    const out = __testOnly.toResponseFormat({ type: 'json_object' });
    expect(out).toEqual({ type: 'json_object' });
  });

  it('wraps json_schema spec with strict=true by default', () => {
    const out = __testOnly.toResponseFormat({
      type: 'json_schema',
      name: 'Result',
      schema: { type: 'object', properties: { x: { type: 'number' } } },
    });
    expect(out).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'Result',
        strict: true,
        schema: { type: 'object', properties: { x: { type: 'number' } } },
      },
    });
  });

  it('honours explicit strict=false and description', () => {
    const out = __testOnly.toResponseFormat({
      type: 'json_schema',
      name: 'R',
      schema: { type: 'object' },
      strict: false,
      description: 'shape doc',
    });
    expect(out).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'R', strict: false, description: 'shape doc' },
    });
  });
});

describe('OpenAIProvider reasoning field probing', () => {
  it('reads reasoning_content', () => {
    expect(__testOnly.readReasoningField({ reasoning_content: 'thinking…' })).toBe('thinking…');
  });

  it('falls back to reasoning when reasoning_content is absent', () => {
    expect(__testOnly.readReasoningField({ reasoning: 'alt' })).toBe('alt');
  });

  it('returns empty string when neither field is set', () => {
    expect(__testOnly.readReasoningField({ content: 'hi' })).toBe('');
    expect(__testOnly.readReasoningField(null)).toBe('');
    expect(__testOnly.readReasoningField(undefined)).toBe('');
  });

  it('ignores non-string values', () => {
    expect(__testOnly.readReasoningField({ reasoning_content: 42 })).toBe('');
    expect(__testOnly.readReasoningField({ reasoning: { nested: 'x' } })).toBe('');
  });
});
