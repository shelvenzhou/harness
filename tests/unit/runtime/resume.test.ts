import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { resume } from '@harness/runtime/resume.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { EventBus } from '@harness/bus/eventBus.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

/**
 * Resume: rehydrate a runtime from a previous session's JSONL store.
 *
 * Verifies:
 *   - missing thread → error
 *   - existing thread → runner starts, can take a new turn
 *   - tokensThisThread is rebuilt from sampling_complete events so the
 *     hard-wall budget remains accurate across restarts
 */

class CountingProvider implements LlmProvider {
  readonly id = 'counting';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  private i = 0;
  constructor(private readonly perCall: { p: number; c: number; reply: string }) {}
  async *sample(_req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    if (signal.aborted) return;
    const idx = this.i++;
    yield { kind: 'text_delta', text: `${this.perCall.reply}${idx}`, channel: 'reply' };
    yield {
      kind: 'usage',
      tokens: {
        promptTokens: this.perCall.p,
        cachedPromptTokens: 0,
        completionTokens: this.perCall.c,
      },
    };
    yield { kind: 'end', stopReason: 'end_turn' };
  }
}

async function runOneTurn(
  bus: EventBus,
  store: SessionStore,
  threadId: ThreadId,
  text: string,
): Promise<{ status: 'completed' | 'interrupted' | 'errored'; summary?: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3_000);
    const sub = bus.subscribe(
      (ev) => {
        if (ev.kind === 'turn_complete') {
          sub.unsubscribe();
          clearTimeout(t);
          resolve({
            status: ev.payload.status,
            ...(ev.payload.summary !== undefined ? { summary: ev.payload.summary } : {}),
          });
        }
      },
      { threadId },
    );
    void store
      .append({ threadId, kind: 'user_turn_start', payload: { text } })
      .then((seed) => bus.publish(seed), reject);
  });
}

describe('runtime: resume', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'harness-resume-'));
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('throws when the threadId is unknown', async () => {
    await expect(
      resume({
        provider: new CountingProvider({ p: 0, c: 0, reply: 'x' }),
        systemPrompt: 'sys',
        storeRoot: workdir,
        threadId: 'thr_does_not_exist' as ThreadId,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('rebuilds tokensThisThread from sampling_complete events', async () => {
    // Phase 1: bootstrap fresh, run two turns that bank known token totals.
    const rt1 = await bootstrap({
      provider: new CountingProvider({ p: 300, c: 200, reply: 'one' }),
      systemPrompt: 'sys',
      storeRoot: workdir,
    });
    await runOneTurn(rt1.bus, rt1.store, rt1.rootThreadId, 'a');
    await runOneTurn(rt1.bus, rt1.store, rt1.rootThreadId, 'b');
    const threadId = rt1.rootThreadId;
    // Two turns × 500 tokens = 1000 banked.

    // Phase 2: resume the same thread. The new runner must see the
    // banked tokens, not zero. We assert via the hard-wall budget: a
    // cap of 1000 should fire IMMEDIATELY on the next turn's sampling
    // boundary because the rehydrated counter already equals the cap.
    const rt2 = await resume({
      provider: new CountingProvider({ p: 100, c: 100, reply: 'three' }),
      systemPrompt: 'sys',
      storeRoot: workdir,
      threadId,
      tokenBudget: { maxThreadTokens: 1_000 },
    });
    const result = await runOneTurn(rt2.bus, rt2.store, threadId, 'c');
    expect(result.status).toBe('errored');
    expect(result.summary).toMatch(/tokens_exceeded:thread/);
  });

  it('lets a fresh user_turn_start succeed after a clean resume', async () => {
    const rt1 = await bootstrap({
      provider: new CountingProvider({ p: 50, c: 30, reply: 'r' }),
      systemPrompt: 'sys',
      storeRoot: workdir,
    });
    await runOneTurn(rt1.bus, rt1.store, rt1.rootThreadId, 'first');
    const threadId = rt1.rootThreadId;

    const rt2 = await resume({
      provider: new CountingProvider({ p: 50, c: 30, reply: 'r' }),
      systemPrompt: 'sys',
      storeRoot: workdir,
      threadId,
    });
    const result = await runOneTurn(rt2.bus, rt2.store, threadId, 'second');
    expect(result.status).toBe('completed');

    // Both turns are persisted on the same thread.
    const events = await rt2.store.readAll(threadId);
    const userTurns = events.filter((e) => e.kind === 'user_turn_start');
    expect(userTurns).toHaveLength(2);
    expect((userTurns[0]!.payload as { text: string }).text).toBe('first');
    expect((userTurns[1]!.payload as { text: string }).text).toBe('second');
  });
});
