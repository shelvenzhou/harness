import type { ContextRef } from './actions.js';
import type { EventId, HandleRef, ThreadId, ToolCallId, TurnId } from './ids.js';

/**
 * Event envelope + kind discriminators.
 *
 * See design-docs/02-events-and-state.md. Every Item persisted to the
 * SessionStore is also broadcast on the EventBus with this shape.
 */

export type EventKind =
  // control-plane
  | 'user_turn_start'
  | 'user_input'
  | 'interrupt'
  | 'rollback'
  | 'fork'
  | 'compact_request'
  | 'shutdown'
  // data-plane
  | 'reply'
  | 'preamble'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'spawn_request'
  | 'subtask_complete'
  | 'timer_fired'
  | 'external_event'
  | 'session_complete'
  | 'turn_complete'
  | 'sampling_complete'
  | 'compaction_event'
  | 'rollback_marker';

export interface ElidedMeta {
  handle: HandleRef;
  kind: string;
  meta: Record<string, unknown>;
}

export interface EventBase<K extends EventKind, P> {
  id: EventId;
  threadId: ThreadId;
  turnId?: TurnId;
  parentTraceparent?: string;
  kind: K;
  payload: P;
  createdAt: string; // ISO-8601
  elided?: ElidedMeta;
}

// ─── control-plane payloads ────────────────────────────────────────────────

export interface UserTurnStartPayload {
  text: string;
  attachments?: Array<{ kind: string; ref: string }>;
}
export type UserTurnStartEvent = EventBase<'user_turn_start', UserTurnStartPayload>;

export interface UserInputPayload {
  text: string;
  interrupt?: boolean;
}
export type UserInputEvent = EventBase<'user_input', UserInputPayload>;

export interface InterruptPayload {
  reason?: string;
}
export type InterruptEvent = EventBase<'interrupt', InterruptPayload>;

export interface RollbackPayload {
  turns: number;
}
export type RollbackEvent = EventBase<'rollback', RollbackPayload>;

export interface ForkPayload {
  sourceThreadId: ThreadId;
  uptoEventId?: EventId;
  newThreadId: ThreadId;
}
export type ForkEvent = EventBase<'fork', ForkPayload>;

export interface CompactRequestPayload {
  reason: 'manual' | 'tool-change' | 'threshold' | 'stale-turn';
}
export type CompactRequestEvent = EventBase<'compact_request', CompactRequestPayload>;

export type ShutdownEvent = EventBase<'shutdown', Record<string, never>>;

// ─── data-plane payloads ───────────────────────────────────────────────────

export interface ReplyPayload {
  text: string;
  internal?: boolean;
  final?: boolean; // marks the last reply chunk of a turn
}
export type ReplyEvent = EventBase<'reply', ReplyPayload>;

export interface PreamblePayload {
  text: string;
}
export type PreambleEvent = EventBase<'preamble', PreamblePayload>;

export interface ReasoningPayload {
  text: string;
}
export type ReasoningEvent = EventBase<'reasoning', ReasoningPayload>;

export interface ToolCallPayload {
  toolCallId: ToolCallId;
  name: string;
  args: unknown;
}
export type ToolCallEvent = EventBase<'tool_call', ToolCallPayload>;

export interface ToolResultPayload {
  toolCallId: ToolCallId;
  ok: boolean;
  output?: unknown;
  error?: { kind: string; message: string; retryable?: boolean };
  originalBytes?: number;
  bytesSent?: number;
}
export type ToolResultEvent = EventBase<'tool_result', ToolResultPayload>;

export interface SpawnRequestPayload {
  childThreadId: ThreadId;
  role?: string;
  task: string;
  contextRefs?: ContextRef[];
  budget: { maxTurns?: number; maxToolCalls?: number; maxWallMs?: number; maxTokens?: number };
}
export type SpawnRequestEvent = EventBase<'spawn_request', SpawnRequestPayload>;

export interface SubtaskBudgetPayload {
  reason: 'maxTurns' | 'maxToolCalls' | 'maxWallMs' | 'maxTokens';
  turnsUsed: number;
  toolCallsUsed: number;
  tokensUsed: number;
}

export interface SubtaskCompletePayload {
  childThreadId: ThreadId;
  status: 'completed' | 'errored' | 'budget_exceeded' | 'interrupted';
  summary?: string;
  reason?: string;
  budget?: SubtaskBudgetPayload;
}
export type SubtaskCompleteEvent = EventBase<'subtask_complete', SubtaskCompletePayload>;

export interface TimerFiredPayload {
  timerId: string;
  tag?: string;
}
export type TimerFiredEvent = EventBase<'timer_fired', TimerFiredPayload>;

export interface ExternalEventPayload {
  source: string;
  data: unknown;
}
export type ExternalEventEvent = EventBase<'external_event', ExternalEventPayload>;

/**
 * A long-running tool ("session tool") finished. The tool_call/tool_result
 * pair was already persisted atomically with `{sessionId, status:'running'}`
 * back when dispatch ran; this event signals the session moved to a
 * terminal state so the agent can read it via the `session` tool or wake
 * a `wait({matcher:'session'})`. Sessions live in-memory in the runner's
 * SessionRegistry — this event is the persisted record.
 */
export interface SessionCompletePayload {
  sessionId: string;
  toolName: string;
  ok: boolean;
  /** Total tokens of the captured output (full, before truncation). */
  totalTokens?: number;
  error?: { kind: string; message: string };
}
export type SessionCompleteEvent = EventBase<'session_complete', SessionCompletePayload>;

export interface TurnCompletePayload {
  status: 'completed' | 'interrupted' | 'errored';
  summary?: string;
  reason?: string;
}
export type TurnCompleteEvent = EventBase<'turn_complete', TurnCompletePayload>;

export interface SamplingCompletePayload {
  samplingIndex: number;
  providerId: string;
  model?: string;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  wallMs: number;
  ttftMs?: number;
  stopReason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'error';
  projection: {
    projectedItems: number;
    elidedCount: number;
    estimatedTokens: number;
    pinnedHandles: number;
  };
  toolCallCount: number;
  promptDumpPath?: string;
}
export type SamplingCompleteEvent = EventBase<'sampling_complete', SamplingCompletePayload>;

export interface CompactionEventPayload {
  reason: 'auto' | 'manual' | 'tool-change';
  tokensBefore: number;
  tokensAfter: number;
  durationMs: number;
  retainedUserTurns: number;
  ghostSnapshotCount: number;
}
export type CompactionEventEvent = EventBase<'compaction_event', CompactionEventPayload>;

export interface RollbackMarkerPayload {
  fromEventId: EventId;
  toEventId: EventId;
}
export type RollbackMarkerEvent = EventBase<'rollback_marker', RollbackMarkerPayload>;

// ─── union + narrowing helpers ─────────────────────────────────────────────

export type HarnessEvent =
  | UserTurnStartEvent
  | UserInputEvent
  | InterruptEvent
  | RollbackEvent
  | ForkEvent
  | CompactRequestEvent
  | ShutdownEvent
  | ReplyEvent
  | PreambleEvent
  | ReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | SpawnRequestEvent
  | SubtaskCompleteEvent
  | TimerFiredEvent
  | ExternalEventEvent
  | SessionCompleteEvent
  | TurnCompleteEvent
  | SamplingCompleteEvent
  | CompactionEventEvent
  | RollbackMarkerEvent;

export type EventOfKind<K extends EventKind> = Extract<HarnessEvent, { kind: K }>;

export const CONTROL_PLANE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'user_turn_start',
  'user_input',
  'interrupt',
  'rollback',
  'fork',
  'compact_request',
  'shutdown',
]);

export const DATA_PLANE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'reply',
  'preamble',
  'reasoning',
  'tool_call',
  'tool_result',
  'spawn_request',
  'subtask_complete',
  'timer_fired',
  'external_event',
  'session_complete',
  'turn_complete',
  'sampling_complete',
  'compaction_event',
  'rollback_marker',
]);

export function isControlPlane(e: HarnessEvent): boolean {
  return CONTROL_PLANE_KINDS.has(e.kind);
}
