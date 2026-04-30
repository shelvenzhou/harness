import type { Action, EventSpec } from '@harness/core/actions.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type { ThreadId, TurnId } from '@harness/core/ids.js';

/**
 * ActiveTurn — explicit state machine for the currently-running turn on a
 * thread. Borrowed directly from Codex (`codex-rs/core/src/state/turn.rs`).
 *
 * Why: without this, "is the turn done?" has to be recomputed from the
 * event log on every tick. With it, we have an authoritative answer, a
 * well-defined place to attach pending work, and a mailbox with explicit
 * delivery phases.
 */

export type TurnState =
  | { kind: 'pending' } // created, not yet sampled
  | { kind: 'running'; samplingCount: number }
  | { kind: 'awaiting_subtask'; childThreadId: ThreadId }
  | { kind: 'awaiting_event'; spec: EventSpec; timerId?: string }
  | { kind: 'completed'; summary?: string }
  | { kind: 'interrupted'; reason?: string }
  | { kind: 'errored'; error: string };

/**
 * Phase controls whether async deliveries land in the current turn's
 * mailbox or are queued for the next turn. Matches Codex's
 * `MailboxDeliveryPhase`.
 */
export type MailboxPhase = 'CurrentTurn' | 'NextTurn';

export interface QueuedDelivery {
  event: HarnessEvent;
  phase: MailboxPhase;
  /** If true, the delivery should preempt an in-flight sampling. */
  interrupt?: boolean;
}

export class ActiveTurn {
  private _state: TurnState = { kind: 'pending' };
  private _mailbox: QueuedDelivery[] = [];
  private _actionsInFlight: Action[] = [];
  private _phase: MailboxPhase = 'CurrentTurn';

  constructor(
    readonly threadId: ThreadId,
    readonly turnId: TurnId,
  ) {}

  get state(): TurnState {
    return this._state;
  }

  get phase(): MailboxPhase {
    return this._phase;
  }

  setPhase(phase: MailboxPhase): void {
    this._phase = phase;
  }

  /** Enqueue an async delivery to be drained at the next tick boundary. */
  deliver(event: HarnessEvent, opts: { interrupt?: boolean } = {}): void {
    this._mailbox.push({
      event,
      phase: this._phase,
      ...(opts.interrupt !== undefined ? { interrupt: opts.interrupt } : {}),
    });
  }

  /** Drain only the deliveries targeted at the current turn. */
  drainCurrentTurn(): QueuedDelivery[] {
    const current = this._mailbox.filter((d) => d.phase === 'CurrentTurn');
    this._mailbox = this._mailbox.filter((d) => d.phase !== 'CurrentTurn');
    return current;
  }

  /** Drain deliveries destined for the next turn (called when this turn ends). */
  drainNextTurn(): QueuedDelivery[] {
    const next = this._mailbox.filter((d) => d.phase === 'NextTurn');
    this._mailbox = this._mailbox.filter((d) => d.phase !== 'NextTurn');
    return next;
  }

  get mailboxSize(): number {
    return this._mailbox.length;
  }

  /** True if any queued delivery asks for an interrupt. */
  get hasInterrupt(): boolean {
    return this._mailbox.some((d) => d.interrupt === true);
  }

  // ─── transitions ────────────────────────────────────────────────────────

  toRunning(): void {
    const prev = this._state.kind === 'running' ? this._state.samplingCount : 0;
    this._state = { kind: 'running', samplingCount: prev + 1 };
  }

  toAwaitingSubtask(childThreadId: ThreadId): void {
    this._state = { kind: 'awaiting_subtask', childThreadId };
  }

  toAwaitingEvent(spec: EventSpec, timerId?: string): void {
    this._state = { kind: 'awaiting_event', spec, ...(timerId !== undefined ? { timerId } : {}) };
  }

  toCompleted(summary?: string): void {
    this._state = { kind: 'completed', ...(summary !== undefined ? { summary } : {}) };
    this._phase = 'NextTurn';
  }

  toInterrupted(reason?: string): void {
    this._state = { kind: 'interrupted', ...(reason !== undefined ? { reason } : {}) };
    this._phase = 'NextTurn';
  }

  toErrored(error: string): void {
    this._state = { kind: 'errored', error };
    this._phase = 'NextTurn';
  }

  // ─── terminal check ─────────────────────────────────────────────────────

  isTerminal(): boolean {
    return (
      this._state.kind === 'completed' ||
      this._state.kind === 'interrupted' ||
      this._state.kind === 'errored'
    );
  }

  // ─── action bookkeeping ─────────────────────────────────────────────────

  pushActionInFlight(action: Action): void {
    this._actionsInFlight.push(action);
  }

  clearActionsInFlight(): void {
    this._actionsInFlight = [];
  }

  get actionsInFlight(): readonly Action[] {
    return this._actionsInFlight;
  }
}
