import type { ContextRef } from '@harness/core/actions.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type { EventId, ThreadId } from '@harness/core/ids.js';
import {
  COMPACTED_SUMMARY_CACHE_TAG,
  PINNED_MEMORY_CACHE_TAG,
  type ProjectedItem,
  type SamplingRequest,
  type StablePrefix,
  type ToolSpec,
} from '@harness/llm/provider.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import type { ToolRegistry } from '@harness/tools/registry.js';
import { toToolSpec } from '@harness/tools/tool.js';

import type { HandleRegistry } from './handleRegistry.js';
import { estimateTokens, projectEvents, type PruningOptions } from './pruning.js';

/**
 * Context projection: append-only SessionStore → SamplingRequest the
 * provider consumes.
 *
 * Inputs:
 *   - thread id
 *   - stable prefix metadata (system prompt, pinned memory, summary)
 *   - tool registry (for tool specs)
 *   - handle registry (for elision + restore semantics)
 *   - last compaction checkpoint (events before checkpoint are skipped)
 *
 * Output is pure + deterministic given inputs. Tests can assert on the
 * exact ProjectedItem list for a given event log.
 */

export interface ProjectionInputs {
  threadId: ThreadId;
  store: SessionStore;
  registry: ToolRegistry;
  handles: HandleRegistry;
  systemPrompt: string;
  pinnedMemory: string[];
  compactedSummary?: string;
  /** Events with eventId ≤ this are replaced by the summary. */
  compactionCheckpointEventId?: EventId;
  /**
   * COW slices of other threads' event logs to prepend before this
   * thread's tail. Source events render verbatim (preserving their
   * original cacheTag / id). See `core/actions.ts:ContextRef`.
   */
  contextRefs?: ContextRef[];
  pruning?: PruningOptions;
}

export interface ProjectionOutput {
  request: SamplingRequest;
  stats: {
    eventCount: number;
    projectedItems: number;
    estimatedTokens: number;
    elidedCount: number;
    pinnedHandles: number;
  };
}

export async function buildSamplingRequest(
  input: ProjectionInputs,
): Promise<ProjectionOutput> {
  const all = await input.store.readAll(input.threadId);
  const sliced = sliceAfterCheckpoint(all, input.compactionCheckpointEventId);
  const visible = filterRolledBack(sliced);

  const refEvents: HarnessEvent[] = [];
  if (input.contextRefs && input.contextRefs.length > 0) {
    for (const ref of input.contextRefs) {
      const slice = await readRefSlice(input.store, ref);
      refEvents.push(...filterRolledBack(slice));
    }
  }

  const projected = projectEvents([...refEvents, ...visible], {
    ...(input.pruning ?? {}),
    handles: input.handles,
  });

  const toolSpecs: ToolSpec[] = input.registry.list().map(toToolSpec);

  const prefix: StablePrefix = {
    systemPrompt: input.systemPrompt,
    tools: toolSpecs,
  };

  // Synthetic head-of-tail items: pinned memory + compacted summary.
  // Living in the tail (rather than folded into the system message)
  // keeps `prefix` byte-stable across pin/unpin and compaction events,
  // so the provider's prompt-cache prefix stays valid. Each carries a
  // dedicated cacheTag so explicit-marker providers can seal them as
  // their own cache breakpoints.
  const head: ProjectedItem[] = [];
  if (input.pinnedMemory.length > 0) {
    head.push({
      role: 'user',
      cacheTag: PINNED_MEMORY_CACHE_TAG,
      content: [
        {
          kind: 'text',
          text: ['[pinned memory]', ...input.pinnedMemory.map((m) => `- ${m}`)].join('\n'),
        },
      ],
    });
  }
  if (input.compactedSummary !== undefined) {
    head.push({
      role: 'user',
      cacheTag: COMPACTED_SUMMARY_CACHE_TAG,
      content: [
        {
          kind: 'text',
          text: ['[prior conversation summary]', input.compactedSummary].join('\n'),
        },
      ],
    });
  }
  const tail = head.length > 0 ? [...head, ...projected] : projected;

  const elidedCount = tail.filter((p) => p.content.some((c) => c.kind === 'elided')).length;

  const request: SamplingRequest = {
    prefix,
    tail,
  };

  return {
    request,
    stats: {
      eventCount: visible.length,
      projectedItems: tail.length,
      estimatedTokens: estimateTokens(tail),
      elidedCount,
      pinnedHandles: input.handles.pinnedHandles.length,
    },
  };
}

async function readRefSlice(
  store: SessionStore,
  ref: ContextRef,
): Promise<HarnessEvent[]> {
  const all = await store.readAll(ref.sourceThreadId);
  let from = 0;
  if (ref.fromEventId) {
    const idx = all.findIndex((e) => e.id === ref.fromEventId);
    from = idx < 0 ? 0 : idx;
  }
  let to = all.length;
  if (ref.toEventId) {
    const idx = all.findIndex((e) => e.id === ref.toEventId);
    if (idx >= 0) to = idx + 1;
  }
  return all.slice(from, to);
}

/**
 * Walks `contextRefs` and copies every active elision handle into the
 * child's HandleRegistry, so `restore(handle)` works on source-side
 * elided events the child sees through projection. The original
 * payload still lives in the source event itself; the registry entry
 * is just the in-memory mirror.
 */
export async function copyHandlesForRefs(
  store: SessionStore,
  refs: readonly ContextRef[],
  handles: HandleRegistry,
): Promise<void> {
  for (const ref of refs) {
    const slice = await readRefSlice(store, ref);
    for (const ev of slice) {
      if (!ev.elided) continue;
      handles.registerWithRef(ev.elided.handle, ev.elided.kind, ev.payload, ev.elided.meta);
    }
  }
}

function sliceAfterCheckpoint(
  events: readonly HarnessEvent[],
  checkpoint?: EventId,
): HarnessEvent[] {
  if (!checkpoint) return [...events];
  const idx = events.findIndex((e) => e.id === checkpoint);
  if (idx < 0) return [...events];
  return events.slice(idx + 1);
}

function filterRolledBack(events: readonly HarnessEvent[]): HarnessEvent[] {
  // Collect ranges covered by rollback_marker events, then drop anything
  // in those ranges (except the markers themselves, which are removed too).
  const rolled = new Set<EventId>();
  for (const ev of events) {
    if (ev.kind === 'rollback_marker') {
      const p = ev.payload as { fromEventId: EventId; toEventId: EventId };
      let inRange = false;
      for (const candidate of events) {
        if (candidate.id === p.fromEventId) inRange = true;
        if (inRange) rolled.add(candidate.id);
        if (candidate.id === p.toEventId) inRange = false;
      }
      rolled.add(ev.id);
    }
  }
  return events.filter((e) => !rolled.has(e.id));
}

export type { PruningOptions };
