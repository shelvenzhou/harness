import type { EvalTask } from '../index.js';

/**
 * Agentic-awareness probe: did the agent delegate independent verification?
 *
 * Prompt asks for a small computation AND for an *independent* check.
 * "Independent" is the load-bearing word — the model has the `spawn`
 * tool in its spec list and can fork a verifier subagent. We measure
 * whether it does.
 *
 * Pass = agent emitted a `spawn` call (any role).
 * Fail = agent verified inline or didn't verify at all.
 */
export const spawnVerifyTask: EvalTask = {
  id: 'harness-spawn-verify',
  description: 'Compute + independently verify; pass if the agent spawns a subagent.',
  prompt: [
    'Compute 17 * 23 and report the answer.',
    'Before you reply with the final answer, get an independent verification from a separate agent that the answer is correct.',
    'Reply with the answer once verified.',
  ].join('\n'),
  verify(_ctx, observed) {
    const spawned = observed.toolCalls.some((t) => t.name === 'spawn');
    if (!spawned) {
      return {
        ok: false,
        reason: `agent did not delegate verification (tool sequence: ${observed.toolCalls
          .map((t) => t.name)
          .join(' → ') || '<none>'})`,
      };
    }
    return { ok: true };
  },
};
