import { describe, it, expect } from 'vitest';

import { ActiveTurn } from '@harness/runtime/activeTurn.js';
import { newEventId, newThreadId, newTurnId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';

function fakeEvent(kind: HarnessEvent['kind'] = 'reply'): HarnessEvent {
  return {
    id: newEventId(),
    threadId: newThreadId(),
    kind,
    payload: { text: 'x' },
    createdAt: new Date().toISOString(),
  } as HarnessEvent;
}

describe('ActiveTurn', () => {
  it('transitions through running → completed', () => {
    const t = new ActiveTurn(newThreadId(), newTurnId());
    expect(t.state.kind).toBe('pending');
    t.toRunning();
    expect(t.state.kind).toBe('running');
    t.toCompleted('done');
    expect(t.state.kind).toBe('completed');
    expect(t.isTerminal()).toBe(true);
    // completion flips the phase so subsequent deliveries land on next turn.
    expect(t.phase).toBe('NextTurn');
  });

  it('drainCurrentTurn drains only current-turn deliveries', () => {
    const t = new ActiveTurn(newThreadId(), newTurnId());
    t.setPhase('CurrentTurn');
    t.deliver(fakeEvent('tool_result'));
    t.setPhase('NextTurn');
    t.deliver(fakeEvent('user_input'));
    const drained = t.drainCurrentTurn();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.phase).toBe('CurrentTurn');
    expect(t.drainNextTurn()).toHaveLength(1);
    expect(t.mailboxSize).toBe(0);
  });

  it('tracks interrupt flag', () => {
    const t = new ActiveTurn(newThreadId(), newTurnId());
    t.deliver(fakeEvent('interrupt'), { interrupt: true });
    expect(t.hasInterrupt).toBe(true);
  });
});
