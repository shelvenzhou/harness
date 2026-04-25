import { describe, it, expect } from 'vitest';

import { newHandleRef, newThreadId } from '@harness/core/ids.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import { MemorySessionStore } from '@harness/store/index.js';
import { ToolRegistry } from '@harness/tools/registry.js';
import { HandleRegistry, buildSamplingRequest } from '@harness/context/index.js';
import type { ToolCallId } from '@harness/core/ids.js';

/**
 * Regression: every projected tool_use content block must have a matching
 * tool_result block — OpenAI rejects the request otherwise with
 * "An assistant message with 'tool_calls' must be followed by tool messages
 *  responding to each 'tool_call_id'".
 *
 * The bug we hit: AgentRunner persisted a tool_result without a preceding
 * tool_call event for spawn/wait/restore, breaking the pairing invariant.
 */

describe('projection: tool_call ↔ tool_result pairing', () => {
  it('every tool_use in tail has a matching tool_result with the same id', async () => {
    const store = new MemorySessionStore();
    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: newRootTraceparent() });
    await store.append({
      threadId: tid,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });

    const callIds = ['call_aaa', 'call_bbb', 'call_ccc'] as const;
    for (const id of callIds) {
      await store.append({
        threadId: tid,
        kind: 'tool_call',
        payload: { toolCallId: id as ToolCallId, name: 'shell', args: { cmd: ':' } },
      });
    }
    for (const id of callIds) {
      const ev = await store.append({
        threadId: tid,
        kind: 'tool_result',
        payload: { toolCallId: id as ToolCallId, ok: true, output: 'ok' },
      });
      if (id === 'call_bbb') {
        await store.attachElision(tid, ev.id, {
          handle: newHandleRef(),
          kind: 'shell_output',
          meta: { bytes: 99999 },
        });
      }
    }

    const { request } = await buildSamplingRequest({
      threadId: tid,
      store,
      registry: new ToolRegistry(),
      handles: new HandleRegistry(),
      systemPrompt: 'sys',
      pinnedMemory: [],
    });

    // The invariant: every tool_use in the projection has a matching
    // response — EITHER a tool_result block OR an elided block carrying
    // the same toolCallId (so the provider can still emit a tool-role
    // message, which is what OpenAI requires).
    const toolUseIds = new Set<string>();
    const responseIds = new Set<string>();
    for (const item of request.tail) {
      for (const c of item.content) {
        if (c.kind === 'tool_use') toolUseIds.add(c.toolCallId);
        if (c.kind === 'tool_result') responseIds.add(c.toolCallId);
        if (c.kind === 'elided' && c.toolCallId) responseIds.add(c.toolCallId);
      }
    }
    expect(toolUseIds.size).toBe(callIds.length);
    for (const id of toolUseIds) expect(responseIds.has(id)).toBe(true);

    // Underlying event log invariant: every tool_call event has a
    // tool_result event with the same id.
    const events = await store.readAll(tid);
    const callEventIds = events
      .filter((e) => e.kind === 'tool_call')
      .map((e) => (e.payload as { toolCallId: string }).toolCallId);
    const resultEventIds = new Set(
      events
        .filter((e) => e.kind === 'tool_result')
        .map((e) => (e.payload as { toolCallId: string }).toolCallId),
    );
    for (const id of callEventIds) expect(resultEventIds.has(id)).toBe(true);
  });
});
