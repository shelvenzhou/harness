import type { ThreadId, ToolCallId } from './ids.js';

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
  budget: { maxTurns?: number; maxToolCalls?: number; maxWallMs?: number };
  inheritTurns?: number;
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
  | { matcher: 'timer'; timerId: string };
