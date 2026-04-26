import type { EvalTask } from '../index.js';

/**
 * Smoke-grade task: agent must echo a marker phrase. Tests the
 * user-turn → reply → turn_complete path with no tool involvement.
 *
 * The marker is intentionally non-trivial (not "hi", not in any system
 * prompt) so a stuck/empty model fails the verify step.
 */
export const echoGreetingTask: EvalTask = {
  id: 'echo-greeting',
  description: 'Reply with the marker phrase exactly once.',
  prompt:
    'Reply with exactly the phrase "harness-echo-ack-9417" and nothing else. Do not call any tool.',
  verify(_ctx, observed) {
    if (observed.toolCalls.length > 0) {
      return { ok: false, reason: `expected no tool calls, got ${observed.toolCalls.length}` };
    }
    if (!observed.replyText.includes('harness-echo-ack-9417')) {
      return { ok: false, reason: `marker phrase missing; got: ${truncate(observed.replyText)}` };
    }
    return { ok: true };
  },
};

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
