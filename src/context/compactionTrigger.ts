import type { EventBus } from '@harness/bus/eventBus.js';
import type {
  CompactRequestEvent,
  HarnessEvent,
  SamplingCompleteEvent,
} from '@harness/core/events.js';
import { newEventId } from '@harness/core/ids.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

/**
 * Cold-path compaction trigger.
 *
 * Subscribes to `sampling_complete` events, watches the projection's
 * estimatedTokens, and publishes a `compact_request{reason: 'threshold'}`
 * when a thread crosses the configured threshold.
 *
 * Mechanism only: the trigger fires the request; the actual compaction
 * (currently the StaticCompactor stub, eventually a subagent spawn per
 * design-docs/04-context.md §Level 2) is the *handler*. Splitting them
 * keeps the dev-facing knob (threshold, cooldown) decoupled from the
 * implementation of summarisation.
 *
 * Cooldown: after firing, suppress further triggers on the same thread
 * for `cooldownSamples` further sampling steps. Without it, a
 * threshold-bouncing context would emit a request every step until the
 * compactor caught up.
 */

export interface CompactionTriggerOptions {
  /** Fire when projection.estimatedTokens >= this. */
  thresholdTokens: number;
  /**
   * Number of sampling steps to suppress further triggers after firing.
   * Default 5.
   */
  cooldownSamples?: number;
}

export class CompactionTrigger {
  private lastFiredSamplingIndex = new Map<ThreadId, number>();
  private subscription: { unsubscribe: () => void } | undefined;

  constructor(private readonly opts: CompactionTriggerOptions) {}

  start(bus: EventBus, store: SessionStore): void {
    if (this.subscription) return;
    this.subscription = bus.subscribe(
      (ev) => {
        if (ev.kind !== 'sampling_complete') return;
        void this.maybeFire(ev as SamplingCompleteEvent, bus, store);
      },
      { kinds: ['sampling_complete'] },
    );
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.lastFiredSamplingIndex.clear();
  }

  /**
   * Reset cooldown / state for a thread. Call this after the actual
   * compactor has run, so the next threshold cross can fire again.
   */
  acknowledge(threadId: ThreadId): void {
    this.lastFiredSamplingIndex.delete(threadId);
  }

  private async maybeFire(
    ev: SamplingCompleteEvent,
    bus: EventBus,
    store: SessionStore,
  ): Promise<void> {
    if (ev.payload.projection.estimatedTokens < this.opts.thresholdTokens) return;
    const cooldown = this.opts.cooldownSamples ?? 5;
    const lastIdx = this.lastFiredSamplingIndex.get(ev.threadId);
    if (lastIdx !== undefined && ev.payload.samplingIndex - lastIdx < cooldown) {
      return;
    }
    this.lastFiredSamplingIndex.set(ev.threadId, ev.payload.samplingIndex);

    const out: HarnessEvent = {
      id: newEventId(),
      threadId: ev.threadId,
      kind: 'compact_request',
      payload: { reason: 'threshold' },
      createdAt: new Date().toISOString(),
    } as CompactRequestEvent;
    await store.append(out);
    bus.publish(out);
  }
}
