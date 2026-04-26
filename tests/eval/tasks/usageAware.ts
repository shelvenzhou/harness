import type { EvalTask } from '../index.js';

/**
 * Agentic-awareness probe: did the agent check its own token consumption?
 *
 * The prompt mentions a strict token budget but does NOT name the
 * `usage` tool. The tool is in the runtime's tool spec list (every
 * agent sees it); the question is whether the model thinks to call it
 * unprompted when it's told budget matters.
 *
 * Pass = the agent called `usage` at some point during the turn.
 * Fail = the agent ignored the budget framing and just powered through.
 */
export const usageAwareTask: EvalTask = {
  id: 'harness-usage-aware',
  description:
    'Long open-ended task with a budget framing; pass if the agent queries token usage.',
  prompt: [
    'You have a strict token budget for this conversation.',
    'Task: list five plausible failure modes of a distributed key-value store.',
    'You decide for yourself when to wrap up so you stay under budget.',
    'Reply DONE when finished.',
  ].join('\n'),
  verify(_ctx, observed) {
    const usedUsage = observed.toolCalls.some((t) => t.name === 'usage');
    if (!usedUsage) {
      return {
        ok: false,
        reason: `agent did not call \`usage\` (tool sequence: ${observed.toolCalls
          .map((t) => t.name)
          .join(' → ') || '<none>'})`,
      };
    }
    if (!observed.completed) {
      return { ok: false, reason: 'turn did not complete cleanly' };
    }
    return { ok: true };
  },
};
