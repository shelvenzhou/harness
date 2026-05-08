import type { EventBus } from '@harness/bus/eventBus.js';
import type { StreamBus } from '@harness/bus/streamBus.js';
import type { ThreadId } from '@harness/core/ids.js';

/**
 * Adapter interface. See design-docs/06-adapters.md.
 *
 * Adapters translate external I/O (terminal, Discord, TG, HTTP) into bus
 * events and subscribe to outbound events for rendering. The runtime does
 * not know which adapter is connected.
 */

export type ThreadBinding =
  | { kind: 'single'; threadId: ThreadId }
  | {
      kind: 'per-channel';
      resolve: (externalChannelId: string) => ThreadId | Promise<ThreadId>;
    };

/**
 * Hooks the adapter calls when handling /new and /resume. The runtime
 * owns thread/runner lifecycle; the adapter just asks for "create one"
 * or "make sure this one has a runner attached" and then re-binds its
 * subscriptions. Without a router, the session-switching commands
 * surface a "not supported" notice instead of silently breaking.
 */
export interface SessionRouter {
  createThread(input?: { title?: string }): Promise<ThreadId>;
  adoptThread(threadId: ThreadId): Promise<void>;
}

export interface AdapterStartOptions {
  bus: EventBus;
  /**
   * Transient streaming bus. When supplied, the adapter can render
   * token-level deltas (text, reasoning) live instead of waiting for
   * the persisted `reply` event at sampling end. Optional — adapters
   * MUST still handle the persisted-event-only case.
   */
  streamBus?: StreamBus;
  threadBinding: ThreadBinding;
  /** Optional. Required for /new and /resume to function. */
  router?: SessionRouter;
}

export interface Adapter {
  readonly id: string;
  start(opts: AdapterStartOptions): Promise<void>;
  stop(): Promise<void>;
}
