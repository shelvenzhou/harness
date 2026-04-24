import { newHandleRef } from '@harness/core/ids.js';
import type { HandleRef } from '@harness/core/ids.js';

/**
 * Handle registry — maps handle → payload, with metadata. Kept in-process
 * for phase 1; backed by SessionStore via `restore` later.
 *
 * The handle is issued when a tool's execute() calls ctx.registerHandle.
 * The projection layer enforces that the LLM sees the elided form by
 * default; `restore(handle)` flips a flag that inlines the body on the
 * next sampling.
 */

interface Entry {
  handle: HandleRef;
  kind: string;
  payload: unknown;
  meta: Record<string, unknown>;
  pinnedForNextSampling: boolean;
  createdAt: string;
}

export class HandleRegistry {
  private byHandle = new Map<HandleRef, Entry>();

  register(kind: string, payload: unknown, meta: Record<string, unknown> = {}): HandleRef {
    const handle = newHandleRef();
    this.byHandle.set(handle, {
      handle,
      kind,
      payload,
      meta,
      pinnedForNextSampling: false,
      createdAt: new Date().toISOString(),
    });
    return handle;
  }

  get(handle: HandleRef): Entry | undefined {
    return this.byHandle.get(handle);
  }

  has(handle: HandleRef): boolean {
    return this.byHandle.has(handle);
  }

  /** Mark this handle for inline rehydration on the next projection. */
  pinForNextSampling(handle: HandleRef): boolean {
    const e = this.byHandle.get(handle);
    if (!e) return false;
    e.pinnedForNextSampling = true;
    return true;
  }

  /** Clear pinning after a sampling completes. */
  clearPins(): void {
    for (const e of this.byHandle.values()) e.pinnedForNextSampling = false;
  }

  get pinnedHandles(): HandleRef[] {
    return [...this.byHandle.values()]
      .filter((e) => e.pinnedForNextSampling)
      .map((e) => e.handle);
  }

  get size(): number {
    return this.byHandle.size;
  }
}
