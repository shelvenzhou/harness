import type { EventBus } from '@harness/bus/eventBus.js';
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
  threadBinding: ThreadBinding;
}

export interface Adapter {
  readonly id: string;
  start(opts: AdapterStartOptions): Promise<void>;
  stop(): Promise<void>;
}
