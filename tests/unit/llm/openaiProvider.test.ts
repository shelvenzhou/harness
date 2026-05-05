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

  it('passes OpenAI provider_state items back into Responses input', () => {
    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_123',
      summary: [],
      encrypted_content: 'enc',
    };
    const input = __testOnly.toResponsesInput([
      {
        role: 'assistant',
        content: [{ kind: 'provider_state', providerId: 'openai', items: [reasoningItem] }],
      },
    ]);
    expect(input).toEqual([reasoningItem]);
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

describe('OpenAIProvider Responses-API create params', () => {
  const request = {
    prefix: { systemPrompt: 'sys', tools: [] },
    tail: [{ role: 'user' as const, content: [{ kind: 'text' as const, text: 'hello' }] }],
  };

  it('omits temperature unless configured for a model that supports it', () => {
    const params = __testOnly.toResponsesCreateParams(request, {
      model: 'gpt-4o-mini',
      defaultMaxTokens: 32768,
    });
    expect(params).not.toHaveProperty('temperature');
  });

  it('passes configured temperature for non-reasoning models', () => {
    const params = __testOnly.toResponsesCreateParams(request, {
      model: 'gpt-4o-mini',
      defaultMaxTokens: 32768,
      defaultTemperature: 0.2,
    });
    expect(params).toMatchObject({ temperature: 0.2 });
  });

  it('suppresses temperature for reasoning models even when env configured it', () => {
    const params = __testOnly.toResponsesCreateParams(request, {
      model: 'gpt-5.4',
      defaultMaxTokens: 32768,
      defaultTemperature: 0.7,
    });
    expect(params).not.toHaveProperty('temperature');
  });

  it('only sends reasoning controls to reasoning-capable models', () => {
    const reasoning = { summary: 'auto' as const };
    const gpt5 = __testOnly.toResponsesCreateParams(request, {
      model: 'gpt-5.4',
      defaultMaxTokens: 32768,
      reasoning,
    });
    const gpt4o = __testOnly.toResponsesCreateParams(request, {
      model: 'gpt-4o-mini',
      defaultMaxTokens: 32768,
      reasoning,
    });
    expect(gpt5).toMatchObject({ reasoning });
    expect(gpt4o).not.toHaveProperty('reasoning');
  });

  it('requests encrypted reasoning when a reasoning model can call tools', () => {
    const params = __testOnly.toResponsesCreateParams(
      {
        prefix: {
          systemPrompt: 'sys',
          tools: [
            {
              name: 'read',
              description: 'read a file',
              argsSchema: { type: 'object', properties: {} },
            },
          ],
        },
        tail: request.tail,
      },
      {
        model: 'gpt-5.4',
        defaultMaxTokens: 32768,
      },
    );
    expect(params).toMatchObject({ include: ['reasoning.encrypted_content'] });
    expect(params).not.toHaveProperty('reasoning');
  });
});
