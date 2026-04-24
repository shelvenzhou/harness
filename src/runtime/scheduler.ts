import type { ThreadId } from '@harness/core/ids.js';

/**
 * Timer scheduler. Emits `timer_fired` events via a callback so the runtime
 * can post them on the bus using its own envelope factory. Thin on purpose:
 * no cron yet, just one-shot delays.
 */

export interface ScheduleOptions {
  threadId: ThreadId;
  timerId: string;
  delayMs: number;
  tag?: string;
}

export type TimerFiredCallback = (opts: ScheduleOptions) => void;

export class Scheduler {
  private handles = new Map<string, NodeJS.Timeout>();

  constructor(private readonly onFire: TimerFiredCallback) {}

  schedule(opts: ScheduleOptions): void {
    this.cancel(opts.timerId);
    const handle = setTimeout(() => {
      this.handles.delete(opts.timerId);
      this.onFire(opts);
    }, opts.delayMs);
    // Don't hold the event loop open just because a timer is pending.
    if (typeof handle.unref === 'function') handle.unref();
    this.handles.set(opts.timerId, handle);
  }

  cancel(timerId: string): boolean {
    const handle = this.handles.get(timerId);
    if (!handle) return false;
    clearTimeout(handle);
    this.handles.delete(timerId);
    return true;
  }

  cancelAll(): void {
    for (const handle of this.handles.values()) clearTimeout(handle);
    this.handles.clear();
  }

  get pending(): number {
    return this.handles.size;
  }
}
