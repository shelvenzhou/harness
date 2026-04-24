import type { EventKind, HarnessEvent } from '@harness/core/events.js';
import type { ThreadId } from '@harness/core/ids.js';

/**
 * In-process typed pub/sub bus.
 *
 * - Subscribers are async. A slow subscriber only slows its own queue; it
 *   does not back up the publisher.
 * - Per-subscriber bounded queue; drop-oldest on overflow (we prefer
 *   availability over completeness for diagnostic subscribers).
 * - `publish` resolves as soon as the event is fanned out to queues, not
 *   when subscribers have processed. This matches the async-loop design.
 *
 * Out of scope here: persistence (SessionStore's job), cross-process
 * transport (future JSON-RPC / SSE adapter).
 */

export interface SubscribeOptions {
  /** Only receive events for this thread (and its descendants). */
  threadId?: ThreadId;
  /** Restrict to specific event kinds. */
  kinds?: EventKind[];
  /** Max queue depth before drop-oldest kicks in. */
  queueDepth?: number;
}

export type EventHandler = (event: HarnessEvent) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

interface InternalSub {
  id: number;
  handler: EventHandler;
  opts: SubscribeOptions;
  queue: HarnessEvent[];
  draining: boolean;
  closed: boolean;
  droppedCount: number;
}

const DEFAULT_QUEUE_DEPTH = 1024;

export class EventBus {
  private subs = new Map<number, InternalSub>();
  private nextSubId = 1;
  private closed = false;

  publish(event: HarnessEvent): void {
    if (this.closed) return;
    for (const sub of this.subs.values()) {
      if (!matches(event, sub.opts)) continue;
      if (sub.queue.length >= (sub.opts.queueDepth ?? DEFAULT_QUEUE_DEPTH)) {
        sub.queue.shift();
        sub.droppedCount += 1;
      }
      sub.queue.push(event);
      if (!sub.draining) void this.drain(sub);
    }
  }

  subscribe(handler: EventHandler, opts: SubscribeOptions = {}): Subscription {
    const id = this.nextSubId++;
    const sub: InternalSub = {
      id,
      handler,
      opts,
      queue: [],
      draining: false,
      closed: false,
      droppedCount: 0,
    };
    this.subs.set(id, sub);
    return {
      unsubscribe: () => {
        sub.closed = true;
        this.subs.delete(id);
      },
    };
  }

  close(): void {
    this.closed = true;
    for (const sub of this.subs.values()) sub.closed = true;
    this.subs.clear();
  }

  /** Diagnostic: number of events dropped per subscriber since subscribe. */
  stats(): Array<{ id: number; pending: number; dropped: number }> {
    return [...this.subs.values()].map((s) => ({
      id: s.id,
      pending: s.queue.length,
      dropped: s.droppedCount,
    }));
  }

  private async drain(sub: InternalSub): Promise<void> {
    sub.draining = true;
    try {
      while (sub.queue.length > 0 && !sub.closed) {
        const ev = sub.queue.shift()!;
        try {
          await sub.handler(ev);
        } catch (err) {
          // Subscriber errors must not take down the bus; surface via
          // console and keep going. Diagnostics layer can subscribe to
          // pick these up more formally later.
          // eslint-disable-next-line no-console
          console.error('[eventbus] subscriber error', err);
        }
      }
    } finally {
      sub.draining = false;
    }
  }
}

function matches(event: HarnessEvent, opts: SubscribeOptions): boolean {
  if (opts.threadId && event.threadId !== opts.threadId) return false;
  if (opts.kinds && !opts.kinds.includes(event.kind)) return false;
  return true;
}
