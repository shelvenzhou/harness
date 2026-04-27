import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { ToolExecutor } from '@harness/tools/executor.js';
import { ToolRegistry } from '@harness/tools/registry.js';
import type { Tool, ToolExecutionContext } from '@harness/tools/tool.js';
import { newThreadId, newToolCallId, newTurnId, newHandleRef } from '@harness/core/ids.js';

function ctx(): ToolExecutionContext {
  return {
    threadId: newThreadId(),
    turnId: newTurnId(),
    toolCallId: newToolCallId(),
    signal: new AbortController().signal,
    log: () => void 0,
    registerHandle: () => newHandleRef(),
    services: {},
  };
}

const okTool: Tool<z.ZodObject<{ name: z.ZodString }>, string> = {
  name: 'ok',
  description: 'noop',
  schema: z.object({ name: z.string() }),
  concurrency: 'safe',
  execute: async (args) => ({ ok: true, output: `hi ${args.name}` }),
};

describe('ToolExecutor', () => {
  it('returns unknown_tool for missing names', async () => {
    const reg = new ToolRegistry();
    const exec = new ToolExecutor(reg);
    const r = await exec.execute({
      toolCallId: newToolCallId(),
      name: 'nope',
      args: {},
      ctx: ctx(),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('unknown_tool');
  });

  it('schema validation surfaces as error', async () => {
    const reg = new ToolRegistry();
    reg.register(okTool);
    const exec = new ToolExecutor(reg);
    const r = await exec.execute({
      toolCallId: newToolCallId(),
      name: 'ok',
      args: {},
      ctx: ctx(),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('schema');
  });

  it('surfaces truncated tool JSON as a readable schema error', async () => {
    const reg = new ToolRegistry();
    reg.register(okTool);
    const exec = new ToolExecutor(reg);
    const r = await exec.execute({
      toolCallId: newToolCallId(),
      name: 'ok',
      args: { _raw: '{"name":"alice"' },
      ctx: ctx(),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('schema');
    expect(r.error?.message).toContain('tool arguments were not valid JSON');
    expect(r.error?.message).toContain('cut off mid-tool-call');
  });

  it('executeBatch preserves input order', async () => {
    const reg = new ToolRegistry();
    reg.register(okTool);
    const exec = new ToolExecutor(reg);
    const ids = [newToolCallId(), newToolCallId(), newToolCallId()];
    const results = await exec.executeBatch(
      ids.map((id, i) => ({
        toolCallId: id,
        name: 'ok',
        args: { name: String(i) },
        ctx: ctx(),
      })),
    );
    expect(results.map((r) => r.toolCallId)).toEqual(ids);
    expect(results.map((r) => r.result.output)).toEqual(['hi 0', 'hi 1', 'hi 2']);
  });

  it('serial tools run one at a time per thread', async () => {
    const events: string[] = [];
    const slow: Tool<z.ZodObject<{ id: z.ZodString }>, string> = {
      name: 'slow',
      description: 'serial tool',
      schema: z.object({ id: z.string() }),
      concurrency: 'serial',
      execute: async (args) => {
        events.push(`begin:${args.id}`);
        await new Promise((r) => setTimeout(r, 20));
        events.push(`end:${args.id}`);
        return { ok: true, output: args.id };
      },
    };
    const reg = new ToolRegistry();
    reg.register(slow);
    const exec = new ToolExecutor(reg);
    const sharedCtxBase = ctx();
    await Promise.all([
      exec.execute({ toolCallId: newToolCallId(), name: 'slow', args: { id: 'a' }, ctx: { ...sharedCtxBase, toolCallId: newToolCallId() } }),
      exec.execute({ toolCallId: newToolCallId(), name: 'slow', args: { id: 'b' }, ctx: { ...sharedCtxBase, toolCallId: newToolCallId() } }),
    ]);
    // No interleaving: every begin precedes its own end, and begins don't overlap.
    expect(events).toEqual(['begin:a', 'end:a', 'begin:b', 'end:b']);
  });
});
