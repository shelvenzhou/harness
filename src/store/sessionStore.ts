import type { EventId, ThreadId, TurnId } from '@harness/core/ids.js';
import { newEventId } from '@harness/core/ids.js';
import type {
  EventKind,
  HarnessEvent,
  ElidedMeta,
  EventOfKind,
} from '@harness/core/events.js';
import type { Thread } from '@harness/core/thread.js';

/**
 * Append-only event log, with thread-level metadata.
 *
 * Phase 1 ships an in-memory + optional JSONL backend. The interface is
 * narrow enough to swap in SQLite later without touching the runtime.
 *
 * Invariants:
 *   - append() is atomic per thread (single writer per thread in practice,
 *     since only one AgentRunner or adapter is permitted to mint events
 *     for a given thread at a time; the store does not enforce this but
 *     assumes it).
 *   - Event ids are monotonic only within a thread (we sort by index, not
 *     by event id string).
 */

export type AppendInput = Omit<HarnessEvent, 'id' | 'createdAt'> & {
  id?: EventId;
  createdAt?: string;
};

export interface SessionStore {
  createThread(thread: Omit<Thread, 'createdAt' | 'updatedAt' | 'status'> & {
    status?: Thread['status'];
  }): Promise<Thread>;
  getThread(threadId: ThreadId): Promise<Thread | undefined>;
  listThreads(): Promise<Thread[]>;
  updateThread(
    threadId: ThreadId,
    patch: Partial<Omit<Thread, 'id' | 'createdAt'>>,
  ): Promise<Thread>;

  append(event: AppendInput): Promise<HarnessEvent>;
  readAll(threadId: ThreadId): Promise<HarnessEvent[]>;
  readSince(threadId: ThreadId, afterEventId?: EventId): Promise<HarnessEvent[]>;
  getEvent(threadId: ThreadId, eventId: EventId): Promise<HarnessEvent | undefined>;

  /** For tool_result elision: attach handle metadata to a stored event. */
  attachElision(threadId: ThreadId, eventId: EventId, elided: ElidedMeta): Promise<void>;

  close(): Promise<void>;
}

// ─── in-memory implementation ──────────────────────────────────────────────

interface ThreadState {
  thread: Thread;
  events: HarnessEvent[];
  byId: Map<EventId, number>; // event id -> index
}

export class MemorySessionStore implements SessionStore {
  private threads = new Map<ThreadId, ThreadState>();

  async createThread(
    input: Omit<Thread, 'createdAt' | 'updatedAt' | 'status'> & { status?: Thread['status'] },
  ): Promise<Thread> {
    if (this.threads.has(input.id)) {
      throw new Error(`thread ${input.id} already exists`);
    }
    const now = new Date().toISOString();
    const thread: Thread = {
      ...input,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.threads.set(thread.id, { thread, events: [], byId: new Map() });
    return thread;
  }

  async getThread(threadId: ThreadId): Promise<Thread | undefined> {
    return this.threads.get(threadId)?.thread;
  }

  async listThreads(): Promise<Thread[]> {
    return [...this.threads.values()].map((s) => s.thread);
  }

  async updateThread(
    threadId: ThreadId,
    patch: Partial<Omit<Thread, 'id' | 'createdAt'>>,
  ): Promise<Thread> {
    const state = this.expectThread(threadId);
    state.thread = {
      ...state.thread,
      ...patch,
      id: state.thread.id,
      createdAt: state.thread.createdAt,
      updatedAt: new Date().toISOString(),
    };
    return state.thread;
  }

  async append(input: AppendInput): Promise<HarnessEvent> {
    const state = this.expectThread(input.threadId);
    const event: HarnessEvent = {
      ...input,
      id: input.id ?? newEventId(),
      createdAt: input.createdAt ?? new Date().toISOString(),
    } as HarnessEvent;
    state.byId.set(event.id, state.events.length);
    state.events.push(event);
    state.thread.updatedAt = event.createdAt;
    return event;
  }

  async readAll(threadId: ThreadId): Promise<HarnessEvent[]> {
    return [...this.expectThread(threadId).events];
  }

  async readSince(threadId: ThreadId, afterEventId?: EventId): Promise<HarnessEvent[]> {
    const state = this.expectThread(threadId);
    if (!afterEventId) return [...state.events];
    const idx = state.byId.get(afterEventId);
    if (idx === undefined) return [...state.events];
    return state.events.slice(idx + 1);
  }

  async getEvent(threadId: ThreadId, eventId: EventId): Promise<HarnessEvent | undefined> {
    const state = this.threads.get(threadId);
    if (!state) return undefined;
    const idx = state.byId.get(eventId);
    return idx === undefined ? undefined : state.events[idx];
  }

  async attachElision(threadId: ThreadId, eventId: EventId, elided: ElidedMeta): Promise<void> {
    const state = this.expectThread(threadId);
    const idx = state.byId.get(eventId);
    if (idx === undefined) throw new Error(`unknown event ${eventId} in thread ${threadId}`);
    const ev = state.events[idx]!;
    state.events[idx] = { ...ev, elided } as HarnessEvent;
  }

  async close(): Promise<void> {
    this.threads.clear();
  }

  private expectThread(threadId: ThreadId): ThreadState {
    const state = this.threads.get(threadId);
    if (!state) throw new Error(`unknown thread ${threadId}`);
    return state;
  }
}

// ─── convenience: filter helpers ───────────────────────────────────────────

export function eventsOfKind<K extends EventKind>(
  events: readonly HarnessEvent[],
  kind: K,
): EventOfKind<K>[] {
  return events.filter((e): e is EventOfKind<K> => e.kind === kind);
}

export function eventsForTurn(
  events: readonly HarnessEvent[],
  turnId: TurnId,
): HarnessEvent[] {
  return events.filter((e) => e.turnId === turnId);
}
