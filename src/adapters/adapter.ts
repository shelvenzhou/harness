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
}

export interface Adapter {
  readonly id: string;
  start(opts: AdapterStartOptions): Promise<void>;
  stop(): Promise<void>;
}
