import { describe, it, expect } from 'vitest';

import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';

/**
 * Step 1 contract: `wait(matcher='timer', delayMs=...)` must actually
 * suspend the turn, schedule a real timer, publish `timer_fired` when it
 * elapses, and let the next sampling re-arm.
 *
 * Pre-fix the Scheduler was never instantiated, so `timer_fired` would
 * never come and the turn deadlocked until interrupt.
 */

interface Step {
  /** What this provider step yields when sampled. */
  deltas: SamplingDelta[];
  /** Wallclock at the moment sampling started (ms since epoch). */
  startedAt?: number;
}

class TimerProvider implements LlmProvider {
  readonly id = 'timer-test';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: true,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  public readonly steps: Step[];
  private i = 0;
  constructor(steps: Step[]) {
    this.steps = steps;
  }
  async *sample(_req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    const idx = this.i++;
    const step = this.steps[Math.min(idx, this.steps.length - 1)]!;
    step.startedAt = Date.now();
    for (const d of step.deltas) {
      if (signal.aborted) return;
      yield d;
    }
    if (!step.deltas.some((d) => d.kind === 'end')) yield { kind: 'end', stopReason: 'end_turn' };
  }
}

describe('runtime: wait(timer) wiring', () => {
  it('schedules a timer, publishes timer_fired, and resumes sampling', async () => {
    const provider = new TimerProvider([
      // Turn 1, step 1: emit a wait(timer) tool_call.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: 'tc_wait' as never, name: 'wait' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_wait' as never,
            args: { matcher: 'timer', timerId: 't_step1', delayMs: 80 },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Step 2: after the wait wakes, finish.
      {
        deltas: [
          { kind: 'text_delta', text: 'awoken', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      },
    ]);

    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'wait then reply' },
    });
    runtime.bus.publish(seed);

    // Wait for turn_complete with reasonable budget. Real wait is 80ms.
    const result = await new Promise<{ status: string; summary?: string }>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout: turn never completed')), 2_000);
        const sub = runtime.bus.subscribe(
          (ev) => {
            if (ev.kind === 'turn_complete') {
              clearTimeout(t);
              sub.unsubscribe();
              resolve({
                status: ev.payload.status,
                ...(ev.payload.summary !== undefined ? { summary: ev.payload.summary } : {}),
              });
            }
          },
          { threadId: runtime.rootThreadId },
        );
      },
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('awoken');

    // Both samplings ran, with a real ~80ms wall gap between them.
    expect(provider.steps[0]!.startedAt).toBeDefined();
    expect(provider.steps[1]!.startedAt).toBeDefined();
    const gap = provider.steps[1]!.startedAt! - provider.steps[0]!.startedAt!;
    // Generous lower bound to avoid CI flake; we only need to prove the
    // timer actually slept rather than firing immediately.
    expect(gap).toBeGreaterThanOrEqual(60);

    // The store has a real timer_fired envelope between the two
    // sampling_complete events.
    const events = await runtime.store.readAll(runtime.rootThreadId);
    const timerFired = events.find((e) => e.kind === 'timer_fired');
    expect(timerFired).toBeDefined();
    expect((timerFired!.payload as { timerId: string }).timerId).toBe('t_step1');
  });

  it('rejects timer wait without delayMs and surfaces the error in the tool_result', async () => {
    const provider = new TimerProvider([
      // Step 1: malformed timer wait — no delayMs.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: 'tc_bad' as never, name: 'wait' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_bad' as never,
            args: { matcher: 'timer', timerId: 't_bad' },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      // Step 2: should not run because the wait deadlocks. We supply it
      // anyway in case the rules change.
      {
        deltas: [
          { kind: 'text_delta', text: 'should not run', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      },
    ]);

    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });

    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'malformed timer' },
    });
    runtime.bus.publish(seed);

    // Give the runner time to dispatch the wait.
    await new Promise((r) => setTimeout(r, 200));

    const events = await runtime.store.readAll(runtime.rootThreadId);
    const toolResult = events.find(
      (e) =>
        e.kind === 'tool_result' &&
        (e.payload as { toolCallId: string }).toolCallId === 'tc_bad',
    );
    expect(toolResult).toBeDefined();
    const out = toolResult!.payload as { ok: boolean; output: { scheduled: boolean; error?: string } };
    // The tool_result is still ok=true (matcher was accepted) but
    // scheduled=false with an error string the model can react to.
    expect(out.ok).toBe(true);
    expect(out.output.scheduled).toBe(false);
    expect(out.output.error).toMatch(/delayMs/);

    // Crucially: the second sampling did NOT run, because the wait is
    // suspended awaiting a timer that was never scheduled.
    expect(provider.steps[1]!.startedAt).toBeUndefined();
  });

  it('honours timeoutMs as a fallback wakeup', async () => {
    const provider = new TimerProvider([
      // Step 1: wait on user_input but cap it at 80ms — there is no user
      // around, so we expect the timeout to fire and wake the turn via
      // external_event{source:"wait_timeout"}.
      {
        deltas: [
          { kind: 'tool_call_begin', toolCallId: 'tc_to' as never, name: 'wait' },
          {
            kind: 'tool_call_end',
            toolCallId: 'tc_to' as never,
            args: { matcher: 'user_input', timeoutMs: 80 },
          },
          { kind: 'end', stopReason: 'tool_use' },
        ],
      },
      {
        deltas: [
          { kind: 'text_delta', text: 'gave up', channel: 'reply' },
          { kind: 'end', stopReason: 'end_turn' },
        ],
      },
    ]);

    const runtime = await bootstrap({ provider, systemPrompt: 'sys' });
    const seed = await runtime.store.append({
      threadId: runtime.rootThreadId,
      kind: 'user_turn_start',
      payload: { text: 'wait on user with timeout' },
    });
    runtime.bus.publish(seed);

    const result = await new Promise<{ status: string; summary?: string }>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout: turn never completed')), 2_000);
        const sub = runtime.bus.subscribe(
          (ev) => {
            if (ev.kind === 'turn_complete') {
              clearTimeout(t);
              sub.unsubscribe();
              resolve({
                status: ev.payload.status,
                ...(ev.payload.summary !== undefined ? { summary: ev.payload.summary } : {}),
              });
            }
          },
          { threadId: runtime.rootThreadId },
        );
      },
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('gave up');
    const events = await runtime.store.readAll(runtime.rootThreadId);
    const ext = events.find(
      (e) =>
        e.kind === 'external_event' &&
        (e.payload as { source: string }).source === 'wait_timeout',
    );
    expect(ext).toBeDefined();
  });
});
