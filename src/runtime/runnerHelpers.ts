import type { EventSpec } from '@harness/core/actions.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type { EventId, ThreadId, ToolCallId } from '@harness/core/ids.js';

import type { ActiveTurn } from './activeTurn.js';
import type { Session } from './sessionRegistry.js';

/**
 * Pure helpers split out of agentRunner.ts. No `this` references — they
 * read inputs and return results, so they live outside the class for
 * readability and isolated tests.
 */

export function shouldTriggerTick(ev: HarnessEvent): boolean {
  switch (ev.kind) {
    case 'user_turn_start':
    case 'user_input':
    case 'interrupt':
    case 'compact_request':
    case 'subtask_complete':
    case 'session_complete':
    case 'timer_fired':
    case 'external_event':
      return true;
    // tool_result no longer triggers a tick: dispatch is atomic now,
    // so the runner is the sole producer of tool_result events for its
    // thread and self-arms re-sampling explicitly via scheduleTick.
    default:
      return false;
  }
}

export function isReadyToSample(at: ActiveTurn): boolean {
  const s = at.state;
  if (s.kind === 'awaiting_event') return false;
  if (s.kind === 'awaiting_subtask') return false;
  if (s.kind === 'completed' || s.kind === 'interrupted' || s.kind === 'errored') return false;
  return true;
}

export function parseWaitSpec(rawArgs: unknown): EventSpec {
  const a = (rawArgs ?? {}) as Record<string, unknown>;
  const matcher = typeof a.matcher === 'string' ? a.matcher : 'kind';
  switch (matcher) {
    case 'tool_result':
      if (typeof a.toolCallId === 'string') {
        return { matcher: 'tool_result', toolCallId: a.toolCallId as ToolCallId };
      }
      break;
    case 'subtask_complete':
      if (typeof a.childThreadId === 'string') {
        return { matcher: 'subtask_complete', childThreadId: a.childThreadId as ThreadId };
      }
      break;
    case 'user_input':
      return { matcher: 'user_input' };
    case 'timer':
      if (typeof a.timerId === 'string') {
        return { matcher: 'timer', timerId: a.timerId };
      }
      break;
    case 'session': {
      const ids = Array.isArray(a.sessionIds)
        ? a.sessionIds.filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length > 0) {
        const mode = a.mode === 'all' ? 'all' : 'any';
        return {
          matcher: 'session',
          sessionIds: [...ids],
          mode,
          remaining: new Set(ids),
        };
      }
      break;
    }
    case 'kind':
      if (typeof a.kind === 'string') {
        return { matcher: 'kind', kind: a.kind };
      }
      break;
  }
  // Permissive fallback: any external_event wakes the turn. Without this,
  // a malformed wait would deadlock the turn until interrupt.
  return { matcher: 'kind', kind: 'external_event' };
}

export function eventMatchesSpec(ev: HarnessEvent, spec: EventSpec): boolean {
  switch (spec.matcher) {
    case 'kind':
      return ev.kind === spec.kind;
    case 'tool_result':
      return ev.kind === 'tool_result' && ev.payload.toolCallId === spec.toolCallId;
    case 'subtask_complete':
      return ev.kind === 'subtask_complete' && ev.payload.childThreadId === spec.childThreadId;
    case 'user_input':
      return ev.kind === 'user_input' || ev.kind === 'user_turn_start';
    case 'timer':
      return ev.kind === 'timer_fired' && ev.payload.timerId === spec.timerId;
    case 'session': {
      // Stateful: remove the completing session from `remaining` and
      // wake when the gate is satisfied. The runner mutates the spec
      // because it lives on ActiveTurn.state — same instance both here
      // and after wake-up.
      if (ev.kind !== 'session_complete') return false;
      if (!spec.remaining.has(ev.payload.sessionId)) return false;
      spec.remaining.delete(ev.payload.sessionId);
      if (spec.mode === 'all') return spec.remaining.size === 0;
      return true;
    }
  }
}

export function synthEvent(threadId: ThreadId, reason: string): HarnessEvent {
  // Private sentinel; never published. Used to re-arm tick from the runner.
  return {
    id: ('evt_synth_' + reason) as EventId,
    threadId,
    kind: 'external_event',
    payload: { source: 'runner', data: { reason } },
    createdAt: new Date().toISOString(),
  } as HarnessEvent;
}

export function formatPinnedEntry(e: { key?: string; content: string }): string {
  return e.key ? `${e.key}: ${e.content}` : e.content;
}

/**
 * Cheap byte-based token estimate. We deliberately do *not* call into the
 * tokenizer here — the same crude proxy used elsewhere in the projection
 * stack is fine for telling the agent "you have N tokens worth of output".
 */
export function estimateTokens(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return Math.ceil(s.length / 4);
}

/**
 * Render the session's captured output for the `session` tool. Truncates
 * the *string form* to `maxTokens * 4` bytes and reports whether truncation
 * happened along with the full token estimate, so the agent can decide
 * whether to widen the window or grep over the captured handle.
 */
export function renderSessionOutput(
  s: Session,
  maxTokens: number,
): { output: string | undefined; totalTokens: number; truncated: boolean } {
  if (s.output === undefined) {
    return { output: undefined, totalTokens: 0, truncated: false };
  }
  const full = typeof s.output === 'string' ? s.output : JSON.stringify(s.output);
  const totalTokens = Math.ceil(full.length / 4);
  const cap = maxTokens * 4;
  if (full.length <= cap) {
    return { output: full, totalTokens, truncated: false };
  }
  return { output: full.slice(0, cap), totalTokens, truncated: true };
}
