import type { EventId, ThreadId, ToolCallId } from './ids.js';

/**
 * Cross-thread context reference. Lets a spawned child see a slice of
 * another thread's event log without copying it physically. The child's
 * projection prepends the referenced ranges to its own tail; source
 * threads keep appending after the snapshot range without affecting
 * the child.
 *
 * Both bounds optional: omit `fromEventId` to start from the source's
 * first event, omit `toEventId` to include everything up to spawn time.
 * Replaces the older `inheritTurns: N` mechanism (never landed in
 * projection). See design-docs/04-context.md.
 */
export interface ContextRef {
  sourceThreadId: ThreadId;
  fromEventId?: EventId;
  toEventId?: EventId;
}

/**
 * Action envelope — what AgentRunner translates LLM sampling output into.
 *
 * See design-docs/00-overview.md. All agent control flow is expressed as
 * sequences of Actions. The harness has no other notion of "what to do next".
 */

export type Action =
  | ReplyAction
  | PreambleAction
  | ToolCallAction
  | SpawnAction
  | WaitAction
  | DoneAction;

export interface ReplyAction {
  kind: 'reply';
  text: string;
  internal?: boolean;
  final?: boolean;
}

export interface PreambleAction {
  kind: 'preamble';
  text: string;
}

export interface ToolCallAction {
  kind: 'tool_call';
  toolCallId: ToolCallId;
  name: string;
  args: unknown;
}

export interface SpawnAction {
  kind: 'spawn';
  childThreadId: ThreadId;
  task: string;
  role?: string;
  budget: { maxTurns?: number; maxToolCalls?: number; maxWallMs?: number; maxTokens?: number };
  /**
   * Optional COW slices of other threads' event logs the child should
   * see prepended to its own tail. See `ContextRef`.
   */
  contextRefs?: ContextRef[];
}

/**
 * `wait` tells the runner to yield until an event matches `eventSpec`.
 * The runner translates this into ActiveTurn state; the next matching
 * event wakes the turn.
 */
export interface WaitAction {
  kind: 'wait';
  eventSpec: EventSpec;
  timeoutMs?: number;
}

export interface DoneAction {
  kind: 'done';
  status: 'completed' | 'errored';
  summary?: string;
}

export type EventSpec =
  | { matcher: 'kind'; kind: string }
  | { matcher: 'tool_result'; toolCallId: ToolCallId }
  | { matcher: 'subtask_complete'; childThreadId: ThreadId }
  | { matcher: 'user_input' }
  | { matcher: 'timer'; timerId: string }
  | {
      matcher: 'session';
      sessionIds: string[];
      mode: 'any' | 'all';
      /** Sessions still pending (mutated by the runner as session_complete events arrive). */
      remaining: Set<string>;
    };
