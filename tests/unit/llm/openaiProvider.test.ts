import { describe, expect, it } from 'vitest';

import type { ProjectedItem, StablePrefix } from '@harness/llm/provider.js';
import type { ToolCallId } from '@harness/core/ids.js';
import { __testOnly } from '@harness/llm/openaiProvider.js';

describe('OpenAIProvider Responses-API input translation', () => {
  it('emits a function_call input item per tool_use and pairs results by call_id', () => {
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

    const input = __testOnly.toResponsesInput(tail);
    expect(input).toHaveLength(5);
    expect(input[0]).toMatchObject({ role: 'user', content: 'go' });
    expect(input[1]).toMatchObject({
      type: 'function_call',
      call_id: 'call_aaa',
      name: 'shell',
    });
    expect(input[2]).toMatchObject({
      type: 'function_call',
      call_id: 'call_bbb',
      name: 'shell',
    });
    expect(input[3]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_aaa',
    });
    expect(input[4]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_bbb',
    });
  });

  it('emits a function_call_output stub for elided tool_results so call_id pairing survives', () => {
    const tail: ProjectedItem[] = [
      {
        role: 'tool_result',
        content: [
          {
            kind: 'elided',
            handle: 'h_xyz' as never,
            originKind: 'tool_result',
            toolCallId: 'call_zzz' as ToolCallId,
            summary: 'big blob',
          },
        ],
      },
    ];
    const input = __testOnly.toResponsesInput(tail);
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_zzz',
    });
    const outputJson = JSON.parse((input[0] as { output: string }).output) as Record<string, unknown>;
    expect(outputJson).toMatchObject({ elided: true, handle: 'h_xyz' });
  });
});

describe('OpenAIProvider Responses-API tools translation', () => {
  it('flattens harness tools into Responses FunctionTool shape (top-level name/parameters)', () => {
    const prefix: StablePrefix = {
      systemPrompt: 'sys',
      tools: [
        {
          name: 'shell',
          description: 'run a shell command',
          argsSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      ],
    };
    const tools = __testOnly.toResponsesTools(prefix);
    expect(tools).toEqual([
      {
        type: 'function',
        name: 'shell',
        description: 'run a shell command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        strict: false,
      },
    ]);
  });
});

describe('OpenAIProvider Responses-API text.format translation', () => {
  it('passes json_object straight through', () => {
    const out = __testOnly.toResponsesTextFormat({ type: 'json_object' });
    expect(out).toEqual({ type: 'json_object' });
  });

  it('emits json_schema with strict=true by default and the schema flattened to top-level', () => {
    const out = __testOnly.toResponsesTextFormat({
      type: 'json_schema',
      name: 'Result',
      schema: { type: 'object', properties: { x: { type: 'number' } } },
    });
    expect(out).toMatchObject({
      type: 'json_schema',
      name: 'Result',
      strict: true,
      schema: { type: 'object', properties: { x: { type: 'number' } } },
    });
  });

  it('honours explicit strict=false and description', () => {
    const out = __testOnly.toResponsesTextFormat({
      type: 'json_schema',
      name: 'R',
      schema: { type: 'object' },
      strict: false,
      description: 'shape doc',
    });
    expect(out).toMatchObject({
      type: 'json_schema',
      name: 'R',
      strict: false,
      description: 'shape doc',
    });
  });
});
