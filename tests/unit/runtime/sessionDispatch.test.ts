import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { buildSamplingRequest } from '@harness/context/projection.js';
import { HandleRegistry } from '@harness/context/handleRegistry.js';

/**
 * Atomic dispatch invariants for async (session) tools.
 *
 * The previous design persisted `tool_call` synchronously but
 * `tool_result` only when the tool body finished. A `user_turn_start`
 * arriving in that window observed an orphan `tool_call` and the
 * projection emitted to OpenAI was illegal ("tool_calls without
 * responses" → 400). The session redesign pairs them atomically; the
 * bug must be unreproducible.
 */

interface Step {
  deltas: SamplingDelta[];
}

class ScriptedProvider implements LlmProvider {
  readonly id = 'session-dispatch-test';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  public readonly steps: Step[];
  public readonly seenRequests: SamplingRequest[] = [];
  private i = 0;
  constructor(steps: Step[]) {
    this.steps = steps;
  }
  async *sample(req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    this.seenRequests.push(req);
    const idx = this.i++;
    const step = this.steps[Math.min(idx, this.steps.length - 1)]!;
    for (const d of step.deltas) {
      if (signal.aborted) return;
      yield d;
    }
    if (!step.deltas.some((d) => d.kind === 'end')) yield { kind: 'end', stopReason: 'end_turn' };
  }
}

describe('runtime: atomic session dispatch', () => {
  it('persists tool_result atomically with tool_call when an async tool dispatches', async () => {
    const provider = new ScriptedProvider([
      // Step 1: dispatch a long-ish web_fetch (we'll sub the URL with a
      // localhost no-op below, but the key contract is the synchronous
      // tool_result {sessionId, status:'running'} pairing).
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: 'tc_fetch' as never, name: 'web_fetch' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_fetch' as never,
            // Use a guaranteed-unreachable URL so the body just errors out;
            // we only care about the dispatch-time pairing.
            args: { url: 'http://127.0.0.1:1/', timeoutMs: 80 },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Step 2: not strictly required for the assertion; reply final.
      {
        deltas: [
          { kind: 'text_delta', text: 'done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      },
    ]);

    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'go' },
    });
    runtime.bus.publish(seed);

    // Wait long enough for the second sampling to run + reply.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2_000);
      const sub = runtime.bus.subscribe(
        (ev) => {
          if (ev.kind === 'turn_complete') {
            clearTimeout(t);
            sub.unsubscribe();
            resolve();
          }
        },
        { threadId: runtime.rootThreadId },
      );
    });

    const events = await runtime.store.readAll(runtime.rootThreadId);

    // tool_call and matching tool_result both present.
    const tc = events.find(
      (e) => e.kind === 'tool_call' && (e.payload as { toolCallId: string }).toolCallId === 'tc_fetch',
    );
    const tr = events.find(
      (e) => e.kind === 'tool_result' && (e.payload as { toolCallId: string }).toolCallId === 'tc_fetch',
    );
    expect(tc).toBeDefined();
    expect(tr).toBeDefined();

    // tool_result body carries sessionId + running status (the atomic placeholder).
    const out = tr!.payload as { ok: boolean; output: { sessionId: string; status: string } };
    expect(out.ok).toBe(true);
    expect(typeof out.output.sessionId).toBe('string');
    expect(out.output.status).toBe('running');

    // tool_call's index strictly precedes its tool_result.
    const tcIdx = events.indexOf(tc!);
    const trIdx = events.indexOf(tr!);
    expect(trIdx).toBeGreaterThan(tcIdx);

    // OpenAI rule we're protecting against is "every tool_use must have a
    // matching tool_result before the next assistant message". Walk the
    // projected tail and verify every tool_use has a same-id response.
    const built = await buildSamplingRequest({
      threadId: runtime.rootThreadId,
      store: runtime.store,
      registry: runtime.registry,
      handles: new HandleRegistry(),
      systemPrompt: 'sys',
    });
    const toolUseIds = new Set<string>();
    const responseIds = new Set<string>();
    for (const item of built.request.tail) {
      for (const c of item.content) {
        if (c.kind === 'tool_use') toolUseIds.add(c.toolCallId);
        if (c.kind === 'tool_result') responseIds.add(c.toolCallId);
        if (c.kind === 'elided' && c.toolCallId) responseIds.add(c.toolCallId);
      }
    }
    expect(toolUseIds.has('tc_fetch')).toBe(true);
    for (const id of toolUseIds) {
      expect(responseIds.has(id), `orphan tool_use ${id}`).toBe(true);
    }
  });

  it('mid-turn user_turn_start does not orphan an in-flight session tool_call', async () => {
    // The bug repro: user types another message while a session tool is
    // still running. Pre-fix, starting a new turn wiped activeTurn and
    // left tc_fetch's tool_result un-persisted forever. Post-fix, the
    // tool_result was already persisted at dispatch.
    const provider = new ScriptedProvider([
      // Turn 1, step 1: dispatch a fetch that takes a while to finish.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: 'tc_fetch' as never, name: 'web_fetch' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_fetch' as never,
            args: { url: 'http://127.0.0.1:1/', timeoutMs: 800 },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Step 2 (still turn 1): reply final without waiting on the session.
      {
        deltas: [
          { kind: 'text_delta', text: 't1-done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      },
      // Turn 2, step 1: a fresh sampling on the new user message. The
      // important thing is that the projection going in is well-formed.
      {
        deltas: [
          { kind: 'text_delta', text: 't2-done', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      },
    ]);

    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });

    const seed1 = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'first message' },
    });
    runtime.bus.publish(seed1);

    // Wait for turn 1 to complete.
    await new Promise<void>((resolve) => {
      const sub = runtime.bus.subscribe(
        (ev) => {
          if (ev.kind === 'turn_complete') {
            sub.unsubscribe();
            resolve();
          }
        },
        { threadId: runtime.rootThreadId },
      );
    });

    // Send a second user message immediately; the web_fetch session
    // is likely still running.
    const seed2 = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'second message' },
    });
    runtime.bus.publish(seed2);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2_000);
      const sub = runtime.bus.subscribe(
        (ev) => {
          if (ev.kind === 'turn_complete') {
            clearTimeout(t);
            sub.unsubscribe();
            resolve();
          }
        },
        { threadId: runtime.rootThreadId },
      );
    });

    // Validate the projection going into turn 2's first sampling.
    const turn2Req = provider.seenRequests[provider.seenRequests.length - 1]!;
    const toolUseIds = new Set<string>();
    const responseIds = new Set<string>();
    for (const item of turn2Req.tail) {
      for (const c of item.content) {
        if (c.kind === 'tool_use') toolUseIds.add(c.toolCallId);
        if (c.kind === 'tool_result') responseIds.add(c.toolCallId);
        if (c.kind === 'elided' && c.toolCallId) responseIds.add(c.toolCallId);
      }
    }
    expect(toolUseIds.has('tc_fetch')).toBe(true);
    for (const id of toolUseIds) {
      expect(responseIds.has(id), `orphan tool_use ${id} in turn-2 prompt`).toBe(true);
    }
  });
});
