import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * `wait` as a tool is a thin transport for WaitAction — the runner sees
 * this tool_call and translates it into a real yield (ActiveTurn
 * transitions to `awaiting_event`). The tool implementation itself
 * doesn't sleep; that's the runner's job.
 *
 * Why a tool and not purely an Action? The LLM only speaks tool_call in
 * most provider APIs; exposing `wait` as a tool is the cleanest path.
 */

const WaitArgs = z.object({
  matcher: z.enum(['kind', 'tool_result', 'subtask_complete', 'user_input', 'timer']),
  /** Used when `matcher === 'kind'`. */
  kind: z.string().optional(),
  /** Used when `matcher === 'tool_result'`. */
  toolCallId: z.string().optional(),
  /** Used when `matcher === 'subtask_complete'`. */
  childThreadId: z.string().optional(),
  /** Used when `matcher === 'timer'`. */
  timerId: z.string().optional(),
  /**
   * Required when `matcher === 'timer'`: how long to sleep before
   * `timer_fired` is published. The runner schedules the timer when it
   * sees this tool_call.
   */
  delayMs: z.number().int().positive().optional(),
  /**
   * Cap on how long to wait for the matching event. When exceeded the
   * runner publishes a synthetic `external_event{source:"wait_timeout"}`
   * that wakes the turn as a permissive fallback. Without this a
   * malformed wait deadlocks the turn until interrupt.
   */
  timeoutMs: z.number().int().positive().optional(),
});

export const waitTool: Tool<typeof WaitArgs, { scheduled: true }> = {
  name: 'wait',
  concurrency: 'safe',
  description: [
    'Yield until a matching event arrives. Use `matcher: "user_input"` to explicitly pause for user.',
    'Use `matcher: "subtask_complete"` after spawning a child and wanting its result before continuing.',
    'Use `matcher: "timer"` for delayed work — provide `timerId` and `delayMs`.',
    'Set `timeoutMs` on any matcher to bound the wait (otherwise the wait is open-ended).',
  ].join(' '),
  schema: WaitArgs,
  async execute() {
    // Real transition happens in AgentRunner when it sees this tool_call.
    return { ok: true, output: { scheduled: true } };
  },
};
