import type { EvalTask } from '../index.js';

/**
 * Agentic-awareness probe: did the agent check its own token consumption?
 *
 * The prompt frames a strict token budget and a multi-step task that is
 * large enough to make budget management non-trivial. The `usage` tool
 * is in the runtime's tool spec list; the question is whether the model
 * thinks to call it when budget matters AND the work is long enough
 * that pacing actually pays off.
 *
 * The earlier version of this task was a five-item one-liner — short
 * enough that a careful model could power through and still stay under
 * budget, which defeated the probe. This longer prompt creates real
 * pressure: 10 incidents × 4 facets ≈ 40 sub-answers. Pair with a tight
 * `tokenBudget` on the runtime when running this probe so the budget
 * actually bites.
 *
 * Pass = the agent called `usage` at some point during the turn.
 * Fail = the agent ignored the budget framing and just powered through.
 */
export const usageAwareTask: EvalTask = {
  id: 'harness-usage-aware',
  description:
    'Long multi-step task with strict-budget framing; pass if the agent queries token usage.',
  prompt: [
    'You have a strict token budget for this conversation. Going over terminates the turn with status=errored, so you must pace yourself.',
    '',
    'Task: analyse the ten distributed-systems incidents listed below. For each incident, write:',
    '  (a) the most likely immediate trigger — 1 sentence',
    '  (b) two distinct cascading effects this trigger commonly produces — 2 short bullets',
    '  (c) one realistic mitigation — 1 sentence',
    '',
    'Be concrete; vague generalities do not count.',
    '',
    'Incidents:',
    '1. A primary database replica stops acknowledging writes for 90 seconds.',
    '2. Cross-region clock skew climbs to 4 seconds during a leap-second event.',
    "3. The L4 load balancer's health-check endpoint returns 200 but the backend is OOM.",
    '4. A retry storm hits a downstream service after a brief upstream outage.',
    '5. Etcd hits a 90% disk-space watermark mid-leader-election.',
    '6. The shared CDN purges hot keys due to a misconfigured TTL.',
    '7. A schema migration adds a NOT NULL column on a 50M-row table during peak hours.',
    '8. A Kafka consumer group rebalances repeatedly because of a network blip.',
    "9. The auth service's JWT signing key rotates while two regions are partitioned.",
    '10. A canary deploy passes liveness checks but silently drops 5% of requests.',
    '',
    'You decide for yourself when to wrap up so you stay under budget. Reply DONE when finished.',
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
