import { describe, expect, it } from 'vitest';

import { newEventId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import type { EventBus } from '@harness/bus/eventBus.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

/**
 * Regression / integration: once a `compaction_event` carrying a summary
 * + atEventId lands on a thread, every subsequent sampling on that
 * thread must:
 *   1. expose `summary` as a cache-tagged synthetic head-of-tail item
 *      (not on the prefix — keeps the prefix byte-stable across compactions)
 *   2. drop tail events with id ≤ atEventId
 *
 * Verifies the AgentRunner's `latestCompaction()` helper plus the
 * already-wired projection plumbing, using a recording provider so we
 * can inspect the SamplingRequest the model sees.
 */

class RecordingProvider implements LlmProvider {
  readonly id = 'recording';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: false,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  public requests: SamplingRequest[] = [];
  async *sample(req: SamplingRequest, _signal: AbortSignal): AsyncIterable<SamplingDelta> {
    this.requests.push(req);
    yield { kind: 'text_delta', text: 'ok', channel: 'reply' };
    yield { kind: 'end', stopReason: 'end_turn' };
  }
}

async function runOneTurn(
  bus: EventBus,
  store: SessionStore,
  threadId: ThreadId,
  text: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 2_000);
    const sub = bus.subscribe(
      (ev) => {
        if (ev.kind === 'turn_complete') {
          sub.unsubscribe();
          clearTimeout(t);
          resolve();
        }
      },
      { threadId },
    );
    void store
      .append({ threadId, kind: 'user_turn_start', payload: { text } })
      .then((seed) => bus.publish(seed));
  });
}

describe('runtime: compaction summary injection', () => {
  it('next sampling sees compactedSummary and the elided turns are dropped from tail', async () => {
    const provider = new RecordingProvider();
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });

    await runOneTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'turn 1');
    await runOneTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'turn 2');

    // Land a compaction_event at the boundary of turn 1.
    const all = await runtime.store.readAll(runtime.rootThreadId);
    const lastTurn1Event = all.find(
      (e) =>
        e.kind === 'reply' &&
        (e.payload as { text?: string }).text === 'ok' &&
        // first 'ok' reply belongs to turn 1
        all.findIndex((x) => x.id === e.id) <
          all.findIndex(
            (x) => x.kind === 'user_turn_start' && (x.payload as { text?: string }).text === 'turn 2',
          ),
    );
    expect(lastTurn1Event).toBeDefined();

    const compaction: HarnessEvent = {
      id: newEventId(),
      threadId: runtime.rootThreadId,
      kind: 'compaction_event',
      payload: {
        reason: 'manual',
        tokensBefore: 100,
        tokensAfter: 20,
        durationMs: 1,
        retainedUserTurns: 1,
        ghostSnapshotCount: 0,
        summary: 'CONDENSED-PRIOR',
        atEventId: lastTurn1Event!.id,
      },
      createdAt: new Date().toISOString(),
    } as HarnessEvent;
    await runtime.store.append(compaction);
    runtime.bus.publish(compaction);

    const before = provider.requests.length;
    await runOneTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'turn 3');
    const last = provider.requests.at(-1);
    expect(provider.requests.length).toBeGreaterThan(before);
    expect(last?.prefix).not.toHaveProperty('compactedSummary');

    const summaryItem = last?.tail.find((i) => i.cacheTag === 'compacted-summary');
    expect(summaryItem).toBeDefined();
    const summaryText = summaryItem?.content
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(summaryText).toContain('CONDENSED-PRIOR');

    const tailTexts = (last?.tail ?? [])
      .flatMap((i) => i.content)
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text);
    expect(tailTexts.some((t) => t.includes('turn 3'))).toBe(true);
    // turn 1 + the first 'ok' reply should be elided (≤ checkpoint).
    expect(tailTexts.some((t) => t === 'turn 1')).toBe(false);
    // turn 2 lives after the checkpoint and stays.
    expect(tailTexts.some((t) => t === 'turn 2')).toBe(true);
  });

  it('a metrics-only compaction_event (no summary/atEventId) is ignored', async () => {
    const provider = new RecordingProvider();
    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });

    await runOneTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'turn A');

    const metricsOnly: HarnessEvent = {
      id: newEventId(),
      threadId: runtime.rootThreadId,
      kind: 'compaction_event',
      payload: {
        reason: 'auto',
        tokensBefore: 10,
        tokensAfter: 5,
        durationMs: 0,
        retainedUserTurns: 0,
        ghostSnapshotCount: 0,
      },
      createdAt: new Date().toISOString(),
    } as HarnessEvent;
    await runtime.store.append(metricsOnly);
    runtime.bus.publish(metricsOnly);

    await runOneTurn(runtime.bus, runtime.store, runtime.rootThreadId, 'turn B');
    const last = provider.requests.at(-1);
    expect(last?.tail.some((i) => i.cacheTag === 'compacted-summary')).toBe(false);
    const texts = (last?.tail ?? [])
      .flatMap((i) => i.content)
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text);
    expect(texts.some((t) => t.includes('turn A'))).toBe(true);
    expect(texts.some((t) => t.includes('turn B'))).toBe(true);
  });
});
