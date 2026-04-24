import type { HarnessEvent } from '@harness/core/events.js';
import type { EventId, ThreadId } from '@harness/core/ids.js';

/**
 * Compactor interface. Phase 1 ships a stub StaticCompactor; the real
 * compactor is itself a subagent (`spawn({role: 'compactor', …})`) and
 * lands in phase 2.
 */

export interface CompactedSummary {
  reinject: { systemReinject: string; environment?: string };
  summary: string;
  recentUserTurns: UserTurnExcerpt[];
  ghostSnapshots: GhostSnapshot[];
  activeHandles: string[];
}

export interface UserTurnExcerpt {
  turnId: string;
  text: string;
}

export interface GhostSnapshot {
  kind: string;
  payload: unknown;
}

export interface CompactionRequest {
  threadId: ThreadId;
  events: HarnessEvent[];
  /** Last K user turns to preserve verbatim. */
  keepLastUserTurns: number;
}

export interface CompactionResult {
  summary: CompactedSummary;
  atEventId: EventId;
  tokensBefore: number;
  tokensAfter: number;
  durationMs: number;
}

export interface Compactor {
  compact(req: CompactionRequest): Promise<CompactionResult>;
}

/**
 * Static / trivial compactor. Replaces every item before the last K user
 * turns with a placeholder summary. Good enough for phase 1 smoke tests
 * that only need to *exercise the pipeline* — real summarisation lands in
 * phase 2 as a subagent spawn.
 */
export class StaticCompactor implements Compactor {
  async compact(req: CompactionRequest): Promise<CompactionResult> {
    const t0 = Date.now();
    const userTurns = req.events.filter(
      (e) => e.kind === 'user_turn_start' || e.kind === 'user_input',
    );
    const keep = userTurns.slice(-req.keepLastUserTurns);
    const keepIds = new Set(keep.map((e) => e.id));
    const summarised = req.events.filter((e) => !keepIds.has(e.id));
    const excerpts: UserTurnExcerpt[] = keep.map((e) => ({
      turnId: e.turnId ?? e.id,
      text: (e.payload as { text: string }).text,
    }));

    const atEvent = req.events.find((e) => !keepIds.has(e.id));
    const atEventId = (atEvent?.id ??
      req.events[req.events.length - 1]?.id ??
      ('' as EventId)) as EventId;

    return {
      summary: {
        reinject: {
          systemReinject: '(no extra system reinjection)',
        },
        summary:
          summarised.length === 0
            ? '(no prior content)'
            : `(stub summary of ${summarised.length} prior events)`,
        recentUserTurns: excerpts,
        ghostSnapshots: [],
        activeHandles: [],
      },
      atEventId,
      tokensBefore: 0,
      tokensAfter: 0,
      durationMs: Date.now() - t0,
    };
  }
}
