import { describe, it, expect } from 'vitest';

import { MemorySessionStore } from '@harness/store/index.js';
import { ToolRegistry } from '@harness/tools/registry.js';
import {
  HandleRegistry,
  buildSamplingRequest,
  copyHandlesForRefs,
} from '@harness/context/index.js';
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

  it('contextRefs prepend a source thread slice and copy active handles', async () => {
    const store = new MemorySessionStore();
    const parent = newThreadId();
    const child = newThreadId();
    await store.createThread({ id: parent, rootTraceparent: newRootTraceparent() });
    await store.createThread({ id: child, rootTraceparent: newRootTraceparent() });

    // Parent: user_turn_start, tool_call, tool_result (elided), reply
    await store.append({ threadId: parent, kind: 'user_turn_start', payload: { text: 'parent task' } });
    await store.append({
      threadId: parent,
      kind: 'tool_call',
      payload: { toolCallId: 'tc_p1' as never, name: 'read', args: { path: '/x' } },
    });
    const trEvent = await store.append({
      threadId: parent,
      kind: 'tool_result',
      payload: { toolCallId: 'tc_p1' as never, ok: true, output: { content: 'parent body' } },
    });
    const handle = newHandleRef();
    await store.attachElision(parent, trEvent.id, {
      handle,
      kind: 'read_content',
      meta: { size: 11 },
    });
    const lastParentEv = await store.append({
      threadId: parent,
      kind: 'reply',
      payload: { text: 'parent reply' },
    });

    // Child: only its own seed
    await store.append({ threadId: child, kind: 'user_turn_start', payload: { text: 'child task' } });

    const handles = new HandleRegistry();
    await copyHandlesForRefs(
      store,
      [{ sourceThreadId: parent, toEventId: lastParentEv.id }],
      handles,
    );
    expect(handles.has(handle)).toBe(true);

    const { request, stats } = await buildSamplingRequest({
      threadId: child,
      store,
      registry: new ToolRegistry(),
      handles,
      systemPrompt: 'sys',
      pinnedMemory: [],
      contextRefs: [{ sourceThreadId: parent, toEventId: lastParentEv.id }],
    });

    const texts = request.tail
      .flatMap((i) => i.content)
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text);
    expect(texts).toContain('parent task');
    expect(texts).toContain('parent reply');
    expect(texts).toContain('child task');
    // Source elision is rendered as elided (handle is in registry but not pinned).
    expect(stats.elidedCount).toBe(1);
  });

  it('honours compactionCheckpointEventId + compactedSummary', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    const old1 = await store.append({
      threadId: tid,
      kind: 'user_turn_start',
      payload: { text: 'old turn 1' },
    });
    const old2 = await store.append({ threadId: tid, kind: 'reply', payload: { text: 'old reply 1' } });
    void old1;
    await store.append({
      threadId: tid,
      kind: 'user_turn_start',
      payload: { text: 'recent turn' },
    });

    const { request } = await buildSamplingRequest({
      threadId: tid,
      store,
      registry: new ToolRegistry(),
      handles: new HandleRegistry(),
      systemPrompt: 'sys',
      pinnedMemory: [],
      compactedSummary: 'CONDENSED',
      compactionCheckpointEventId: old2.id,
    });
    expect(request.prefix.compactedSummary).toBe('CONDENSED');
    const texts = request.tail
      .flatMap((i) => i.content)
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text);
    expect(texts).toContain('recent turn');
    expect(texts).not.toContain('old turn 1');
    expect(texts).not.toContain('old reply 1');
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
