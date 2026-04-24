import type { EventId, ThreadId, TurnId } from './ids.js';

/**
 * Thread / Turn / Item model.
 *
 * See design-docs/02-events-and-state.md. Thread is the durable session
 * container; Turn is one user-input → agent-done cycle; Item is whatever
 * gets persisted as an Event. Item and Event are the same thing at rest.
 */

export type ThreadStatus = 'active' | 'archived';

export interface Thread {
  id: ThreadId;
  title?: string;
  status: ThreadStatus;
  parentThreadId?: ThreadId;
  rootTraceparent: string;
  createdAt: string;
  updatedAt: string;
  /** id of the latest checkpoint, if any */
  latestCheckpointAtEventId?: EventId;
}

export type TurnStatus = 'pending' | 'running' | 'completed' | 'interrupted' | 'errored';

export interface Turn {
  id: TurnId;
  threadId: ThreadId;
  status: TurnStatus;
  startedAt: string;
  endedAt?: string;
  /** Seed user input for this turn. */
  seedEventId: EventId;
  /** Events emitted during this turn. */
  itemEventIds: EventId[];
  summary?: string;
}
