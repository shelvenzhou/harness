import type { ThreadId, TurnId } from '@harness/core/ids.js';

/**
 * StreamBus — transient pub/sub for token-level streaming.
 *
 * The main EventBus carries the persisted, replayable conversation
 * spine: every event is also written to the SessionStore. That shape
 * is wrong for token deltas — we'd write thousands of rows per turn
 * with no replay value. StreamBus carries only live UI hints (text
 * deltas, reasoning deltas) that have the same lifetime as a single
 * sampling, are dropped on the floor if no subscriber is attached,
 * and never touch the store.
 *
 * Subscribers are synchronous (no per-subscriber queue) — the
 * publisher is a streaming API loop that already paces itself, so we
 * don't need to add another async boundary.
 */

export type StreamEvent =
  | {
      kind: 'text_delta';
      threadId: ThreadId;
      turnId: TurnId;
      /**
       * Set when the provider knows the channel up-front. Otherwise
       * the parser only decides at flush time (preamble before a
       * tool call, reply otherwise) — adapters should treat untagged
       * deltas as 'reply' for display.
       */
      channel?: 'reply' | 'preamble';
      text: string;
    }
  | {
      kind: 'reasoning_delta';
      threadId: ThreadId;
      turnId: TurnId;
      text: string;
    }
  | {
      /**
       * Marks the end of a sampling step; adapters use this to flush
       * any in-progress streamed line and stop deduping the next
       * reply/preamble event.
       */
      kind: 'sampling_flush';
      threadId: ThreadId;
      turnId: TurnId;
    };

export type StreamHandler = (event: StreamEvent) => void;

export interface StreamSubscribeOptions {
  threadId?: ThreadId;
  kinds?: StreamEvent['kind'][];
}

export interface StreamSubscription {
  unsubscribe(): void;
}

export class StreamBus {
  private nextId = 1;
  private subs = new Map<number, { handler: StreamHandler; opts: StreamSubscribeOptions }>();

  publish(event: StreamEvent): void {
    for (const { handler, opts } of this.subs.values()) {
      if (opts.threadId && opts.threadId !== event.threadId) continue;
      if (opts.kinds && !opts.kinds.includes(event.kind)) continue;
      try {
        handler(event);
      } catch {
        // Streaming subscribers must never take down the runtime;
        // diagnostics belong elsewhere.
      }
    }
  }

  subscribe(
    handler: StreamHandler,
    opts: StreamSubscribeOptions = {},
  ): StreamSubscription {
    const id = this.nextId++;
    this.subs.set(id, { handler, opts });
    return {
      unsubscribe: () => {
        this.subs.delete(id);
      },
    };
  }
}
