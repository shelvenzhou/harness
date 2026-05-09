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
  matcher: z
    .enum(['kind', 'tool_result', 'subtask_complete', 'user_input', 'timer', 'session'])
    .describe(
      'Event matcher to wait for. Invalid/malformed matcher args fall back to waiting for external_event.',
    ),
  /** Used when `matcher === 'kind'`. */
  kind: z.string().optional().describe('Event kind to wait for when matcher is kind.'),
  /** Used when `matcher === 'tool_result'`. */
  toolCallId: z
    .string()
    .optional()
    .describe(
      'Tool call id to wait for when matcher is tool_result. Ordinary local tool_result events do not currently re-arm sampling, so prefer session/subtask/timer waits.',
    ),
  /** Used when `matcher === 'subtask_complete'`. */
  childThreadId: z
    .string()
    .optional()
    .describe('Child thread id to wait for when matcher is subtask_complete.'),
  /** Used when `matcher === 'timer'`. */
  timerId: z.string().optional().describe('Timer id to schedule/wait for when matcher is timer.'),
  /**
   * Used when `matcher === 'session'`: ids of long-running tool sessions
   * to wait on. With `mode: 'any'` (default) the wait wakes on the first
   * `session_complete` for any of these ids; with `mode: 'all'` it
   * waits until every id has fired.
   */
  sessionIds: z
    .array(z.string())
    .optional()
    .describe('Session ids to wait for when matcher is session.'),
  /** Multi-session wait gate. Defaults to `'any'` for `matcher === 'session'`. */
  mode: z
    .enum(['any', 'all'])
    .optional()
    .describe('For matcher=session, wait for any session (default) or all sessions.'),
  /**
   * Required when `matcher === 'timer'`: how long to sleep before
   * `timer_fired` is published. The runner schedules the timer when it
   * sees this tool_call.
   */
  delayMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Positive delay in ms required when matcher is timer.'),
  /**
   * Cap on how long to wait for the matching event. When exceeded the
   * runner publishes a synthetic `external_event{source:"wait_timeout"}`
   * that wakes the turn as a permissive fallback. Without this a
   * malformed wait deadlocks the turn until interrupt.
   */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional positive max wait in ms before a synthetic wait_timeout external_event wakes the turn.',
    ),
});

export const waitTool: Tool<typeof WaitArgs, { scheduled: true }> = {
  name: 'wait',
  concurrency: 'safe',
  description: [
    'Yield until a matching event arrives. Immediate tool result is `{scheduled,matcher,timeoutTimerId?}` and the turn suspends unless the requested session gate is already satisfied.',
    'Use `matcher: "user_input"` to explicitly pause for user.',
    'Use `matcher: "subtask_complete"` with `childThreadId` after spawning a child and wanting its result before continuing.',
    'Use `matcher: "timer"` for delayed work — provide `timerId` and positive `delayMs`; missing delay returns `scheduled:false` with an error string.',
    'Use `matcher: "session"` with `sessionIds: [...]` to wait on long-running tools (web_fetch, shell);',
    'set `mode: "all"` to wait for every session, default `"any"` wakes on the first one.',
    '`matcher:"tool_result"` is reserved/legacy for external producers; ordinary local tool results are paired atomically and do not wake a suspended turn.',
    'Set `timeoutMs` on any matcher to bound the wait (otherwise the wait is open-ended).',
  ].join(' '),
  schema: WaitArgs,
  async execute() {
    // Real transition happens in AgentRunner when it sees this tool_call.
    return { ok: true, output: { scheduled: true } };
  },
};
