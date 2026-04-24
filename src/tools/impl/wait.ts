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
  timeoutMs: z.number().optional(),
});

export const waitTool: Tool<typeof WaitArgs, { scheduled: true }> = {
  name: 'wait',
  concurrency: 'safe',
  description: [
    'Yield until a matching event arrives. Use `matcher: "user_input"` to explicitly pause for user.',
    'Use `matcher: "subtask_complete"` after spawning a child and wanting its result before continuing.',
    'Use `matcher: "timer"` for delayed work. Default timeout is provider default — set timeoutMs to override.',
  ].join(' '),
  schema: WaitArgs,
  async execute() {
    // Real transition happens in AgentRunner when it sees this tool_call.
    return { ok: true, output: { scheduled: true } };
  },
};
