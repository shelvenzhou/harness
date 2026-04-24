import type { HarnessEvent } from '@harness/core/events.js';
import type { EventId, ThreadId } from '@harness/core/ids.js';
import type {
  ProjectedItem,
  SamplingRequest,
  StablePrefix,
  ToolSpec,
} from '@harness/llm/provider.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import type { ToolRegistry } from '@harness/tools/registry.js';
import { toToolSpec } from '@harness/tools/tool.js';

import { HandleRegistry } from './handleRegistry.js';
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
  const tail = sliceAfterCheckpoint(all, input.compactionCheckpointEventId);
  const visible = filterRolledBack(tail);

  const projected = projectEvents(visible, {
    ...(input.pruning ?? {}),
    handles: input.handles,
  });

  const toolSpecs: ToolSpec[] = input.registry.list().map(toToolSpec);

  const prefix: StablePrefix = {
    systemPrompt: input.systemPrompt,
    pinnedMemory: input.pinnedMemory,
    ...(input.compactedSummary !== undefined ? { compactedSummary: input.compactedSummary } : {}),
    tools: toolSpecs,
  };

  const elidedCount = projected.filter((p) =>
    p.content.some((c) => c.kind === 'elided'),
  ).length;

  const request: SamplingRequest = {
    prefix,
    tail: projected,
  };

  return {
    request,
    stats: {
      eventCount: visible.length,
      projectedItems: projected.length,
      estimatedTokens: estimateTokens(projected),
      elidedCount,
      pinnedHandles: input.handles.pinnedHandles.length,
    },
  };
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
