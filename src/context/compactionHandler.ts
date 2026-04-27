import type { EventBus } from '@harness/bus/eventBus.js';
import type {
  CompactRequestEvent,
  CompactionEventEvent,
  HarnessEvent,
} from '@harness/core/events.js';
import { newEventId } from '@harness/core/ids.js';
import type { ThreadId } from '@harness/core/ids.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

import type { CompactionTrigger } from './compactionTrigger.js';
import type { Compactor } from './compactor.js';
import { StaticCompactor } from './compactor.js';

/**
 * Cold-path compaction handler.
 *
 * The Trigger publishes a `compact_request` when a thread crosses the
 * configured token threshold. The Handler is the consumer: it loads
 * the thread's events, runs the configured Compactor, persists a
 * `compaction_event` envelope summarising what happened, and calls
 * `trigger.acknowledge(threadId)` so the cooldown can release.
 *
 * Compactor strategy is injected. The default is `StaticCompactor`,
 * which keeps the unit-test path deterministic (no provider call).
 * The "real" cold compactor — a `spawn({role: 'compactor'})` subagent
 * pointed at a forked snapshot — is the next step beyond this commit
 * and only needs the injection point we already provide here.
 *
 * Mechanism only: the handler does NOT mutate the thread's event log.
 * A `compaction_event` is published so projection / diag layers can
 * react, but the actual prompt-shape transformation lives in
 * projection (it learns to honour the most-recent CompactedSummary
 * via a separate change). This keeps the handler safe to retry: a
 * stuck handler that fires twice produces two no-op events instead
 * of corrupting the log.
 */

export interface CompactionHandlerOptions {
  /**
   * Compactor strategy. Default: `StaticCompactor` (deterministic
   * placeholder). Replace with a subagent-backed compactor for live
   * use.
   */
  compactor?: Compactor;
  /**
   * How many trailing user turns the compactor should preserve verbatim.
   * Default: 2.
   */
  keepLastUserTurns?: number;
  /**
   * Trigger to acknowledge so the cooldown can release once compaction
   * finishes. Optional: omitted is fine when the trigger is not in use
   * (e.g. unit tests publishing compact_request manually).
   */
  trigger?: CompactionTrigger;
}

export class CompactionHandler {
  private subscription: { unsubscribe: () => void } | undefined;
  private readonly compactor: Compactor;
  private readonly keepLastUserTurns: number;
  private readonly trigger: CompactionTrigger | undefined;
  /**
   * Per-thread guard: only one compaction in flight per thread at a
   * time. A second compact_request arriving mid-flight is dropped
   * (the cooldown should have caught it; this is belt-and-braces).
   */
  private inFlight = new Set<ThreadId>();

  constructor(opts: CompactionHandlerOptions = {}) {
    this.compactor = opts.compactor ?? new StaticCompactor();
    this.keepLastUserTurns = opts.keepLastUserTurns ?? 2;
    this.trigger = opts.trigger;
  }

  start(bus: EventBus, store: SessionStore): void {
    if (this.subscription) return;
    this.subscription = bus.subscribe(
      (ev) => {
        if (ev.kind !== 'compact_request') return;
        void this.handle(ev as CompactRequestEvent, bus, store);
      },
      { kinds: ['compact_request'] },
    );
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.inFlight.clear();
  }

  private async handle(
    ev: CompactRequestEvent,
    bus: EventBus,
    store: SessionStore,
  ): Promise<void> {
    if (this.inFlight.has(ev.threadId)) return;
    this.inFlight.add(ev.threadId);
    try {
      const events = await store.readAll(ev.threadId);
      const tokensBefore = estimateTokens(events);
      const result = await this.compactor.compact({
        threadId: ev.threadId,
        events,
        keepLastUserTurns: this.keepLastUserTurns,
      });

      const out: HarnessEvent = {
        id: newEventId(),
        threadId: ev.threadId,
        kind: 'compaction_event',
        payload: {
          reason: 'auto',
          tokensBefore,
          tokensAfter: result.tokensAfter || tokensBefore,
          durationMs: result.durationMs,
          retainedUserTurns: result.summary.recentUserTurns.length,
          ghostSnapshotCount: result.summary.ghostSnapshots.length,
        },
        createdAt: new Date().toISOString(),
      } as CompactionEventEvent;
      await store.append(out);
      bus.publish(out);
    } finally {
      this.inFlight.delete(ev.threadId);
      this.trigger?.acknowledge(ev.threadId);
    }
  }
}

/**
 * Cheap token estimate — same shape as projection.estimateTokens, but
 * we keep a private copy here to avoid an import cycle through
 * context/projection.ts (which imports from context/index.ts which
 * re-exports us). Good enough for the `tokensBefore` field on the
 * event; not used for anything load-bearing.
 */
function estimateTokens(events: readonly HarnessEvent[]): number {
  let total = 0;
  for (const ev of events) {
    total += JSON.stringify(ev.payload ?? {}).length;
  }
  // ~4 chars per token is a fine rule of thumb for diagnostics.
  return Math.ceil(total / 4);
}
