import type { EventBus } from '@harness/bus/eventBus.js';
import type { ThreadId } from '@harness/core/ids.js';

import type { DiagSink } from './types.js';

export * from './types.js';
export * from './jsonlSink.js';
export * from './stderrSink.js';

/**
 * Attach a set of sinks to a bus for the lifetime of a root thread.
 * Returns a stop() handle that unsubscribes and closes every sink.
 *
 * Callers can use `threadId` to filter only a specific thread (otherwise
 * the sinks see every event on the bus, including subagents — which is
 * usually what you want for debugging).
 */
export interface AttachDiagOptions {
  bus: EventBus;
  sinks: DiagSink[];
  threadId?: ThreadId;
}

export function attachDiag(opts: AttachDiagOptions): { stop: () => Promise<void> } {
  const subs = opts.sinks.map((sink) =>
    opts.bus.subscribe((ev) => sink.onEvent(ev), {
      ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
    }),
  );
  return {
    stop: async () => {
      for (const s of subs) s.unsubscribe();
      for (const sink of opts.sinks) await sink.close();
    },
  };
}

/**
 * Compose sinks into a single `onPromptBuilt` suitable for AgentRunner.
 * The runner takes exactly one promp callback, so we fan out here.
 * The first returned path (if any) becomes the value persisted on
 * sampling_complete.promptDumpPath.
 */
export function composePromptHook(
  sinks: DiagSink[],
): (
  ctx: Parameters<DiagSink['onPrompt']>[0],
  request: Parameters<DiagSink['onPrompt']>[1],
  stats: Parameters<DiagSink['onPrompt']>[2],
) => Promise<string | undefined> {
  return async (ctx, request, stats) => {
    let canonical: string | undefined;
    for (const sink of sinks) {
      const result = await sink.onPrompt(ctx, request, stats);
      if (canonical === undefined && typeof result === 'string') canonical = result;
    }
    return canonical;
  };
}
