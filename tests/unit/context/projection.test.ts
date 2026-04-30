import { describe, it, expect } from 'vitest';

import { MemorySessionStore } from '@harness/store/index.js';
import { ToolRegistry } from '@harness/tools/registry.js';
import { HandleRegistry, buildSamplingRequest } from '@harness/context/index.js';
import { newHandleRef, newThreadId } from '@harness/core/ids.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';

describe('buildSamplingRequest', () => {
  it('projects basic user/assistant turns into ProjectedItems', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await store.append({
      threadId: tid,
      kind: 'user_turn_start',
      payload: { text: 'hello' },
    });
    await store.append({
      threadId: tid,
      kind: 'reply',
      payload: { text: 'hi there' },
    });

    const { request, stats } = await buildSamplingRequest({
      threadId: tid,
      store,
      registry: new ToolRegistry(),
      handles: new HandleRegistry(),
      systemPrompt: 'sys',
      pinnedMemory: [],
    });
    expect(request.tail).toHaveLength(2);
    expect(request.tail[0]?.role).toBe('user');
    expect(request.tail[1]?.role).toBe('assistant');
    expect(stats.eventCount).toBe(2);
    expect(stats.estimatedTokens).toBeGreaterThan(0);
  });

  it('elides tool_results and counts them', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await store.append({
      threadId: tid,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    const tc = await store.append({
      threadId: tid,
      kind: 'tool_call',
      payload: { toolCallId: 'tc_1' as never, name: 'read', args: { path: '/tmp/x' } },
    });
    void tc;
    const tr = await store.append({
      threadId: tid,
      kind: 'tool_result',
      payload: {
        toolCallId: 'tc_1' as never,
        ok: true,
        output: { content: 'a'.repeat(5000) },
      },
    });
    const handle = newHandleRef();
    await store.attachElision(tid, tr.id, { handle, kind: 'read_content', meta: { size: 5000 } });

    const { request, stats } = await buildSamplingRequest({
      threadId: tid,
      store,
      registry: new ToolRegistry(),
      handles: new HandleRegistry(),
      systemPrompt: 'sys',
      pinnedMemory: [],
    });
    expect(stats.elidedCount).toBe(1);
    const toolResultItem = request.tail.find((i) => i.role === 'tool_result');
    expect(toolResultItem?.content[0]?.kind).toBe('elided');
  });

  it('rolled-back events are dropped from the projection', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    const a = await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'a' } });
    const b = await store.append({ threadId: tid, kind: 'reply', payload: { text: 'b' } });
    await store.append({
      threadId: tid,
      kind: 'rollback_marker',
      payload: { fromEventId: a.id, toEventId: b.id },
    });
    await store.append({ threadId: tid, kind: 'user_turn_start', payload: { text: 'c' } });

    const { request } = await buildSamplingRequest({
      threadId: tid,
      store,
      registry: new ToolRegistry(),
      handles: new HandleRegistry(),
      systemPrompt: 'sys',
      pinnedMemory: [],
    });
    const texts = request.tail
      .flatMap((i) => i.content)
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text);
    expect(texts).toContain('c');
    expect(texts).not.toContain('a');
    expect(texts).not.toContain('b');
  });

  it('projects subtask_complete reason and budget metadata into the prompt text', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await store.append({
      threadId: tid,
      kind: 'subtask_complete',
      payload: {
        childThreadId: 'thr_child' as never,
        status: 'budget_exceeded',
        summary: 'partial conclusion',
        reason: 'budget:maxTokens',
        budget: {
          reason: 'maxTokens',
          turnsUsed: 1,
          toolCallsUsed: 2,
          tokensUsed: 321,
        },
      },
    });

    const { request } = await buildSamplingRequest({
      threadId: tid,
      store,
      registry: new ToolRegistry(),
      handles: new HandleRegistry(),
      systemPrompt: 'sys',
      pinnedMemory: [],
    });
    const text = request.tail[0]?.content[0];
    expect(text?.kind).toBe('text');
    expect((text as { text: string }).text).toContain('[subtask thr_child budget_exceeded');
    expect((text as { text: string }).text).toContain('reason=budget:maxTokens');
    expect((text as { text: string }).text).toContain('budget=maxTokens');
    expect((text as { text: string }).text).toContain('tokens=321');
    expect((text as { text: string }).text).toContain('partial conclusion');
  });
});
