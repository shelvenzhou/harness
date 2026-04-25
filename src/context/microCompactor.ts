import type {
  CompactionEventPayload,
  HarnessEvent,
  ToolCallPayload,
  ToolResultPayload,
} from '@harness/core/events.js';
import type { EventId, ThreadId } from '@harness/core/ids.js';
import type { SessionStore } from '@harness/store/sessionStore.js';

import type { HandleRegistry } from './handleRegistry.js';

/**
 * Hot-path micro-compaction with a sliding window.
 *
 * Runs deterministically (no LLM call) at the start of every sampling
 * step. See design-docs/04-context.md → "Level 1.5".
 *
 * Window model on the event log:
 *
 *   [ cold (already compacted) | warm (this pass) | hot tail (untouched) ]
 *                               ↑                  ↑
 *                               checkpoint         -keepRecent
 *
 * For each tool_result in the warm zone whose serialised body exceeds
 * `minBytes` and is not yet elided, we register a handle for the full
 * payload, attach an elision pointing at it, and let the existing
 * pruning + restore machinery handle the rest.
 */

export interface MicroCompactorOptions {
  /** Events at the tail kept fully verbatim. */
  keepRecent?: number;
  /** Minimum new events past the previous checkpoint before a pass runs. */
  triggerEvery?: number;
  /** Tool_results below this serialised byte size are left inline. */
  minBytes?: number;
  /**
   * If true, append a `compaction_event` to the store on each non-empty
   * pass so the diag layer can render what changed. Default true.
   */
  emitCompactionEvent?: boolean;
}

const DEFAULTS: Required<MicroCompactorOptions> = {
  keepRecent: 20,
  triggerEvery: 10,
  minBytes: 256,
  emitCompactionEvent: true,
};

export interface MicroCompactionResult {
  ran: boolean;
  /** Number of tool_result events compacted in this pass. */
  compactedCount: number;
  /** Highest index in the events array that has been compacted through. */
  newCheckpointIndex: number;
}

export class MicroCompactor {
  private readonly opts: Required<MicroCompactorOptions>;
  private checkpointIndex = 0;
  private totalAtLastPass = 0;

  constructor(opts: MicroCompactorOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /**
   * Inspect the event log and run a pass if conditions are met.
   * Idempotent — repeated calls without enough new events are no-ops.
   */
  async maybeRun(
    threadId: ThreadId,
    store: SessionStore,
    handles: HandleRegistry,
  ): Promise<MicroCompactionResult> {
    const events = await store.readAll(threadId);
    const total = events.length;

    const sinceLast = total - this.totalAtLastPass;
    if (sinceLast < this.opts.triggerEvery) {
      return { ran: false, compactedCount: 0, newCheckpointIndex: this.checkpointIndex };
    }

    const tailBoundary = Math.max(0, total - this.opts.keepRecent);
    if (tailBoundary <= this.checkpointIndex) {
      // Not enough non-tail events yet to compact anything.
      this.totalAtLastPass = total;
      return { ran: false, compactedCount: 0, newCheckpointIndex: this.checkpointIndex };
    }

    // Build a name lookup: toolCallId -> tool name from preceding tool_call.
    const toolNameByCallId = new Map<string, string>();
    for (let i = 0; i < tailBoundary; i++) {
      const ev = events[i]!;
      if (ev.kind === 'tool_call') {
        const p = ev.payload as ToolCallPayload;
        toolNameByCallId.set(p.toolCallId, p.name);
      }
    }

    let compacted = 0;
    for (let i = this.checkpointIndex; i < tailBoundary; i++) {
      const ev = events[i]!;
      if (ev.kind !== 'tool_result') continue;
      if (ev.elided) continue;
      const p = ev.payload as ToolResultPayload;
      const body = p.ok ? (p.output ?? null) : { error: p.error };
      const json = JSON.stringify(body);
      if (json.length < this.opts.minBytes) continue;

      const toolName = toolNameByCallId.get(p.toolCallId) ?? 'tool';
      const summary = buildSummary(toolName, p, json.length);
      const handle = handles.register('micro_compact', body, {
        toolCallId: p.toolCallId,
        toolName,
        bytes: json.length,
      });
      await store.attachElision(threadId, ev.id, {
        handle,
        kind: 'micro_compact',
        meta: {
          toolName,
          bytes: json.length,
          summary,
          ok: p.ok,
        },
      });
      compacted += 1;
    }

    this.checkpointIndex = tailBoundary;
    this.totalAtLastPass = total;

    if (compacted > 0 && this.opts.emitCompactionEvent) {
      const payload: CompactionEventPayload = {
        reason: 'auto',
        tokensBefore: 0,
        tokensAfter: 0,
        durationMs: 0,
        retainedUserTurns: 0,
        ghostSnapshotCount: 0,
      };
      await store.append({
        threadId,
        kind: 'compaction_event',
        payload,
      });
    }

    return { ran: true, compactedCount: compacted, newCheckpointIndex: tailBoundary };
  }

  /** Rewind state for a fresh thread; primarily for tests. */
  reset(): void {
    this.checkpointIndex = 0;
    this.totalAtLastPass = 0;
  }

  get checkpoint(): number {
    return this.checkpointIndex;
  }
}

function buildSummary(toolName: string, p: ToolResultPayload, bytes: number): string {
  const parts: string[] = [`[${toolName}`];
  parts.push(p.ok ? 'ok' : 'err');
  parts.push(`${bytes}b`);
  if (!p.ok && p.error) parts.push(`kind=${p.error.kind}`);
  if (p.ok && typeof p.output === 'object' && p.output !== null) {
    const o = p.output as Record<string, unknown>;
    if (typeof o.exitCode === 'number') parts.push(`exit=${o.exitCode}`);
    if (typeof o.status === 'number') parts.push(`status=${o.status}`);
    if (typeof o.path === 'string') parts.push(`path=${o.path}`);
    if (typeof o.url === 'string') parts.push(`url=${o.url}`);
  }
  return parts.join(' ') + ']';
}

// Used by EventId-typed callers; re-export to avoid unused import warnings.
export type { EventId };
